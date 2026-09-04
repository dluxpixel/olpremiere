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
import { ProviderPool } from './providerPool'
import { createRenderer } from '../render/glRenderer'
import { resolveFrame } from '../render/resolve'
import { rasterizeTitle } from '../render/titleRaster'


import { loadTitleFonts, titleFontStacksIn } from '../render/titleFonts'
import type { RenderLayer } from '../render/types'
import type { Clip, Id, TitleDef } from '../types'
import {
  AUDIO_CHUNK_FRAMES,
  effectiveAudioBitrate,
  effectiveRateControl,
  effectiveVideoCodec,
  exportColorSpace,
  firstSupported,
  isHdRaster,
  keyframeStride,
  packPlanarChunk,
  pcmChunks,
  quantizerFor,
  videoCodecLadder,
  videoEncoderConfig,
  EXPORT_DECODER_OPTIONS,
  type RateControl,
  type VideoCodecFamily,
  type ExportRequest,
  type ExportResponse,
} from './messages'

/**
 * Rasterize a title at the EXPORT raster rather than the sequence raster.
 *
 * Font outlines are the only thing in the frame with real detail left to give,
 * and pinning the raster to the timeline threw it away: on the default upscale a
 * caption was a 1080-wide rasterization bilinear-stretched to 1440. Captions are
 * the most-looked-at object in a Short, so this is the most visible quality win
 * available in the export path.
 *
 * When the export raster EQUALS the sequence raster (every SD export, including
 * the golden) the scale is exactly 1 and this is the old call, byte for byte.
 */
function rasterizeTitleForExport(
  title: TitleDef,
  seqW: number,
  seqH: number,
  outW: number,
  outH: number,
): OffscreenCanvas {
  if (outH === seqH && outW === seqW) return rasterizeTitle(title, seqW, seqH)
  return rasterizeTitle(title, outW, outH, outH / seqH)
}

type Accel = 'prefer-hardware' | 'prefer-software' | 'no-preference'

/** Per-frame encode() options carrying the constant-QP quantizer for a codec family. */
function quantizerEncodeOption(family: VideoCodecFamily, q: number): VideoEncoderEncodeOptions {
  if (family === 'av1') return { av1: { quantizer: q } }
  if (family === 'hevc') return { hevc: { quantizer: q } }
  return { avc: { quantizer: q } }
}

/** HEVC needs the explicit 'hevc' bitstream format so a hvcC config box is emitted (else the MP4 is unplayable). */
function withHevcFormat(config: VideoEncoderConfig, family: VideoCodecFamily): VideoEncoderConfig {
  return family === 'hevc' ? { ...config, hevc: { format: 'hevc' } } : config
}

/**
 * Behavioural constant-QP probe. isConfigSupported validates the CONFIG but the
 * per-frame quantizer is passed at encode() time, so an encoder can accept
 * bitrateMode:'quantizer' and then silently rate-control to its own default, an
 * invisible failure that would defeat the whole "flawless" promise. This
 * encodes a few noise frames at a low QP and a high QP on the REAL codec/accel
 * and returns true only if the output byte size actually responds to QP. Cheap
 * (128×72). A false negative merely falls back to high-bitrate VBR (still great),
 * so erring toward "not honoured" is safe.
 */
async function probeQuantizerHonored(codec: string, accel: Accel, family: VideoCodecFamily, fps: number): Promise<boolean> {
  
const W = 128
  const H = 72
  const measure = async (qp: number): Promise<number> => {
    let bytes = 0
    const enc = new VideoEncoder({ output: (c) => (bytes += c.byteLength), error: () => {} })
    enc.configure(
      withHevcFormat(
        videoEncoderConfig({ codec, accel, width: W, height: H, fps, videoBitrate: 2_000_000, rateControl: 'quantizer', isHd: true }),
        family,
      ),
    )
    const q = quantizerFor(family, qp)
    for (let i = 0; i < 6; i++) {
      const canvas = new OffscreenCanvas(W, H)
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(W, H)
      for (let p = 0; p < img.data.length; p += 4) {
        // Deterministic high-frequency noise so QP has real detail to quantise.
        const v = ((p * 2654435761 + i * 40503) >>> 0) & 0xff
        img.data[p] = v
        img.data[p + 1] = (v * 3) & 0xff
        img.data[p + 2] = (v * 7) & 0xff
        img.data[p + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) })
      enc.encode(vf, { keyFrame: i === 0, ...quantizerEncodeOption(family, q) })
      vf.close()
    }
    await enc.flush()
    enc.close()
    return bytes
  }
  try {
    const lo = await measure(4) // near-lossless → large
    const hi = await measure(50) // heavily quantised → small
    return hi > 0 && lo > hi * 1.5
  } catch {
    return false
  }
}

