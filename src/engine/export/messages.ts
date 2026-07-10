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
}

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'finalizing'
  framesDone: number
  framesTotal: number
}

/**
 * Full stereo PCM mix rendered on the main thread — OfflineAudioContext is
 * not reliably available inside workers. Buffers are transferred, not copied.
 */
export interface RenderedAudio {
  sampleRate: number
  numberOfChannels: number
  channelData: Float32Array<ArrayBuffer>[]
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
      audio: RenderedAudio | null
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
  | { type: 'cancel' }

export type ExportResponse =
  | { type: 'progress'; progress: ExportProgress }
  /** `buffer` is null when the file was streamed to disk: there is nothing to hand back. */
  | { type: 'done'; buffer: ArrayBuffer | null }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in export.test.ts)

/** H.264 candidates, best first: High 4.0 → Main 4.0 → Baseline 3.1. */
export const H264_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'] as const

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
