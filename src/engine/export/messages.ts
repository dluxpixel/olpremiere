// Wire protocol between exportSequence (main thread) and exportWorker, plus
// the pure math both sides share. Keep this file DOM/worker-global-free so
// the helpers run under node for unit tests.

import type { Id, MediaAsset, Sequence } from '../types'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  /** Bits per second. */
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
