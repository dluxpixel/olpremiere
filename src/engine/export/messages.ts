// Wire protocol between exportSequence (main thread) and exportWorker, plus
// the pure math both sides share. Keep this file DOM/worker-global-free so
// the helpers run under node for unit tests.

import type { Id, MediaAsset, Sequence } from '../types'

/**
 * How the encoder spends bits.
 * - 'variable' — VBR, `bitrate` is an average target, quality floats. This is
 *   the DEFAULT and matches the historical behaviour byte-for-byte (no
 *   `bitrateMode` key is emitted for it — see videoEncoderConfig).
 * - 'constant' — CBR, holds `bitrate`.
 * - 'quantizer' — constant-quality (the browser analogue of OBS "Constant QP"):
 *   `bitrate` is ignored and a fixed per-frame QP is passed to encode(). The
 *   quality dial the whole dialog is built around.
 */
export type RateControl = 'variable' | 'constant' | 'quantizer'

/** Video codec family. 'avc' (H.264) is always available; the others are probe-gated. */
export type VideoCodecFamily = 'avc' | 'hevc' | 'av1'

/**
 * The video DECODE preference for EXPORT: always SOFTWARE. Hardware decoders
 * (e.g. NVDEC) mis-reconstruct inter-frame (P/B) macroblocks on real long-GOP
 * capture footage (OBS/NVENC), visible as torn/sheared frames clustered in
 * high-motion areas — a clean static ground, a shredded moving sky — while flat
 * or all-keyframe content decodes fine, which is why the golden export never
 * caught it. Export must be pixel-CORRECT, not fast; it is already dominated by
 * libx264 -preset veryslow, so software decode costs little. Preview keeps
 * hardware decode (downscaled) for scrub speed — the two paths may differ
 * because export must be correct. Passed as the CanvasSink `decoderOptions`.
 */
export const EXPORT_DECODER_OPTIONS = { hardwareAcceleration: 'prefer-software' } as const

export interface ExportSettings {
  width: number
  height: number
  fps: number
  /** Bits per second. Used by the 'variable' / 'constant' rate controls. */
  videoBitrate: number
  /**
   * The sequence-time range to render, normalised by engine/workArea.ts. Output
   * timestamps always start at zero, so a work-area export produces a file that
   * begins at its in point rather than one padded with `startS` of black.
   */
  startS: number
  endS: number
  /**
   * Encoder acceleration. 'prefer-hardware' is a fast GPU encode, but some GPUs
   * emit B-frames that mp4-muxer can't mux (the export crashes with a
   * monotonic-timestamp error); 'prefer-software' uses Chrome's openh264, which
   * has no B-frames (reliable, a little slower). Defaults to software.
   */
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference'
  /**
   * Rate control. Absent → 'variable' (the byte-identical legacy default). Only
   * ever takes effect at HD+; SD is forced to 'variable' so the golden export
   * never moves (see effectiveRateControl).
   */
  rateControl?: RateControl
  /** Constant-quality QP on the shared H.264/HEVC 0–51 scale (lower = better). Used only in 'quantizer' mode. */
  quantizer?: number
  /** Video codec family. Absent → 'avc'. HEVC/AV1 are only set when the machine can encode them. */
  videoCodec?: VideoCodecFamily
  /** Seconds between forced keyframes. Absent → 2. */
  keyframeIntervalS?: number
  /** AAC/Opus target bitrate (bps). Absent → 192_000. SD is always forced to 192_000. */
  audioBitrate?: number
  /** Preferred audio codec; the encoder still falls back aac→opus by support. */
  audioCodecPref?: 'aac' | 'opus'
}

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'finalizing'
  framesDone: number
  framesTotal: number
}

/**
 * Shape of the audio mix the worker will receive. The PCM itself arrives as a
 * stream of `audioSegment` messages AFTER init — the mix is rendered on the
 * main thread (OfflineAudioContext is not reliably available inside workers)
 * in bounded segments, so a long export never allocates its whole PCM at once.
 */
export interface AudioStreamMeta {
  sampleRate: number
  numberOfChannels: number
  /** Total frames across all segments — the worker's loop-termination count. */
  totalFrames: number
}

export interface ExportAsset {
  id: Id
  kind: MediaAsset['kind']
  /** Kept so worker errors can name the offending file. */
  name: string
  blob: Blob
}

