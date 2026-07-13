// Main-thread side of local transcription: pull a clip's audio out of the
// project, resample it to Whisper's 16kHz mono, run the worker, and map the
// word timestamps back onto the timeline. The mapping layer is pure so the
// caption pipeline is testable without a model.

import { getAudioBuffer } from '../audio'
import type { Clip, MediaAsset } from '../types'
import type { CaptionWord } from './captions'
import type { TranscribeResponse } from './transcribeWorker'

/** Whisper's feature-extractor input rate. */
export const TRANSCRIBE_SAMPLE_RATE = 16000

/** One word as the ASR emits it — times relative to the transcribed slice. */
export interface TranscribedWord {
  text: string
  startS: number
  endS: number
}

export interface AsrChunk {
  text: string
  timestamp: [number, number | null]
}

/**
 * Clean the raw ASR words: trim whitespace, drop empties and bracketed noise
 * tags ([BLANK_AUDIO], [MUSIC]), and repair the end times Whisper leaves null
 * or inverted (usually the final word of a chunk).
 */
export function wordsFromAsrChunks(chunks: readonly AsrChunk[]): TranscribedWord[] {
  const words: TranscribedWord[] = []
  for (const c of chunks) {
    const text = c.text.trim()
    if (!text || /^[[(].*[\])]$/.test(text)) continue
    const startS = Math.max(0, c.timestamp[0] ?? 0)
    let endS = c.timestamp[1] ?? NaN
    if (!Number.isFinite(endS) || endS <= startS) endS = startS + Math.max(0.2, 0.05 * text.length)
    words.push({ text, startS, endS })
  }
  return words
}

/**
 * Map slice-relative word times onto the sequence timeline. The transcribed
 * slice starts at the clip's in point, so timeline time = clip start + word
 * time compressed by the clip's playback speed.
 */
export function timelineWords(words: readonly TranscribedWord[], clip: Clip): CaptionWord[] {
  const speed = Math.abs(clip.speed) || 1
  return words.map((w) => ({
    text: w.text,
    startS: clip.startS + w.startS / speed,
    endS: clip.startS + w.endS / speed,
  }))
}

/**
 * Decode the clip's trimmed slice ([inS, outS) of its asset) to 16kHz mono.
 * Uses the same cached decode as playback, then a tiny OfflineAudioContext as
 * the resampler. Browser-only.
 */
export async function extractClipPcm(asset: MediaAsset, clip: Clip): Promise<Float32Array> {
  const buffer = await getAudioBuffer(asset)
  if (!buffer) throw new Error('clip has no decodable audio')
  const durS = Math.max(0, Math.min(clip.outS, buffer.duration) - clip.inS)
  if (durS <= 0) throw new Error('clip trim leaves no audio')
  const frames = Math.max(1, Math.ceil(durS * TRANSCRIBE_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(1, frames, TRANSCRIBE_SAMPLE_RATE)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start(0, clip.inS, durS)
  const rendered = await ctx.startRendering()
  return new Float32Array(rendered.getChannelData(0))
}

export interface TranscribeProgress {
  phase: 'model' | 'listening'
  pct: number | null
}

export interface TranscribeRun {
  promise: Promise<AsrChunk[]>
  /** Terminates the worker; the promise rejects with { cancelled: true }. */
  cancel: () => void
}

/** Run Whisper on 16kHz mono PCM in a dedicated worker. */
export function transcribePcm(
  pcm: Float32Array,
  onProgress: (p: TranscribeProgress) => void,
): TranscribeRun {
  const worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' })
  let settled = false
  let reject!: (reason: unknown) => void
  const promise = new Promise<AsrChunk[]>((res, rej) => {
    reject = rej
    worker.onmessage = (e: MessageEvent<TranscribeResponse>) => {
      const msg = e.data
      if (msg.type === 'progress') onProgress({ phase: msg.phase, pct: msg.pct })
      else if (msg.type === 'done') {
        settled = true
        worker.terminate()
        res(msg.chunks)
      } else {
        settled = true
        worker.terminate()
        rej(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      settled = true
      worker.terminate()
      rej(new Error(e.message || 'transcription worker crashed'))
    }
  })
  // Transferring the PCM avoids copying up to minutes of audio.
  worker.postMessage({ pcm }, [pcm.buffer])
  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      worker.terminate()
      reject({ cancelled: true })
    },
  }
}