const scope = self as unknown as DedicatedWorkerGlobalScope

const post = (msg: ExportResponse, transfer: Transferable[] = []): void => scope.postMessage(msg, transfer)

class CancelledError extends Error {}

let cancelled = false
let started = false

// The streamed audio-mix segments (see messages.ts): pushed by onmessage,
// consumed in order by the audio-encode loop, which parks on `audioWaiter`
// when it outruns the main thread's renderer. Cancel also wakes the waiter so
// a parked loop can observe the flag.
const audioSegments: Float32Array[][] = []
let audioWaiter: (() => void) | null = null
// Set when init promised audio but no worker-side encoder exists (video-only
// fallback): segments are dropped on arrival, but still ACKed, so the main
// thread's credit window keeps draining instead of deadlocking.
let audioDiscard = false
const wakeAudioLoop = (): void => {
  audioWaiter?.()
  audioWaiter = null
}

// NATIVE mode credit WINDOW. The render loop used to post one RGBA frame and
// park until the page confirmed it had reached ffmpeg, so the GPU and the
// encoder took strict turns and neither ever overlapped the other: the whole
// render pipeline idled for every ffmpeg write and vice versa. A few frames may
// now be in flight at once, which is still a hard bound on peak memory (three
// 1440p frames ≈ 44 MB) rather than an unbounded queue.
//
// The PAGE keeps the writes strictly ordered (a raw RGBA pipe has no framing,
// so two overlapping writes would interleave into garbage); this only decides
// how far ahead the renderer may run.
const FRAME_CREDIT = 3
let framesInFlight = 0
let frameCreditWaiter: (() => void) | null = null
const wakeFrameAck = (): void => {
  frameCreditWaiter?.()
  frameCreditWaiter = null
}
/** Park until the page has drained enough frames to accept another. */
const awaitFrameCredit = (): Promise<void> => {
  if (cancelled || framesInFlight < FRAME_CREDIT) return Promise.resolve()
  return new Promise((resolve) => {
    frameCreditWaiter = resolve
  })
}
/** Park until EVERY posted frame has been written, before ffmpeg's stdin closes. */
const awaitFramesDrained = async (): Promise<void> => {
  while (!cancelled && framesInFlight > 0) {
    await new Promise<void>((resolve) => {
      frameCreditWaiter = resolve
    })
  }
}

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
    wakeAudioLoop()
    wakeFrameAck()
  } else if (msg.type === 'frameAck') {
    framesInFlight = Math.max(0, framesInFlight - 1)
    wakeFrameAck()
  } else if (msg.type === 'audioSegment') {
    if (audioDiscard) {
      post({ type: 'segmentDone' })
    } else {
      audioSegments.push(msg.channelData)
      wakeAudioLoop()
    }
  } else if (!started) {
    started = true
    void (msg.native ? runNative(msg) : run(msg))
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
// requested source time. Classic pull-down. One Input per CLIP, so two clips
// of the same asset (e.g. across a cross-dissolve) read independently.
// A ProviderPool owns the lifetime of these (see providerPool.ts): it closes the
// least recently used one once the live count passes a ceiling, so the decoder
// count stops tracking how finely the timeline is cut.
interface ClipProvider {
  /** Kept so the iterator can be re-opened for a backward (reverse-clip) seek. */
  sink: CanvasSink
  iterator: AsyncGenerator<WrappedCanvas, void, unknown>
  dispose: () => void
  started: boolean
  current: WrappedCanvas | null
  ahead: WrappedCanvas | null
}

/** Closes one provider's iterator and its demuxer. The pool calls this exactly once. */
const closeProvider = (p: ClipProvider): void => {
  // p.iterator, not the one captured at creation, since a reverse re-seek may
  // have replaced it.
  void p.iterator.return?.(undefined)
  p.dispose()
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
  // would freeze on its furthest-decoded frame. The preview reverses correctly
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

/**
 * NATIVE (Electron ffmpeg) render path. Uses the SAME media-open + shared WebGL
 * render pipeline as run() so preview == export, but instead of a WebCodecs
 * encoder + muxer it reads the rendered RGBA back and streams each frame to the
 * page (which relays it to a native ffmpeg process). No WebCodecs, no muxer, no
 * audio here: audio is rendered + muxed on the page/main side.
 */
async function runNative(init: Extract<ExportRequest, { type: 'init' }>): Promise<void> {
  const cleanups: (() => void)[] = []
  let stage = 'preparing'
  let outcome: { msg: ExportResponse; transfer: Transferable[] } | null = null
  try {
    const { settings, sequence, assets } = init
    const W = settings.width
    const H = settings.height
    const framesTotal = Math.max(1, Math.ceil((settings.endS - settings.startS) * settings.fps))
    post({ type: 'progress', progress: { phase: 'preparing', framesDone: 0, framesTotal } })
        // ⚠️ THE SEQUENCE IS PASSED IN, and it has to be. The library went to
    // thirty-eight faces on 2026-08-31 and loading them all here would be
    // thirty-eight fetches in front of an export. `titleFontStacksIn` reads the
    // families off the document, which is the only source that is true in both
    // contexts, so the worker registers exactly what the preview registered and
    // preview == export still holds.
    await loadTitleFonts(scope.fonts, titleFontStacksIn(sequence))

    // --- open media (identical to run()) -----------------------------------
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

    const clipById = new Map<Id, Clip>()
    for (const track of sequence.tracks) {
      if (track.kind !== 'video') continue
      for (const clip of track.clips) clipById.set(clip.id, clip)
    }

    const providers = new ProviderPool<ClipProvider>({ close: closeProvider })
    cleanups.push(() => providers.clear())
    const providerFor = async (clip: Clip): Promise<ClipProvider | null> => {
      const existing = providers.get(clip.id)
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
      const sink = new CanvasSink(track, { decoderOptions: EXPORT_DECODER_OPTIONS })
      const iterator = sink.canvases(Math.max(0, clip.inS))
      const provider: ClipProvider = { sink, iterator, dispose: () => input.dispose(), started: false, current: null, ahead: null }
      providers.set(clip.id, clip, provider)
      return provider
    }

    // --- shared WebGL2 renderer (identical to run()) ------------------------
    stage = 'initializing renderer'
    const canvas = new OffscreenCanvas(W, H)
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('WebGL2 is unavailable in this worker, cannot export')
    // Mipmapped minification at HD and above, matching the preview. Below HD it
    // stays off so the golden 640x360 export keeps its exact legacy bytes.
    const renderer = createRenderer(gl, { mipmapSources: isHdRaster(W, H) })
    cleanups.push(() => renderer.dispose())

    const gatherTextures = async (layers: RenderLayer[]): Promise<Map<RenderLayer, TexImageSource>> => {
      const map = new Map<RenderLayer, TexImageSource>()
      for (const layer of layers) {
        if (layer.title) {
          map.set(layer, rasterizeTitleForExport(layer.title, sequence.width, sequence.height, W, H))
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
          const c = await frameForClip(provider, Math.max(0, layer.sourceTimeS))
          if (c) map.set(layer, c)
        }
      }
      return map
    }

    // --- render → readback → stream ----------------------------------------
    stage = 'rendering video'
    for (let f = 0; f < framesTotal; f++) {
      checkCancel()
      const t = settings.startS + f / settings.fps
      // Close what the sweep has permanently passed BEFORE this frame opens
      // anything new, so the ceiling has room without evicting a live provider.
      providers.beginFrame()
      providers.reap(t)
      const frame = resolveFrame(sequence, t)
      const layers: RenderLayer[] = []
      for (const op of frame.ops) {
        if (op.type === 'layer') layers.push(op.layer)
        else if (op.type === 'transition') layers.push(op.from, op.to)
      }
      const texMap = await gatherTextures(layers)
      renderer.render(frame, (layer) => texMap.get(layer) ?? null)

      // Read the rendered pixels (bottom-origin RGBA; ffmpeg -vf vflip corrects the
      // row order). A fresh buffer per frame because it's transferred to the page.
      const pixels = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      post({ type: 'frame', index: f, data: pixels.buffer }, [pixels.buffer])
      framesInFlight++
      await awaitFrameCredit()
      checkCancel()

      if ((f + 1) % 3 === 0 || f + 1 === framesTotal) {
        post({ type: 'progress', progress: { phase: 'video', framesDone: f + 1, framesTotal } })
      }
    }
    // Every frame must be WRITTEN before 'done' lets the page close ffmpeg's
    // stdin, or the credit window would silently truncate the tail of the video.
    await awaitFramesDrained()
    checkCancel()
    outcome = { msg: { type: 'done', buffer: null }, transfer: [] }
  } catch (err) {
    if (err instanceof CancelledError || cancelled) {
      outcome = { msg: { type: 'cancelled' }, transfer: [] }
    } else {
      const message = err instanceof Error ? err.message : String(err)
      outcome = { msg: { type: 'error', message: `Native export failed while ${stage}: ${message}` }, transfer: [] }
    }
  } finally {
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
    const isHd = isHdRaster(settings.width, settings.height)
    post({ type: 'progress', progress: { phase: 'preparing', framesDone: 0, framesTotal } })

    // Register bundled title fonts in THIS worker's FontFaceSet before any title
    // is rasterized, otherwise a Minecraft title would fall back to a different
    // face here than in the preview, breaking preview == export.
        // ⚠️ THE SEQUENCE IS PASSED IN, and it has to be. The library went to
    // thirty-eight faces on 2026-08-31 and loading them all here would be
    // thirty-eight fetches in front of an export. `titleFontStacksIn` reads the
    // families off the document, which is the only source that is true in both
    // contexts, so the worker registers exactly what the preview registered and
    // preview == export still holds.
    await loadTitleFonts(scope.fonts, titleFontStacksIn(sequence))

    // --- codec + rate-control picks ---------------------------------------
    stage = 'probing encoder support'
    // Effective (SD-gated) knobs: below HD everything collapses to the legacy
    // avc + implicit-VBR config so the golden export stays byte-identical.
    const requestedRate = effectiveRateControl(settings, isHd)
    let codecFamily = effectiveVideoCodec(settings, isHd)

    // Constant-QP forces the SOFTWARE encoder: openh264/libaom reliably honour a
    // per-frame quantizer, whereas hardware NVENC CQP is not guaranteed (it can
    // silently ignore the QP). VBR/CBR keep the requested acceleration, and its
    // 'realtime' B-frame suppression that the Auto crash-fallback depends on.
    const accelOrderFor = (rate: RateControl): Accel[] =>
      rate === 'quantizer'
        ? ['prefer-software', 'no-preference']
        : settings.hardwareAcceleration === 'prefer-hardware'
          ? ['prefer-hardware', 'no-preference']
          : ['prefer-software', 'no-preference']

    const pick = async (family: VideoCodecFamily, rate: RateControl): Promise<{ codec: string; accel: Accel } | null> => {
      for (const accel of accelOrderFor(rate)) {
        const codec = await firstSupported(videoCodecLadder(family), async (c) => {
          const cfg = withHevcFormat(
            videoEncoderConfig({
              codec: c,
              accel,
              width: settings.width,
              height: settings.height,
              fps: settings.fps,
              videoBitrate: settings.videoBitrate,
              rateControl: rate,
              isHd,
            }),
            family,
          )
          const support = await VideoEncoder.isConfigSupported(cfg)
          return support.supported === true
        })
        if (codec) return { codec, accel }
      }
      return null
    }

    let rateControl: RateControl = requestedRate
    let picked = await pick(codecFamily, rateControl)
    // Constant-QP config rejected outright → drop to VBR (still a great export).
    if (!picked && rateControl === 'quantizer') {
      rateControl = 'variable'
      picked = await pick(codecFamily, rateControl)
    }
    // Chosen codec family isn't encodable here → fall back to H.264.
    if (!picked && codecFamily !== 'avc') {
      codecFamily = 'avc'
      picked = await pick(codecFamily, rateControl)
    }
    if (!picked) {
      throw new Error(
        `no ${codecFamily} encoder available for ${settings.width}x${settings.height}@${settings.fps}. Try a smaller frame size`,
      )
    }
    // Constant-QP: confirm the encoder ACTUALLY honours per-frame QP; if not,
    // fall back to VBR at the computed bitrate rather than ship a wrong file.
    if (rateControl === 'quantizer') {
      const honored = await probeQuantizerHonored(picked.codec, picked.accel, codecFamily, settings.fps)
      if (!honored) {
        rateControl = 'variable'
        picked = (await pick(codecFamily, rateControl)) ?? picked
      }
    }
    const videoCodec = picked.codec
    const videoAccel = picked.accel
    const useQuantizer = rateControl === 'quantizer'
    const frameQuantizer = quantizerFor(codecFamily, settings.quantizer ?? 18)

    let audioCodec: 'aac' | 'opus' | null = null
    let audioConfig: AudioEncoderConfig | null = null
    if (audio) {
      const base = {
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.numberOfChannels,
        // SD is forced to the legacy 192k; HD honours the dialog's choice.
        bitrate: effectiveAudioBitrate(settings, isHd),
      }
      // AAC-LC is the universal default; Opus is smaller/cleaner for voice but
      // isn't accepted in MP4 by every player, so it's opt-in. Try the preferred
      // codec first, then fall back to the other. (SD keeps AAC-first so the
      // golden bytes hold.)
      const candidates: { codec: 'aac' | 'opus'; str: string }[] =
        settings.audioCodecPref === 'opus' && isHd
          ? [
              { codec: 'opus', str: 'opus' },
              { codec: 'aac', str: 'mp4a.40.2' },
            ]
          : [
              { codec: 'aac', str: 'mp4a.40.2' },
              { codec: 'opus', str: 'opus' },
            ]
      // A codec is worth more than a bitrate, so drop the RATE before dropping the
      // CODEC. Chrome's AAC encoder refuses anything at or above 256 kbps
      // (measured: 128k and 192k supported, 256k/320k/384k not), and the plan asks
      // for 320k on every HD export. The old loop read that as "no AAC" and wrote
      // OPUS INSIDE AN MP4, which most players and phones will not play, so every
      // HD export he made came out silent while an SD one was fine. Ladder down
      // the bitrate first, and only then consider another codec.
      const ladder = [base.bitrate, 256_000, 192_000, 128_000].filter(
        (b, i, all) => b > 0 && all.indexOf(b) === i,
      )
      outer: for (const cand of candidates) {
        for (const bitrate of ladder) {
          const config = { codec: cand.str, ...base, bitrate }
          const support = await AudioEncoder.isConfigSupported(config)
          if (support.supported) {
            audioCodec = cand.codec
            audioConfig = config
            break outer
          }
        }
      }
      // Neither AAC nor Opus: ship a video-only file instead of failing.
      if (!audioConfig) {
        // Video-only fallback: the main thread will still stream the mix (it
        // has no way to know the probe failed), so discard segments on arrival
        // and ACK them, or the queue retains the entire mix for the whole
        // video render.
        audioDiscard = true
        while (audioSegments.length > 0) {
          audioSegments.shift()
          post({ type: 'segmentDone' })
        }
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
    const videoSource = new EncodedVideoPacketSource(codecFamily)
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
    // their decode order, and CAPTURE failures into encoderError: a throw that
    // escaped the callback surfaced as the opaque "worker crashed" error.
    let videoMux: Promise<void> = Promise.resolve()
    let audioMux: Promise<void> = Promise.resolve()
    const packetOf = (chunk: EncodedVideoChunk | EncodedAudioChunk, tsUs: number, fallbackDurUs: number): EncodedPacket => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      return new EncodedPacket(data, chunk.type, tsUs / 1e6, (chunk.duration ?? fallbackDurUs) / 1e6)
    }

    // Tag HD+ output (the MP4 `colr` box is written from this decoder config) so
    // players and YouTube interpret the colours correctly instead of guessing,
    // the usual cause of "washed out after upload". The tag now follows what the
    // encoder REPORTS rather than asserting BT.709 over pixels it never
    // converted; see exportColorSpace for why that is what makes this match the
    // desktop export. SD stays untagged to keep the golden export byte-stable.
    const videoFrameDurUs = 1e6 / settings.fps
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          if (meta?.decoderConfig) {
            const colorSpace = exportColorSpace(meta.decoderConfig.colorSpace, isHd)
            if (colorSpace) meta.decoderConfig.colorSpace = colorSpace
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
    videoEncoder.configure(
      withHevcFormat(
        videoEncoderConfig({
          codec: videoCodec,
          accel: videoAccel,
          width: settings.width,
          height: settings.height,
          fps: settings.fps,
          videoBitrate: settings.videoBitrate,
          rateControl,
          isHd,
        }),
        codecFamily,
      ),
    )
    cleanups.push(() => {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    })

    // --- audio encode ------------------------------------------------------
    if (audio && audioConfig) {
      stage = 'encoding audio'
      post({ type: 'progress', progress: { phase: 'audio', framesDone: 0, framesTotal } })
      // Normalize the track so its first chunk lands at t=0: AAC encoder
      // priming can stamp the first chunk slightly after zero, which used to
      // crash the old muxer's strict mode (fixed then via 'offset', kept here).
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

      // Consume the streamed segments in arrival order until every frame the
      // init meta promised has been encoded. Timestamps are computed from the
      // GLOBAL frame position, so the AAC framing is identical to the old
      // whole-mix loop (segments are exact multiples of AUDIO_CHUNK_FRAMES
      // except the last).
      let audioFramesDone = 0
      while (audioFramesDone < audio.totalFrames) {
        checkCancel()
        throwIfFailed()
        const seg = audioSegments.shift()
        if (!seg) {
          await new Promise<void>((resolve) => {
            audioWaiter = resolve
          })
          continue
        }
        const segFrames = seg[0]?.length ?? 0
        for (const chunk of pcmChunks(segFrames, AUDIO_CHUNK_FRAMES, audio.sampleRate)) {
          checkCancel()
          throwIfFailed()
          const data = new AudioData({
            format: 'f32-planar',
            sampleRate: audio.sampleRate,
            numberOfFrames: chunk.frames,
            numberOfChannels: audio.numberOfChannels,
            timestamp: Math.round(((audioFramesDone + chunk.offset) * 1e6) / audio.sampleRate),
            data: packPlanarChunk(seg, chunk.offset, chunk.frames),
          })
          audioEncoder.encode(data)
          data.close()
          await drain(audioEncoder)
        }
        audioFramesDone += segFrames
        // Credit back to the producer: this segment is consumed, its memory is
        // free, so the main thread may render the next one.
        post({ type: 'segmentDone' })
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

    const providers = new ProviderPool<ClipProvider>({ close: closeProvider })
    cleanups.push(() => providers.clear())
    const providerFor = async (clip: Clip): Promise<ClipProvider | null> => {
      const existing = providers.get(clip.id)
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
      const sink = new CanvasSink(track, { decoderOptions: EXPORT_DECODER_OPTIONS })
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
      providers.set(clip.id, clip, provider)
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
    if (!gl) throw new Error('WebGL2 is unavailable in this browser’s worker, cannot export')
    // See the note on the other renderer above: HD and up gets the mipmapped
    // minification the preview already had, sub-HD holds the golden bytes.
    const renderer = createRenderer(gl, { mipmapSources: isHdRaster(settings.width, settings.height) })
    cleanups.push(() => renderer.dispose())

    /** Decode every layer's texture for one frame (async), keyed by layer ref. */
    const gatherTextures = async (layers: RenderLayer[]): Promise<Map<RenderLayer, TexImageSource>> => {
      const map = new Map<RenderLayer, TexImageSource>()
      for (const layer of layers) {
        if (layer.title) {
          map.set(
            layer,
            rasterizeTitleForExport(layer.title, sequence.width, sequence.height, settings.width, settings.height),
          )
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
    const keyEvery = keyframeStride(settings.fps, settings.keyframeIntervalS)
    for (let f = 0; f < framesTotal; f++) {
      checkCancel()
      throwIfFailed()
      // Sample the sequence from the work-area start, but stamp the output from
      // zero: a work-area export begins at its in point, not after startS of black.
      const t = settings.startS + f / settings.fps
      // Close what the sweep has permanently passed BEFORE this frame opens
      // anything new, so the ceiling has room without evicting a live provider.
      providers.beginFrame()
      providers.reap(t)
      const frame = resolveFrame(sequence, t)

      const layers: RenderLayer[] = []
      for (const op of frame.ops) {
        if (op.type === 'layer') layers.push(op.layer)
        else if (op.type === 'transition') layers.push(op.from, op.to)
        // adjustment ops carry no texture, so nothing to gather
      }
      const texMap = await gatherTextures(layers)
      renderer.render(frame, (layer) => texMap.get(layer) ?? null)

      const vframe = new VideoFrame(canvas, {
        timestamp: Math.round((f * 1e6) / settings.fps),
        duration: Math.round(1e6 / settings.fps),
      })
      // Constant-QP passes the fixed quantizer on EVERY frame. A missed frame
      // silently reverts to the encoder's default QP. VBR/CBR pass no QP.
      videoEncoder.encode(vframe, {
        keyFrame: f % keyEvery === 0,
        ...(useQuantizer ? quantizerEncodeOption(codecFamily, frameQuantizer) : {}),
      })
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