export type ExportRequest =
  | {
      type: 'init'
      settings: ExportSettings
      sequence: Sequence
      assets: ExportAsset[]
      audio: AudioStreamMeta | null
      /**
       * NATIVE (Electron ffmpeg) mode: skip the WebCodecs encoder + muxer + audio
       * entirely. The worker only RENDERS with the shared WebGL pipeline and
       * streams raw RGBA frames to the page (which relays them to a native ffmpeg
       * process). Audio is handled separately on the page/main side.
       */
      native?: boolean
      /**
       * Destination opened with showSaveFilePicker on the main thread. Handles
       * are structured-cloneable, so the worker opens the writable itself and
       * mp4-muxer streams encoded chunks straight to disk: peak memory stays
       * bounded no matter how long the export runs. Absent when the browser
       * lacks File System Access (Firefox), in which case the worker buffers
       * the file and hands back an ArrayBuffer to download.
       */
      fileHandle?: FileSystemFileHandle
    }
  /** One rendered mix segment, in order. Buffers are transferred, not copied. */
  | { type: 'audioSegment'; channelData: Float32Array<ArrayBuffer>[] }
  /** NATIVE mode: the page confirms one rendered RGBA frame was written to ffmpeg — the worker's render credit. */
  | { type: 'frameAck' }
  | { type: 'cancel' }

export type ExportResponse =
  | { type: 'progress'; progress: ExportProgress }
  /**
   * Backpressure credit: one per audioSegment fully consumed (encoded, or
   * discarded when the worker has no audio encoder). The producer holds a
   * small in-flight window against these, so the worker's segment queue —
   * and therefore peak audio memory — stays bounded no matter how much
   * faster the offline render runs than the encode.
   */
  | { type: 'segmentDone' }
  /** NATIVE mode: one rendered RGBA frame (bottom-origin; ffmpeg -vf vflip corrects it). Transferred. */
  | { type: 'frame'; index: number; data: ArrayBuffer }
  /** `buffer` is null when the file was streamed to disk: there is nothing to hand back. */
  | { type: 'done'; buffer: ArrayBuffer | null }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in export.test.ts)

/**
 * H.264 candidates, best first. Higher resolutions need higher LEVELS: L4.0 maxes
 * out at 1080p, so a 1440p/4K (YouTube upscale) export needs L5.0–L5.2. The
 * encoder probe (firstSupported) picks the first the browser accepts for the
 * chosen frame size — 1080p lands on L4.0, 2K on L5.0, 4K on L5.1/L5.2.
 */
export const H264_CODECS = [
  'avc1.640028', // High L4.0 — ≤1080p (widest compatibility)
  'avc1.640032', // High L5.0 — ≤1440p
  'avc1.640033', // High L5.1 — ≤4K @30
  'avc1.640034', // High L5.2 — ≤4K @60
  'avc1.4d0028', // Main L4.0 (fallback)
  'avc1.42001f', // Baseline L3.1 (fallback)
] as const

// HEVC/H.265 Main, 8-bit, laddered lowest-level-first like H264 so a probe lands
// on the tightest level the raster needs (L120≈4.0 ≤1080p → L156≈5.2 4K@60).
// HEVC ENCODE is hardware-only in Chrome (no software fallback), so these only
// ever get used when VideoEncoder.isConfigSupported confirms the GPU can do it.
export const HEVC_CODECS = [
  'hvc1.1.6.L120.B0', // ≤1080p
  'hvc1.1.6.L150.B0', // ≤1440p
  'hvc1.1.6.L153.B0', // ≤4K @30
  'hvc1.1.6.L156.B0', // ≤4K @60
] as const

// AV1 Main profile (0), 8-bit; level laddered lowest-first (4.0 → 5.0 → 6.0).
// Software AV1 encode is always available but slow (3–5× VP9); hardware AV1 is
// RTX-40+ only. Probe-gated either way.
export const AV1_CODECS = ['av01.0.08M.08', 'av01.0.12M.08', 'av01.0.16M.08'] as const

/** The codec-string ladder for a family (best-compatibility first). */
export function videoCodecLadder(family: VideoCodecFamily): readonly string[] {
  return family === 'hevc' ? HEVC_CODECS : family === 'av1' ? AV1_CODECS : H264_CODECS
}

/** True for a raster the quality path treats as HD+ (the SD golden byte-stability gate). */
export function isHdRaster(width: number, height: number): boolean {
  return height >= 720 || width >= 1280
}

/**
 * The rate control that actually reaches the encoder. SD is ALWAYS coerced to
 * 'variable' — the golden 640×360 export must emit the exact legacy config, and
 * every new quality behaviour is a no-op below HD. Both the config builder and
 * the per-frame encode() options derive from THIS single value, so config and
 * frame options can never disagree (the bug the byte-fence guards against).
 */
export function effectiveRateControl(settings: Pick<ExportSettings, 'rateControl'>, isHd: boolean): RateControl {
  return isHd ? (settings.rateControl ?? 'variable') : 'variable'
}

/** The codec family that reaches the encoder — SD is pinned to 'avc' to hold the golden bytes. */
export function effectiveVideoCodec(settings: Pick<ExportSettings, 'videoCodec'>, isHd: boolean): VideoCodecFamily {
  return isHd ? (settings.videoCodec ?? 'avc') : 'avc'
}

/** Frames between forced keyframes (≥1). SD keeps the legacy fps×2 by defaulting keyframeIntervalS to 2. */
export function keyframeStride(fps: number, keyframeIntervalS: number | undefined): number {
  return Math.max(1, Math.round(fps * (keyframeIntervalS ?? 2)))
}

