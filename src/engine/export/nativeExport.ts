// Renderer-side orchestration for the NATIVE (Electron ffmpeg) export. Renders
// the audio mix to a WAV and hands it to main, starts ffmpeg (native save
// dialog), then spawns the SAME export worker in native mode and relays each
// rendered RGBA frame to ffmpeg with serialized backpressure. Web builds never
// call this (isElectron gate).

import type { NativeEncoder } from '../../../electron/ipc-types'
import { getBlob } from '../../state/persistence'
import { olApi } from '../../platform'
import type { Id, Project } from '../types'
import { planAudioMix } from './audioRender'
import type { ExportAsset, ExportProgress, ExportRequest, ExportResponse, ExportSettings } from './messages'

export interface NativeExportResult {
  outPath: string
  sizeBytes: number
}

const abortError = (): DOMException => new DOMException('Export cancelled', 'AbortError')

function concatFloat32(parts: Float32Array[]): Float32Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Interleaved 32-bit float WAV (bit-exact, no quantisation) — ffmpeg reads it as a 2nd input. */
function buildWavF32(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = channels.length
  const numFrames = channels[0]?.length ?? 0
  const dataBytes = numFrames * numCh * 4
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)
  const wr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  wr(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  wr(8, 'WAVE')
  wr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 3, true) // IEEE float
  dv.setUint16(22, numCh, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * numCh * 4, true)
  dv.setUint16(32, numCh * 4, true)
  dv.setUint16(34, 32, true)
  wr(36, 'data')
  dv.setUint32(40, dataBytes, true)
  let o = 44
  for (let f = 0; f < numFrames; f++) {
    for (let c = 0; c < numCh; c++) {
      dv.setFloat32(o, channels[c][f], true)
      o += 4
    }
  }
  return buf
}

export async function exportNative(
  project: Project,
  settings: ExportSettings,
  opts: { encoder: NativeEncoder; quality: number; suggestedName: string },
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<NativeExportResult | null> {
  const api = olApi
  if (!api) throw new Error('Native export is only available in the desktop app')
  const sequence = project.sequences[project.activeSequenceId]
  if (!sequence || sequence.durationS <= 0) throw new Error('Nothing to export')
  if (settings.endS - settings.startS <= 0) throw new Error('Nothing to export: the range is empty')
  if (signal.aborted) throw abortError()

  const framesTotal = Math.max(1, Math.ceil((settings.endS - settings.startS) * settings.fps))
  onProgress({ phase: 'preparing', framesDone: 0, framesTotal })

  // Gather the media the worker will decode (same set the WebCodecs path uses).
  const usedIds = new Set<Id>()
  for (const track of sequence.tracks) for (const clip of track.clips) if (clip.enabled) usedIds.add(clip.assetId)
  const exportAssets: ExportAsset[] = []
  for (const id of usedIds) {
    const asset = project.assets[id]
    if (!asset) continue
    const blob = await getBlob(asset.blobKey)
    if (!blob) throw new Error(`Media for "${asset.name}" is missing from local storage, re-import it and try again`)
    exportAssets.push({ id, kind: asset.kind, name: asset.name, blob })
  }
  if (signal.aborted) throw abortError()

  // Render the audio mix to a WAV and hand it to main BEFORE ffmpeg spawns (it's
  // an -i input). Reuses the exact planAudioMix rules → same mix as WebCodecs.
  onProgress({ phase: 'audio', framesDone: 0, framesTotal })
  const plan = await planAudioMix(sequence, project.assets, settings.startS, settings.endS)
  let hasAudio = false
  if (plan && plan.info.totalFrames > 0) {
    const perChannel: Float32Array[][] = []
    await plan.render((cd) => {
      cd.forEach((ch, i) => (perChannel[i] ??= []).push(ch))
    })
    const channels = perChannel.map(concatFloat32)
    if (channels.length > 0 && channels[0].length > 0) {
      await api.nativePrepareAudio(buildWavF32(channels, plan.info.sampleRate))
      hasAudio = true
    }
  }
  if (signal.aborted) throw abortError()

  // Start ffmpeg (native save dialog in main).
  const startRes = await api.nativeStart({
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    totalFrames: framesTotal,
    encoder: opts.encoder,
    quality: opts.quality,
    hasAudio,
    suggestedName: opts.suggestedName,
  })
  if (startRes.cancelled) return null
  if (!startRes.started) throw new Error(startRes.error ?? 'could not start ffmpeg')

  // ffmpeg's own frame counter drives the video %; the worker covers prep/audio.
  const unsub = api.onNativeProgress((p) => onProgress({ phase: 'video', framesDone: p.frame, framesTotal }))

  return await new Promise<NativeExportResult | null>((resolve, reject) => {
    const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      unsub()
      worker.terminate()
      fn()
    }
    // Serializes every frame write; see the 'frame' branch below.
    let writeChain: Promise<void> = Promise.resolve()
    const onAbort = (): void => {
      worker.postMessage({ type: 'cancel' } satisfies ExportRequest)
      void api.nativeCancel().finally(() => done(() => reject(abortError())))
    }
    signal.addEventListener('abort', onAbort)

    worker.onmessage = (e: MessageEvent<ExportResponse>) => {
      const msg = e.data
      if (settled) return
      if (msg.type === 'frame') {
        // ffmpeg's stdin is a raw RGBA pipe with no framing, so two writes in
        // flight at once would interleave into garbage. The worker is allowed
        // to render several frames ahead; the ORDER is enforced here, by
        // chaining every write onto the previous one.
        const data = msg.data
        writeChain = writeChain
          .then(async () => {
            if (settled) return
            const res = await api.nativeWriteFrame(data)
            if (settled) return
            if (!res.ok) {
              void api.nativeCancel()
              done(() => reject(new Error(res.error ?? 'frame write failed')))
            } else {
              worker.postMessage({ type: 'frameAck' } satisfies ExportRequest)
            }
          })
          // A rejected write would leave the chain permanently rejected: every
          // later frame would skip its ack, the worker would park on a credit
          // that never returns, and the export promise would never settle.
          .catch((err: unknown) => {
            if (settled) return
            void api.nativeCancel()
            done(() => reject(err instanceof Error ? err : new Error(String(err))))
          })
      } else if (msg.type === 'progress') {
        // ffmpeg's native:progress owns the video phase; forward prep/audio only.
        if (msg.progress.phase !== 'video') onProgress(msg.progress)
      } else if (msg.type === 'done') {
        onProgress({ phase: 'finalizing', framesDone: framesTotal, framesTotal })
        // Drain the write queue before closing ffmpeg's stdin.
        void writeChain.then(() => api.nativeFinish()).then((fin) => {
          if (fin.ok) done(() => resolve({ outPath: fin.outPath ?? '', sizeBytes: fin.sizeBytes ?? 0 }))
          else done(() => reject(new Error(fin.error ?? 'ffmpeg failed')))
        })
      } else if (msg.type === 'cancelled') {
        void api.nativeCancel()
        done(() => reject(abortError()))
      } else if (msg.type === 'error') {
        void api.nativeCancel()
        done(() => reject(new Error(msg.message)))
      }
    }
    worker.onerror = (e) => {
      void api.nativeCancel()
      done(() => reject(new Error(`Export worker crashed: ${e.message || 'unknown error'}`)))
    }

    worker.postMessage({
      type: 'init',
      settings,
      sequence,
      assets: exportAssets,
      audio: null,
      native: true,
    } satisfies ExportRequest)
  })
}
