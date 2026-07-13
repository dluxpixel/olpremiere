/// <reference lib="webworker" />
// Export renderer (spec §5): demux/decode source video with mediabunny,
// composite every output frame with the SHARED WebGL2 renderer (identical to
// the live preview) on an OffscreenCanvas, encode with WebCodecs, and mux with
// mediabunny's Output. mediabunny handles B-frame reordering natively (packets
// added in decode order with presentation timestamps), which deletes the class
// of GPU-encoder crashes mp4-muxer had ("timestamps must be monotonically
// increasing"). Everything heavy happens in this module worker; the main
// thread only relays progress.

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from 'mediabunny'
import type { StreamTargetChunk, WrappedCanvas } from 'mediabunny'
import { createRenderer } from '../render/glRenderer'
import { resolveFrame } from '../render/resolve'
import { rasterizeTitle } from '../render/titleRaster'
import { loadTitleFonts } from '../render/titleFonts'
import type { RenderLayer } from '../render/types'
import type { Clip, Id } from '../types'
import {
  AUDIO_CHUNK_FRAMES,
  H264_CODECS,
  firstSupported,
  packPlanarChunk,
  pcmChunks,
  type ExportRequest,
  type ExportResponse,
} from './messages'

const scope = self as unknown as DedicatedWorkerGlobalScope

const post = (msg: ExportResponse, transfer: Transferable[] = []): void => scope.postMessage(msg, transfer)

class CancelledError extends Error {}

let cancelled = false
let started = false

// SAFETY NET: nothing may ever surface as the opaque "worker crashed: unknown
// error" again. Any exception that escapes run()'s try/catch (an encoder
// output callback throwing, a stray rejected promise) posts a real message;
// the main thread ignores messages after it settles, so this can't double-fire.
scope.addEventListener('error', (e) => {
  post({ type: 'error', message: `Export failed (worker): ${e.message || String(e.error ?? 'unknown')}` })
})
scope.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason
  post({ type: 'error', message: `Export failed (worker): ${r instanceof Error ? r.message : String(r)}` })
})

scope.onmessage = (e: MessageEvent<ExportRequest>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    cancelled = true
  } else if (!started) {
    started = true
    void run(msg)
  }
}

const checkCancel = (): void => {
  if (cancelled) throw new CancelledError('cancelled')
}

const MAX_ENCODE_QUEUE = 4

// 'dequeue' can fire between reading encodeQueueSize and adding the listener,
// so a short timeout race keeps the drain loop from hanging on that edge.
const nextDequeue = (enc: VideoEncoder | AudioEncoder): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      enc.removeEventListener('dequeue', done)
      resolve()
    }
    const timer = setTimeout(done, 50)
    enc.addEventListener('dequeue', done, { once: true })
  })

// A per-clip monotonic frame reader. Random-access getCanvas() returns null on
// VFR / cue-less MediaRecorder webm inside a worker, so export pulls frames
// SEQUENTIALLY (canvases()) and holds the newest frame with timestamp ≤ the
// requested source time — classic pull-down. One Input per CLIP, so two clips
// of the same asset (e.g. across a cross-dissolve) read independently.
interface ClipProvider {
  /** Kept so the iterator can be re-opened for a backward (reverse-clip) seek. */
  sink: CanvasSink
  iterator: AsyncGenerator<WrappedCanvas, void, unknown>
  dispose: () => void
  started: boolean
  current: WrappedCanvas | null
  ahead: WrappedCanvas | null
}

const SRC_EPS_S = 1e-4

async function nextFrame(p: ClipProvider): Promise<WrappedCanvas | null> {
  const r = await p.iterator.next()
  return r.done ? null : r.value
}

/** Advance the clip's sequential reader to the newest frame with ts ≤ sourceT. */
async function frameForClip(p: ClipProvider, sourceT: number): Promise<OffscreenCanvas | HTMLCanvasElement | null> {
  // A REVERSE clip (speed < 0) requests DECREASING sourceT. The reader is
  // forward-only, so a backward jump means re-opening the sink iterator from the
  // new time (a random-access re-seek). Without this the whole reversed clip
  // would freeze on its furthest-decoded frame — the preview reverses correctly
  // (random-access frame cache) but the export would not.
  if (p.current && sourceT + SRC_EPS_S < p.current.timestamp) {
    void p.iterator.return?.(undefined)
    p.iterator = p.sink.canvases(Math.max(0, sourceT))
    p.started = false
    p.current = null
    p.ahead = null
  }
  if (!p.started) {
    p.started = true
    p.ahead = await nextFrame(p)
  }
  while (p.ahead && p.ahead.timestamp <= sourceT + SRC_EPS_S) {
    p.current = p.ahead
    p.ahead = await nextFrame(p)
  }
  // Before the first packet clamp to it; past the last, freeze on it.
  const w = p.current ?? p.ahead
  return w ? w.canvas : null
}

