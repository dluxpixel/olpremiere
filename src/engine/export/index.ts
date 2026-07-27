// Public export API (spec §5). The main thread renders the audio mix and
// orchestrates the worker; all decode/composite/encode/mux work happens in
// exportWorker.ts so the UI stays responsive.

import { getBlob } from '../../state/persistence'
import type { Id, MediaAsset, Project } from '../types'
import { planAudioMix } from './audioRender'
import type { ExportAsset, ExportProgress, ExportRequest, ExportResponse, ExportSettings } from './messages'

export type { ExportProgress, ExportSettings } from './messages'

const abortError = (): DOMException => new DOMException('Export cancelled', 'AbortError')

/**
 * How long after a cancel request the worker gets before hard termination. The
 * worker aborts its writable before acking, so this must outlast a disk abort.
 */
const CANCEL_GRACE_MS = 500

/**
 * Can this browser stream an export straight to disk? Firefox has no
 * showSaveFilePicker, so it buffers the file and downloads it instead. Probed,
 * never sniffed from the user agent.
 *
 * A `typeof` check rather than `'x' in globalThis`: the picker lives on
 * Window.prototype, so tests that shadow it with `undefined` (to exercise the
 * download fallback) would still satisfy `in`.
 */
export const canStreamToDisk = (): boolean => typeof globalThis.showSaveFilePicker === 'function'

/**
 * Ask the user where to write. Returns null when they cancel the picker, which
 * is a normal outcome and not an error.
 */
export async function pickExportDestination(suggestedName: string): Promise<FileSystemFileHandle | null> {
  if (!canStreamToDisk()) return null
  try {
    return await globalThis.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'MPEG-4 video', accept: { 'video/mp4': ['.mp4'] } }],
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

/**
 * Render and encode the active sequence.
 *
 * With a `fileHandle`, chunks stream to disk as they are muxed and the returned
 * Blob is null: there is nothing left in memory to hand back. Without one, the
 * whole file is buffered and returned for a download fallback.
 */
export async function exportSequence(
  project: Project,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
  fileHandle?: FileSystemFileHandle,
): Promise<Blob | null> {
  if (signal.aborted) throw abortError()
  const sequence = project.sequences[project.activeSequenceId]
  if (!sequence || sequence.durationS <= 0) throw new Error('Nothing to export')
  if (settings.endS - settings.startS <= 0) throw new Error('Nothing to export: the range is empty')

  const framesTotal = Math.max(1, Math.ceil((settings.endS - settings.startS) * settings.fps))
  onProgress({ phase: 'preparing', framesDone: 0, framesTotal })

  const usedIds = new Set<Id>()
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.enabled) usedIds.add(clip.assetId)
    }
  }
  const exportAssets: ExportAsset[] = []
  for (const id of usedIds) {
    const asset: MediaAsset | undefined = project.assets[id]
    if (!asset) continue
    const blob = await getBlob(asset.blobKey)
    if (!blob) throw new Error(`Media for "${asset.name}" is missing from local storage, re-import it and try again`)
    exportAssets.push({ id, kind: asset.kind, name: asset.name, blob })
  }
  if (signal.aborted) throw abortError()

  onProgress({ phase: 'audio', framesDone: 0, framesTotal })
  // Two-phase: the plan resolves whether audio exists (and its shape) up
  // front; the PCM itself renders in bounded segments AFTER the worker starts,
  // streamed as `audioSegment` messages, so a long export never holds its whole
  // mix in memory on either side.
  const audioPlan = await planAudioMix(sequence, project.assets, settings.startS, settings.endS)
  if (signal.aborted) throw abortError()

  return await new Promise<Blob | null>((resolve, reject) => {
    const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    // Backpressure: at most this many rendered segments may be un-ACKed at
    // once, so the worker's queue (and peak audio memory) stays at ~2 segments
    // no matter how much faster the offline render runs than the encode.
    const AUDIO_CREDIT_WINDOW = 2
    let audioInFlight = 0
    let audioCreditWaiter: (() => void) | null = null
    const wakeAudioCredit = (): void => {
      audioCreditWaiter?.()
      audioCreditWaiter = null
    }

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
      // A render parked on credit must wake to observe `settled` and bail.
      wakeAudioCredit()
      settle()
    }

    const onAbort = (): void => {
      worker.postMessage({ type: 'cancel' } satisfies ExportRequest)
      // The worker acks with 'cancelled'; terminate regardless if it doesn't.
      graceTimer = setTimeout(() => finish(() => reject(abortError())), CANCEL_GRACE_MS)
    }
    signal.addEventListener('abort', onAbort)

    worker.onmessage = (e: MessageEvent<ExportResponse>) => {
      const msg = e.data
      if (msg.type === 'progress') {
        if (!settled) onProgress(msg.progress)
      } else if (msg.type === 'segmentDone') {
        audioInFlight = Math.max(0, audioInFlight - 1)
        wakeAudioCredit()
      } else if (msg.type === 'done') {
        finish(() => resolve(msg.buffer ? new Blob([msg.buffer], { type: 'video/mp4' }) : null))
      } else if (msg.type === 'cancelled') {
        finish(() => reject(abortError()))
      } else if (msg.type === 'error') {
        finish(() => reject(new Error(msg.message)))
      }
      // 'frame' is native-mode only and never reaches this WebCodecs orchestrator.
    }
    worker.onerror = (e) => finish(() => reject(new Error(`Export worker crashed: ${e.message || 'unknown error'}`)))
    worker.onmessageerror = () => finish(() => reject(new Error('Export worker message could not be decoded')))

    const initMsg: ExportRequest = {
      type: 'init',
      settings,
      sequence,
      assets: exportAssets,
      audio: audioPlan ? audioPlan.info : null,
      fileHandle,
    }
    worker.postMessage(initMsg)

    // Stream the mix segments behind the init. Each segment's buffers are
    // TRANSFERRED, and the producer holds a small credit window against the
    // worker's segmentDone ACKs. A render failure fails the export like any
    // worker error; a settle (cancel/done) stops the loop at the next boundary.
    if (audioPlan) {
      void audioPlan
        .render(async (channelData) => {
          while (audioInFlight >= AUDIO_CREDIT_WINDOW && !settled && !signal.aborted) {
            await new Promise<void>((r) => {
              audioCreditWaiter = r
            })
          }
          if (settled || signal.aborted) throw abortError()
          audioInFlight++
          worker.postMessage(
            { type: 'audioSegment', channelData } satisfies ExportRequest,
            channelData.map((c) => c.buffer),
          )
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          finish(() => reject(err instanceof Error ? err : new Error(String(err))))
        })
    }
  })
}