/** Audio target bitrate that reaches the encoder — SD is forced to the legacy 192 kbps to hold the golden bytes. */
export function effectiveAudioBitrate(settings: Pick<ExportSettings, 'audioBitrate'>, isHd: boolean): number {
  return isHd ? (settings.audioBitrate ?? 192_000) : 192_000
}

/**
 * Map the UI quantizer (shown on the H.264/HEVC 0–51 scale, lower = better) to
 * the codec-native range passed to encode(). AVC and HEVC share 0–51; AV1 uses
 * 0–255, so it is rescaled. Clamped so a bad input can never throw at encode.
 */
export function quantizerFor(codec: VideoCodecFamily, qp: number): number {
  const clamped = Math.max(0, Math.min(51, Math.round(Number.isFinite(qp) ? qp : 18)))
  return codec === 'av1' ? Math.round((clamped / 51) * 255) : clamped
}

/**
 * Build the EXACT VideoEncoderConfig — pure, so the SD-byte-stability test can
 * assert it key-for-key (including the ABSENCE of `bitrateMode` for the legacy
 * VBR path). `rateControl` here is the EFFECTIVE value (already SD-gated).
 *
 * Invariants this preserves:
 * - 'variable' emits NO `bitrateMode` key (Chrome's implicit VBR) — identical to
 *   the historical config, so SD/legacy HD exports don't move a byte.
 * - latencyMode keeps the legacy formula: 'quality' only on the software HD path
 *   (which is where CQP runs), 'realtime' everywhere else — so the HW VBR path
 *   still suppresses the B-frames the Auto crash-fallback depends on.
 * - 'quantizer' omits `bitrate` (ignored in that mode); the per-frame QP is
 *   passed to encode() separately.
 */
export function videoEncoderConfig(args: {
  codec: string
  accel: 'prefer-hardware' | 'prefer-software' | 'no-preference'
  width: number
  height: number
  fps: number
  videoBitrate: number
  rateControl: RateControl
  isHd: boolean
}): VideoEncoderConfig {
  const { codec, accel, width, height, fps, videoBitrate, rateControl, isHd } = args
  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    framerate: fps,
    latencyMode: accel === 'prefer-software' && isHd ? 'quality' : 'realtime',
    hardwareAcceleration: accel,
  }
  if (rateControl === 'quantizer') {
    config.bitrateMode = 'quantizer'
  } else if (rateControl === 'constant') {
    config.bitrate = videoBitrate
    config.bitrateMode = 'constant'
  } else {
    // 'variable': plain bitrate, NO bitrateMode key — byte-identical to legacy.
    config.bitrate = videoBitrate
  }
  return config
}

/** First candidate the async predicate accepts; probes stop at the first hit. */
export async function firstSupported<T>(
  candidates: readonly T[],
  isSupported: (candidate: T) => Promise<boolean>,
): Promise<T | null> {
  for (const candidate of candidates) {
    if (await isSupported(candidate)) return candidate
  }
  return null
}

export interface FitRect {
  x: number
  y: number
  w: number
  h: number
}

/** Contain-fit `src` into `dst`, centered — same math as the preview compositor. */
export function containRect(srcW: number, srcH: number, dstW: number, dstH: number): FitRect | null {
  if (srcW <= 0 || srcH <= 0) return null
  const scale = Math.min(dstW / srcW, dstH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}

// Absorbs float error in startS * fps so a clip starting exactly on a frame
// boundary includes that frame (ceil(3.0000000000000004 - EPS) === 3).
const FRAME_EPS = 1e-6

/** Output-frame indices [first, end) whose time f / fps lands in [startS, endS). */
export function clipFrameRange(startS: number, endS: number, fps: number): { first: number; end: number } {
  const first = Math.max(0, Math.ceil(startS * fps - FRAME_EPS))
  const end = Math.max(first, Math.ceil(endS * fps - FRAME_EPS))
  return { first, end }
}

/** 0.1 s at 48 kHz — comfortably under AAC/Opus internal frame limits. */
export const AUDIO_CHUNK_FRAMES = 4800

export interface PcmChunk {
  /** Frame offset into the full mix. */
  offset: number
  frames: number
  timestampUs: number
}

export function pcmChunks(totalFrames: number, chunkFrames: number, sampleRate: number): PcmChunk[] {
  const chunks: PcmChunk[] = []
  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    chunks.push({
      offset,
      frames: Math.min(chunkFrames, totalFrames - offset),
      timestampUs: Math.round((offset * 1e6) / sampleRate),
    })
  }
  return chunks
}

/**
 * Pack per-channel slices [offset, offset + frames) into one contiguous
 * f32-planar buffer (plane i starts at i * frames) for AudioData.
 */
export function packPlanarChunk(
  channelData: readonly Float32Array[],
  offset: number,
  frames: number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames * channelData.length)
  channelData.forEach((channel, i) => out.set(channel.subarray(offset, offset + frames), i * frames))
  return out
}