async function run(init: Extract<ExportRequest, { type: 'init' }>): Promise<void> {
  const cleanups: (() => void)[] = []
  let stage = 'preparing'
  // Held outside the try so the finally block can abort a half-written file.
  // Set to null once closed, so a successful finalize is never aborted.
  let writable: FileSystemWritableFileStream | null = null
  // The terminal message is posted only AFTER teardown: the main thread calls
  // worker.terminate() the moment it sees 'cancelled' or 'done', which would
  // otherwise kill us mid-abort() and leave the half-written movie on disk.
  let outcome: { msg: ExportResponse; transfer: Transferable[] } | null = null
  try {
    const { settings, sequence, assets, audio, fileHandle } = init
    const framesTotal = Math.max(1, Math.ceil((settings.endS - settings.startS) * settings.fps))
    // HD+ gets the quality-tuned encode + BT.709 tag (the YouTube path); SD stays
    // byte-stable so the golden / preview==export tests are unaffected.
    const isHd = settings.height >= 720 || settings.width >= 1280
    post({ type: 'progress', progress: { phase: 'preparing', framesDone: 0, framesTotal } })

    // Register bundled title fonts in THIS worker's FontFaceSet before any title
    // is rasterized — otherwise a Minecraft title would fall back to a different
    // face here than in the preview, breaking preview == export.
    await loadTitleFonts(scope.fonts)

    // --- codec picks -------------------------------------------------------
    stage = 'probing encoder support'
    // B-frames reorder encoder output so decode timestamps go backward, and
    // mp4-muxer's unsigned composition table can't mux that — it crashes with
    // "Timestamps must be monotonically increasing". 'realtime' asks the encoder
    // to skip B-frames; hardware encoders can ignore that hint, so the software
    // path prefers Chrome's openh264 (no B-frames at all). WebCodecs has no
    // 'require-software', so 'prefer-software' is the strongest software request.
    const videoConfigFor = (codec: string, accel: HardwarePreference): VideoEncoderConfig => ({
      codec,
      width: settings.width,
      height: settings.height,
      bitrate: settings.videoBitrate,
      framerate: settings.fps,
      // Software (openh264, no B-frames) uses 'quality' rate control for a
      // cleaner offline file, but only at HD+ (SD stays byte-stable for tests).
      // Hardware keeps 'realtime', which also suppresses the B-frames that would
      // crash the muxer (the Auto fallback relies on it).
      latencyMode: accel === 'prefer-software' && isHd ? 'quality' : 'realtime',
      hardwareAcceleration: accel,
    })
    const accelOrder: HardwarePreference[] =
      settings.hardwareAcceleration === 'prefer-hardware'
        ? ['prefer-hardware', 'no-preference']
        : ['prefer-software', 'no-preference']
    let picked: { codec: string; accel: HardwarePreference } | null = null
    for (const accel of accelOrder) {
      const codec = await firstSupported([...H264_CODECS], async (c) => {
        const support = await VideoEncoder.isConfigSupported(videoConfigFor(c, accel))
        return support.supported === true
      })
      if (codec) {
        picked = { codec, accel }
        break
      }
    }
    if (!picked) {
      throw new Error(
        `no H.264 (avc1) encoder available for ${settings.width}x${settings.height}@${settings.fps} — try a smaller frame size`,
      )
    }
    const videoCodec = picked.codec
    const videoAccel = picked.accel

    let audioCodec: 'aac' | 'opus' | null = null
    let audioConfig: AudioEncoderConfig | null = null
    if (audio) {
      const base = {
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.numberOfChannels,
        bitrate: 192_000,
      }
      const aac = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', ...base })
      if (aac.supported) {
        audioCodec = 'aac'
        audioConfig = { codec: 'mp4a.40.2', ...base }
      } else {
        const opus = await AudioEncoder.isConfigSupported({ codec: 'opus', ...base })
        if (opus.supported) {
          audioCodec = 'opus'
          audioConfig = { codec: 'opus', ...base }
        }
        // Neither AAC nor Opus: ship a video-only file instead of failing.
      }
    }

    // --- output (muxer) + encoders ------------------------------------------
    // Streaming to disk and front-loading the moov box are mutually exclusive:
    // fastStart 'in-memory' buffers the ENTIRE file to move the index to the
    // front, which is precisely what streaming exists to avoid. So a streamed
    // export writes moov at the end. It plays everywhere locally; it is only
    // worse for progressive HTTP playback, which a local editor never does.
    // The buffered fallback keeps fastStart, since it has already paid the RAM.
    if (fileHandle) writable = await fileHandle.createWritable()
    const fsWritable = writable
    const bufferTarget = fsWritable ? null : new BufferTarget()
    // A FileSystemWritableFileStream accepts positioned writes directly, which
    // is exactly the shape mediabunny's StreamTarget chunks carry.
    const target = fsWritable
      ? new StreamTarget(
          new WritableStream<StreamTargetChunk>({
            write: (c) => fsWritable.write({ type: 'write', position: c.position, data: c.data }),
          }),
        )
      : bufferTarget!

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: fsWritable ? false : 'in-memory' }),
      target,
    })
    // Packets are added in DECODE order with PRESENTATION timestamps; mediabunny
    // derives DTS/ctts itself, so a hardware encoder that emits B-frames muxes
    // fine (the old muxer threw "timestamps must be monotonically increasing").
    const videoSource = new EncodedVideoPacketSource('avc')
    output.addVideoTrack(videoSource, { frameRate: settings.fps })
    const audioSource = audio && audioCodec ? new EncodedAudioPacketSource(audioCodec) : null
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()
    cleanups.push(() => {
      // Release muxer resources when we never reached finalize (error/cancel).
      if (output.state === 'pending' || output.state === 'started') void output.cancel().catch(() => undefined)
    })

    let encoderError: Error | null = null
    const throwIfFailed = (): void => {
      if (encoderError) throw encoderError
    }
    const fail = (err: unknown): void => {
      encoderError ??= err instanceof Error ? err : new Error(String(err))
    }
    const drain = async (enc: VideoEncoder | AudioEncoder): Promise<void> => {
      while (enc.encodeQueueSize > MAX_ENCODE_QUEUE) {
        checkCancel()
        throwIfFailed()
        await nextDequeue(enc)
      }
    }

    // WebCodecs output callbacks are synchronous, but mediabunny's add() is
    // async (writer backpressure). Chain the adds per track so packets keep
    // their decode order, and CAPTURE failures into encoderError — a throw that
    // escaped the callback surfaced as the opaque "worker crashed" error.
    let videoMux: Promise<void> = Promise.resolve()
    let audioMux: Promise<void> = Promise.resolve()
    const packetOf = (chunk: EncodedVideoChunk | EncodedAudioChunk, tsUs: number, fallbackDurUs: number): EncodedPacket => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      return new EncodedPacket(data, chunk.type, tsUs / 1e6, (chunk.duration ?? fallbackDurUs) / 1e6)
    }

    // Tag HD+ output as BT.709 (the MP4 `colr` box, written from this decoder
    // config) so players and YouTube interpret the colours correctly instead
    // of guessing — the usual cause of "washed out after upload". SD stays
    // untagged: encoders work in BT.601 there, and leaving it alone keeps the
    // golden export byte-stable.
    const videoFrameDurUs = 1e6 / settings.fps
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          if (isHd && meta?.decoderConfig) {
            meta.decoderConfig.colorSpace = {
              primaries: 'bt709',
              transfer: 'bt709',
              matrix: 'bt709',
              fullRange: false,
            }
          }
          const packet = packetOf(chunk, chunk.timestamp, videoFrameDurUs)
          videoMux = videoMux.then(() => videoSource.add(packet, meta)).catch(fail)
        } catch (err) {
          fail(err)
        }
      },
      error: (e) => {
        encoderError ??= new Error(`video encoding failed: ${e.message}`)
      },
    })
    videoEncoder.configure(videoConfigFor(videoCodec, videoAccel))
    cleanups.push(() => {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    })

    // --- audio encode ------------------------------------------------------
    if (audio && audioConfig) {
      stage = 'encoding audio'
      post({ type: 'progress', progress: { phase: 'audio', framesDone: 0, framesTotal } })
      // Normalize the track so its first chunk lands at t=0: AAC encoder
      // priming can stamp the first chunk slightly after zero, which used to
      // crash the old muxer's strict mode (fixed then via 'offset' — kept here).
      let audioBaseUs: number | null = null
      const audioChunkDurUs = (AUDIO_CHUNK_FRAMES / audio.sampleRate) * 1e6
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            audioBaseUs ??= chunk.timestamp
            const packet = packetOf(chunk, chunk.timestamp - audioBaseUs, audioChunkDurUs)
            audioMux = audioMux.then(() => audioSource!.add(packet, meta)).catch(fail)
          } catch (err) {
            fail(err)
          }
        },
        error: (e) => {
          encoderError ??= new Error(`audio encoding failed: ${e.message}`)
        },
      })
      audioEncoder.configure(audioConfig)
      cleanups.push(() => {
        if (audioEncoder.state !== 'closed') audioEncoder.close()
      })

      const totalFrames = audio.channelData[0]?.length ?? 0
      for (const chunk of pcmChunks(totalFrames, AUDIO_CHUNK_FRAMES, audio.sampleRate)) {
        checkCancel()
        throwIfFailed()
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: audio.sampleRate,
          numberOfFrames: chunk.frames,
          numberOfChannels: audio.numberOfChannels,
          timestamp: chunk.timestampUs,
          data: packPlanarChunk(audio.channelData, chunk.offset, chunk.frames),
        })
        audioEncoder.encode(data)
        data.close()
        await drain(audioEncoder)
      }
      await audioEncoder.flush()
      await audioMux // every queued packet handed to the muxer (or failed)
      throwIfFailed()
    }

    // --- open media --------------------------------------------------------
    // Images decode once (shared by assetId). Video gets ONE sequential reader
    // per CLIP (created lazily on first use), so overlapping same-asset clips
    // in a transition each read independently.
    stage = 'opening media'
    const kindById = new Map<Id, 'video' | 'audio' | 'image'>()
    const blobById = new Map<Id, Blob>()
    const nameById = new Map<Id, string>()
    const bitmaps = new Map<Id, ImageBitmap>()
    for (const asset of assets) {
      checkCancel()
      kindById.set(asset.id, asset.kind)
      blobById.set(asset.id, asset.blob)
      nameById.set(asset.id, asset.name)
      if (asset.kind === 'image') {
        try {
          const bitmap = await createImageBitmap(asset.blob)
          bitmaps.set(asset.id, bitmap)
          cleanups.push(() => bitmap.close())
        } catch {
          throw new Error(`could not decode image "${asset.name}"`)
        }
      }
    }

    const clipProviders = new Map<Id, ClipProvider>()
    const providerFor = async (clip: Clip): Promise<ClipProvider | null> => {
      const existing = clipProviders.get(clip.id)
      if (existing) return existing
      const blob = blobById.get(clip.assetId)
      if (!blob) return null
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      let track
      try {
        track = await input.getPrimaryVideoTrack()
      } catch (err) {
        input.dispose()
        throw new Error(
          `could not read video "${nameById.get(clip.assetId) ?? clip.assetId}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!track) {
        input.dispose()
        return null
      }
      const sink = new CanvasSink(track)
      // Decode forward from just before the clip's in-point; a transition reads
      // past the out-point (handles), so leave the end open (to media end). For a
      // reverse clip frameForClip re-opens sink.canvases() at each backward step.
      const iterator = sink.canvases(Math.max(0, clip.inS))
      const provider: ClipProvider = {
        sink,
        iterator,
        dispose: () => input.dispose(),
        started: false,
        current: null,
        ahead: null,
      }
      clipProviders.set(clip.id, provider)
      cleanups.push(() => {
        // provider.iterator, not the captured `iterator` — a reverse re-seek may
        // have replaced it.
        void provider.iterator.return?.(undefined)
        input.dispose()
      })
      return provider
    }

    // Index enabled video clips by id so a layer's clipId resolves to its Clip.
    const clipById = new Map<Id, Clip>()
    for (const track of sequence.tracks) {
      if (track.kind !== 'video') continue
      for (const clip of track.clips) clipById.set(clip.id, clip)
    }

    // --- shared WebGL2 renderer on an OffscreenCanvas -----------------------
    stage = 'initializing renderer'
    const canvas = new OffscreenCanvas(settings.width, settings.height)
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('WebGL2 is unavailable in this browser’s worker — cannot export')
    const renderer = createRenderer(gl)
    cleanups.push(() => renderer.dispose())

    /** Decode every layer's texture for one frame (async), keyed by layer ref. */
    const gatherTextures = async (layers: RenderLayer[]): Promise<Map<RenderLayer, TexImageSource>> => {
      const map = new Map<RenderLayer, TexImageSource>()
      for (const layer of layers) {
        if (layer.title) {
          // Titles rasterize at sequence resolution (resolveFrame uses seq dims).
          map.set(layer, rasterizeTitle(layer.title, sequence.width, sequence.height))
          continue
        }
        const kind = kindById.get(layer.assetId)
        if (kind === 'image') {
          const bmp = bitmaps.get(layer.assetId)
          if (bmp) map.set(layer, bmp)
        } else if (kind === 'video') {
          const clip = clipById.get(layer.clipId)
          if (!clip) continue
          const provider = await providerFor(clip)
          if (!provider) continue
          const canvas = await frameForClip(provider, Math.max(0, layer.sourceTimeS))
          if (canvas) map.set(layer, canvas)
        }
      }
      return map
    }

    // --- render + encode video ---------------------------------------------
    stage = 'rendering video'
    const keyEvery = Math.max(1, Math.round(settings.fps * 2))
    for (let f = 0; f < framesTotal; f++) {
      checkCancel()
      throwIfFailed()
      // Sample the sequence from the work-area start, but stamp the output from
      // zero: a work-area export begins at its in point, not after startS of black.
      const t = settings.startS + f / settings.fps
      const frame = resolveFrame(sequence, t)

      const layers: RenderLayer[] = []
      for (const op of frame.ops) {
        if (op.type === 'layer') layers.push(op.layer)
        else layers.push(op.from, op.to)
      }
      const texMap = await gatherTextures(layers)
      renderer.render(frame, (layer) => texMap.get(layer) ?? null)

      const vframe = new VideoFrame(canvas, {
        timestamp: Math.round((f * 1e6) / settings.fps),
        duration: Math.round(1e6 / settings.fps),
      })
      videoEncoder.encode(vframe, { keyFrame: f % keyEvery === 0 })
      vframe.close()
      await drain(videoEncoder)

      if ((f + 1) % 5 === 0 || f + 1 === framesTotal) {
        post({ type: 'progress', progress: { phase: 'video', framesDone: f + 1, framesTotal } })
      }
    }

    await videoEncoder.flush()
    await videoMux // every queued packet handed to the muxer (or failed)
    throwIfFailed()

    // --- finalize ----------------------------------------------------------
    stage = 'finalizing'
    post({ type: 'progress', progress: { phase: 'finalizing', framesDone: framesTotal, framesTotal } })
    await output.finalize()

    if (writable) {
      await writable.close()
      // Null it BEFORE the finally block, so a closed stream is never aborted.
      writable = null
      outcome = { msg: { type: 'done', buffer: null }, transfer: [] }
    } else {
      const buffer = bufferTarget!.buffer
      if (!buffer) throw new Error('muxer produced no output buffer')
      outcome = { msg: { type: 'done', buffer }, transfer: [buffer] }
    }
  } catch (err) {
    if (err instanceof CancelledError || cancelled) {
      outcome = { msg: { type: 'cancelled' }, transfer: [] }
    } else {
      const message = err instanceof Error ? err.message : String(err)
      outcome = { msg: { type: 'error', message: `Export failed while ${stage}: ${message}` }, transfer: [] }
    }
  } finally {
    // A cancelled or failed streamed export must not leave a half-written movie
    // behind. abort() discards the swap file, so the destination keeps whatever
    // it held before (a zero-byte file if the picker just created it).
    if (writable) {
      try {
        await writable.abort()
      } catch {
        // best-effort teardown
      }
    }
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        // best-effort teardown
      }
    }
    if (outcome) post(outcome.msg, outcome.transfer)
  }
}
