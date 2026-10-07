// Renderer-side orchestration for the NATIVE (Electron ffmpeg) export. Asks
// where to save (native save dialog), renders the audio mix to a WAV and hands
// it to main, starts ffmpeg, then spawns the SAME export worker in native mode
// and relays each rendered RGBA frame to ffmpeg with serialized backpressure.
// Web builds never call this (isElectron gate).

import type { NativeEncoder, NativeStartResult } from '../../../electron/ipc-types'
import { blobForExport } from '../../state/mediaMirror'
import { useToasts } from '../../state/toasts'
import { olApi } from '../../platform'
import type { Id, Project } from '../types'
import { planAudioMix } from './audioRender'
import type { ExportAsset, ExportProgress, ExportRequest, ExportResponse, ExportSettings } from './messages'

export interface NativeExportResult {
  outPath: string
  sizeBytes: number
}

const abortError = (): DOMException => new DOMException('Export cancelled', 'AbortError')

/**
 * One segment of the mix as a WAV's sample data: interleaved 32-bit float,
 * little-endian (bit-exact, no quantisation). Main writes the header around it
 * (electron/nativeExport.ts wavHeaderF32) and ffmpeg reads it as a 2nd input.
 */
export function interleaveF32(channels: Float32Array[]): ArrayBuffer {
  const numCh = channels.length
  const numFrames = channels[0]?.length ?? 0
  const buf = new ArrayBuffer(numFrames * numCh * 4)
  const dv = new DataView(buf)
  let o = 0
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
  opts: {
    encoder: NativeEncoder
    quality: number
    suggestedName: string
    /** Where to write, when the job already knows (a restart, Try again): no dialog then. */
    outPath?: string
    /** Told where he chose, so a restart or Try again can write there without asking again. */
    onOutPath?: (path: string) => void
  },
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
    // The database copy, or the spare one on disk while a repair is still putting
    // it back: never "missing" for a file that is sitting on his disk.
    const blob = await blobForExport({ id: asset.id, blobKey: asset.blobKey, name: asset.name })
    if (!blob) throw new Error(`"${asset.name}" is not on this computer. Find my media in the Media panel puts it back`)
    exportAssets.push({ id, kind: asset.kind, name: asset.name, blob, fps: asset.fps })
  }
  if (signal.aborted) throw abortError()

  // ⛔ WHERE IT GOES IS ASKED BEFORE THE SOUND IS MADE. The save dialog used to
  // come up inside nativeStart, after the whole mix had been rendered (twice
  // with Platform loudness on): dismissing it threw all that away, and the
  // loudness switch, which runs the export again, asked a second time for a
  // file he had already named (export audit, 2026-10-06). A path the job
  // already holds (a restart, Try again) is used as it is.
  const outPath = opts.outPath ?? (await api.nativePickOutput(opts.encoder, opts.suggestedName))
  // Dismissed: nothing was made, so there is nothing to tidy.
  if (!outPath) return null
  opts.onOutPath?.(outPath)
  if (signal.aborted) throw abortError()

  // Render the audio mix to a WAV and hand it to main BEFORE ffmpeg spawns (it's
  // an -i input). Reuses the exact planAudioMix rules → same mix as WebCodecs.
  onProgress({ phase: 'audio', framesDone: 0, framesTotal })
  const plan = await planAudioMix(
    sequence,
    project.assets,
    settings.startS,
    settings.endS,
    (names) =>
      // Some clips gave no sound. The rest of the mix is honest audio, so the
      // export continues, but he has to hear about the gap NOW rather than after
      // he has uploaded it.
      useToasts
        .getState()
        .show(
          `No sound from ${names.length === 1 ? names[0] : `${names.length} clips`}. The rest of the audio exported.`,
          'danger',
        ),
    // The export's own rate, which may be below the timeline's (exportFps).
    { loudnessTargetLufs: settings.loudnessTargetLufs ?? null, fps: settings.fps },
  )
  // ⛔ THE MIX IS A FILE ON HIS DISK FROM ITS FIRST SEGMENT ON, so every way out
  // of here until ffmpeg owns it has to take it with it.
  //
  // Rendering the audio for a long timeline is not quick, and pressing Cancel
  // during it threw straight past this point. Nothing else knows that file
  // exists: the tidy-up lives on the export job, and there is no job yet,
  // because ffmpeg has not been asked to start. So a cancelled export left the
  // whole uncompressed mix sitting in his temp folder, minutes of stereo float
  // at about ten megabytes a second, and cancelling twice left two. Windows
  // clears that folder when it feels like it, which on his machine is never.
  //
  // Cancelling with nothing running is exactly what deletes it (a mix half
  // written too), so the cleanup is the same call the running case makes.
  let hasAudio = false
  const dropPreparedAudio = async (): Promise<void> => {
    if (hasAudio) await api.nativeCancel().catch(() => undefined)
  }
  if (plan && plan.info.totalFrames > 0) {
    try {
      // One segment per message, straight on to main: nothing here ever holds
      // the whole mix (electron/nativeExport.ts beginAudio says why).
      await plan.render(async (cd) => {
        // ⛔ A CANCEL STOPS THE MIX AT THE NEXT SEGMENT (30 s of sound), not after
        // the last one. Nothing here listened before, so Cancel during the sound
        // of a long video did nothing until all of it had been rendered.
        if (signal.aborted) throw abortError()
        if (cd.length === 0 || (cd[0]?.length ?? 0) === 0) return
        if (!hasAudio) {
          hasAudio = true
          await api.nativeAudioBegin(plan.info.sampleRate, cd.length)
        }
        await api.nativeAudioChunk(interleaveF32(cd))
      })
      if (hasAudio) await api.nativeAudioFinish()
    } catch (err) {
      await dropPreparedAudio()
      throw err
    }
  }
  if (signal.aborted) {
    await dropPreparedAudio()
    throw abortError()
  }

  // Start ffmpeg, writing where he said above.
  let startRes: NativeStartResult
  try {
    startRes = await api.nativeStart({
      outPath,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      totalFrames: framesTotal,
      encoder: opts.encoder,
      quality: opts.quality,
      // The plan's keyframe interval, the same number the WebCodecs path strides
      // by, so both pipelines put keyframes in the same places.
      keyframeIntervalS: settings.keyframeIntervalS,
      hasAudio,
      suggestedName: opts.suggestedName,
    })
  } catch (err) {
    await dropPreparedAudio()
    throw err
  }
  if (!startRes.started) {
    await dropPreparedAudio()
    throw new Error(startRes.error ?? 'could not start ffmpeg')
  }
  // ⛔ A STOP WHILE FFMPEG WAS STARTING. The abort listener below goes on only
  // now, and a signal that already fired never calls it, so a cancel in that gap
  // used to render and encode the whole video anyway. ffmpeg is running and
  // holds the file, so it is stopped the way a running one is.
  if (signal.aborted) {
    await api.nativeCancel().catch(() => undefined)
    throw abortError()
  }

  // ffmpeg's own frame counter drives the video %; the worker covers prep/audio.
  //
  // ⛔ THE PERCENT NEVER GOES BACK. When the last frame goes in, x264 still holds
  // a lookahead's worth: measured on his gym frames, ffmpeg had encoded 105 of
  // 240 at that moment and reported twelve more counts over 6.4 s. Each used to
  // set the phase back to the video at 49 to 97 percent, right after the dialog
  // had said "100%". So once the worker is done, ffmpeg's count is the finishing
  // step, and only the highest count yet is ever shown.
  let encoded = 0
  let workerDone = false
  const unsub = api.onNativeProgress((p) => {
    encoded = Math.max(encoded, Math.min(p.frame, framesTotal))
    onProgress({ phase: workerDone ? 'finalizing' : 'video', framesDone: encoded, framesTotal })
  })

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
            if (settled || signal.aborted) return
            const res = await api.nativeWriteFrame(data)
            // A write that fails BECAUSE the user cancelled must not latch an
            // error over the abort, or the dialog would sit on a red
            // "ffmpeg is not running" instead of just closing.
            if (settled || signal.aborted) return
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
            if (settled || signal.aborted) return
            void api.nativeCancel()
            done(() => reject(err instanceof Error ? err : new Error(String(err))))
          })
      } else if (msg.type === 'progress') {
        // ffmpeg's native:progress owns the video phase; forward prep/audio only.
        if (msg.progress.phase !== 'video') onProgress(msg.progress)
      } else if (msg.type === 'done') {
        workerDone = true
        onProgress({ phase: 'finalizing', framesDone: encoded, framesTotal })
        // Drain the write queue before closing ffmpeg's stdin. ⛔ Only if it
        // drained cleanly: a write that failed in the queue has already stopped
        // ffmpeg and ended the export, and a finish after it raced the stop.
        // And a finish that rejects ends the export with its reason; nothing
        // caught it before, and the dialog sat on "Finishing the file" for good.
        void writeChain
          .then(() => (settled ? null : api.nativeFinish()))
          .then((fin) => {
            if (!fin) return
            if (fin.ok) done(() => resolve({ outPath: fin.outPath ?? '', sizeBytes: fin.sizeBytes ?? 0 }))
            else done(() => reject(new Error(fin.error ?? 'ffmpeg failed')))
          })
          .catch((err: unknown) => {
            if (settled) return
            void api.nativeCancel()
            done(() => reject(err instanceof Error ? err : new Error(String(err))))
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
