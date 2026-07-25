// Main-thread side of local transcription: pull a clip's audio out of the
// project, resample it to Whisper's 16kHz mono, run the worker, and map the
// word timestamps back onto the timeline. The mapping layer is pure so the
// caption pipeline is testable without a model.

import { getAudioBuffer } from '../audio'
import type { Clip, MediaAsset } from '../types'
import type { CaptionWord } from './captions'
import type { CaptionLanguage } from './transcribeConfig'
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
 * Whisper's classic end-of-audio hallucinations. It was trained on subtitle
 * files, so when the audio goes quiet it invents the credits it saw in that
 * data. This is a documented failure mode, not a guess — the list stays SHORT
 * and only ever fires at the very end after real silence, so a video that
 * genuinely ends on "thanks for watching" keeps it.
 */
const TAIL_HALLUCINATIONS = [
  'thanks for watching',
  'thank you for watching',
  'thanks for watching!',
  'subscribe to my channel',
  'please subscribe',
  'subtitles by',
  'transcribed by',
  'amara.org',
]

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9'!?]/g, '')

/** A token that is only punctuation carries no word and must not become a caption. */
const isPunctuationOnly = (t: string): boolean => !/[a-z0-9]/i.test(t)

/**
 * Repair what the recogniser actually got wrong, before any of it becomes
 * captions. Three real artifacts, each deterministic:
 *
 *  - LOOPS. On a stutter or a stretch of near-silence Whisper repeats a token,
 *    sometimes many times. An immediate repeat of the same word with no real gap
 *    is the recogniser skipping, never speech.
 *  - BARE PUNCTUATION. A chunk that is just "." or "," would otherwise become a
 *    caption clip showing a full stop.
 *  - TAIL HALLUCINATIONS. See TAIL_HALLUCINATIONS above.
 *
 * What this deliberately does NOT do is fix general mishearings — telling
 * "diamonds" from "diamond's" from "die-monds" needs a language model, and there
 * isn't one running locally. Punctuation is also left ALONE on purpose: the
 * chunker reads sentence-ending marks to decide where a caption must break, so
 * stripping them here would silently flatten those boundaries.
 */
export function tidyTranscribedWords(words: readonly TranscribedWord[]): TranscribedWord[] {
  const out: TranscribedWord[] = []
  for (const w of words) {
    const text = w.text.trim()
    if (!text || isPunctuationOnly(text)) continue
    const prev = out[out.length - 1]
    // A repeat with no audible gap is the model skipping, not the speaker
    // saying it twice. Absorb the skipped span into the word we kept, so a run
    // of loops collapses to one caption covering the whole stretch (and so the
    // NEXT repeat is still measured against a gap that has not gone stale).
    if (prev && norm(prev.text) === norm(text) && w.startS - prev.endS < 0.12) {
      prev.endS = Math.max(prev.endS, w.endS)
      continue
    }
    out.push({ ...w, text })
  }

  // Trailing invention: only when it sits after a real pause, so a video that
  // really does end on those words keeps them.
  for (let take = Math.min(4, out.length); take >= 1; take--) {
    const tail = out.slice(out.length - take)
    const phrase = tail
      .map((w) => w.text)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9' ]/g, '')
      .trim()
    if (!TAIL_HALLUCINATIONS.includes(phrase)) continue
    const before = out[out.length - take - 1]
    if (before && tail[0].startS - before.endS < 0.6) continue // spoken, not invented
    out.length = out.length - take
    break
  }
  return out
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

// One long-lived worker for the whole session: the heavy Whisper model loads
// ONCE and stays resident, so a second/third caption run reuses it with no
// re-download and no "Downloading Whisper" banner. Only cancel/crash tears it
// down (the next run lazily rebuilds it).
let sharedWorker: Worker | null = null
function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' })
  }
  return sharedWorker
}
function killWorker(): void {
  if (sharedWorker) {
    sharedWorker.terminate()
    sharedWorker = null
  }
}

// The shared worker has no per-request id and routes each message to whoever is
// listening, so exactly ONE run may be in flight at a time. The UI already
// guards this, but this module-level lock makes transcribePcm safe on its own
// (and future-proofs a "caption every clip" batch feature).
let busy = false

/** Run Whisper on 16kHz mono PCM in the shared, kept-alive worker. */
export function transcribePcm(
  pcm: Float32Array,
  language: CaptionLanguage,
  onProgress: (p: TranscribeProgress) => void,
): TranscribeRun {
  if (busy) {
    return {
      promise: Promise.reject(new Error('A transcription is already running')),
      cancel: () => {},
    }
  }
  busy = true
  const worker = getWorker()
  let settled = false
  let reject!: (reason: unknown) => void
  const promise = new Promise<AsrChunk[]>((res, rej) => {
    reject = rej
    const cleanup = (): void => {
      busy = false
      worker.removeEventListener('message', onMessage as EventListener)
      worker.removeEventListener('error', onError as EventListener)
    }
    const onMessage = (e: MessageEvent<TranscribeResponse>): void => {
      const msg = e.data
      if (msg.type === 'progress') onProgress({ phase: msg.phase, pct: msg.pct })
      else if (msg.type === 'done') {
        settled = true
        cleanup() // keep the worker ALIVE — model stays loaded for next time
        res(msg.chunks)
      } else {
        settled = true
        cleanup()
        killWorker() // a hard error may have corrupted the pipeline — rebuild next run
        rej(new Error(msg.message))
      }
    }
    const onError = (e: ErrorEvent): void => {
      settled = true
      cleanup()
      killWorker()
      rej(new Error(e.message || 'transcription worker crashed'))
    }
    worker.addEventListener('message', onMessage as EventListener)
    worker.addEventListener('error', onError as EventListener)
  })
  // Transferring the PCM avoids copying up to minutes of audio.
  worker.postMessage({ pcm, language }, [pcm.buffer])
  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      busy = false
      killWorker() // terminate mid-inference (can't interrupt otherwise)
      reject({ cancelled: true })
    },
  }
}
