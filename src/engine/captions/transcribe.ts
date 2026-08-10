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

/** One word as the ASR emits it. Times are relative to the transcribed slice. */
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
 * data. This is a documented failure mode, not a guess, so the list stays SHORT
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

/**
 * Two tokens compared for the loop check, ignoring the punctuation the chunker
 * needs left attached. Unicode aware for the same reason as isPunctuationOnly:
 * an ASCII-only strip flattens every accented word to the empty string, so
 * Czech "ó" and "á" back to back would read as the recogniser repeating itself
 * and the second one would be absorbed into the first.
 */
const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}'!?]/gu, '')

/**
 * A token that is only punctuation carries no word and must not become a
 * caption. This is also what drops a bare musical note ("♪", "♪♪♪"), which
 * Whisper writes over an instrumental stretch: a note carries no letter and no
 * digit, so it fails this test like any other mark. Stated here because it is
 * load-bearing, and pinned by a test, rather than written out a second time.
 *
 * The test is any Unicode letter or digit, NOT `a-z0-9`. Czech is a selectable
 * caption language, and an ASCII test called a one-letter accented word like
 * "ó" bare punctuation and deleted it before it could reach the screen.
 */
const isPunctuationOnly = (t: string): boolean => !/[\p{L}\p{N}]/u.test(t)

/**
 * A bracketed stage direction can be spread over SEVERAL words, so this is the
 * furthest ahead the closing bracket is allowed to be. Real tags are short
 * ("[MUSIC PLAYING]", "[soft piano music continues playing]"); the cap is what
 * stops a stray bracket from swallowing a whole sentence he actually said.
 */
const MAX_TAG_WORDS = 6

/** A leading quote or dash is subtitle decoration, not part of the word. */
const opensTag = (t: string): boolean => /^[-"']*[[(]/.test(t)

/** The bracket may carry trailing punctuation: "[Music]," closes just as well. */
const closesTag = (t: string): boolean => /[\])]["'.,!?;:]*$/.test(t)

/**
 * Where a bracketed run that starts at `i` ends, as an index ONE PAST its last
 * word, or -1 when it never closes inside MAX_TAG_WORDS. -1 means keep every
 * word: an unclosed bracket is a stray character, never a licence to delete.
 */
function tagRunEnd(words: readonly TranscribedWord[], i: number): number {
  const limit = Math.min(words.length, i + MAX_TAG_WORDS)
  for (let j = i; j < limit; j++) {
    if (closesTag(words[j].text.trim())) return j + 1
  }
  return -1
}

/** The longest phrase a stuck recogniser is allowed to be cycling on. */
const MAX_LOOP_PHRASE = 8

/**
 * How many times a phrase must repeat BACK TO BACK before it reads as the model
 * looping rather than a person repeating themselves. Three is deliberate: "come
 * on, come on" is a thing he says, "a little bit of a little bit of a little bit
 * of" is not a thing anyone says.
 */
const MIN_LOOP_REPEATS = 3

/** The same "no audible gap" test the single word loop rule uses. */
const LOOP_GAP_S = 0.12

/** Are the `len` words at `a` and at `b` the same phrase, said with no gap? */
function samePhrase(words: readonly TranscribedWord[], a: number, b: number, len: number): boolean {
  if (b + len > words.length) return false
  for (let j = 0; j < len; j++) {
    if (norm(words[a + j].text) !== norm(words[b + j].text)) return false
    if (words[b + j].startS - words[b + j - 1].endS >= LOOP_GAP_S) return false
  }
  return true
}

/**
 * Collapse a phrase the recogniser got stuck on, keeping ONE copy.
 *
 * The single word rule above catches "the the the". It cannot catch the other
 * shape Whisper produces on a long instrumental stretch, where it cycles a whole
 * phrase and no two ADJACENT words are ever equal: 40 s of a rigid backing bed
 * measured 296 invented words on three consecutive runs, every one of them "a
 * little bit of" over and over inside a single chunk.
 *
 * This is the same judgement as the single word rule, applied to a run of words
 * instead of one: a phrase repeated three or more times with no audible gap is
 * the recogniser skipping. It may only ever REMOVE words, never change one, and
 * the copy that is kept is the first, so a caption still covers the stretch.
 *
 * The shortest cycle wins, which is why the search runs from 2 upward: "a little
 * bit of a little bit of" is one four word phrase repeating, not two eight word
 * phrases that happen to match.
 */
function collapsePhraseLoops(words: readonly TranscribedWord[]): TranscribedWord[] {
  const out: TranscribedWord[] = []
  let i = 0
  while (i < words.length) {
    let cycle = 0
    let reps = 1
    for (let len = 2; len <= MAX_LOOP_PHRASE && i + len * MIN_LOOP_REPEATS <= words.length; len++) {
      let n = 1
      while (samePhrase(words, i, i + n * len, len)) n++
      if (n >= MIN_LOOP_REPEATS) {
        cycle = len
        reps = n
        break
      }
    }
    if (cycle === 0) {
      out.push(words[i])
      i++
      continue
    }
    // Keep one copy, stretched over everything the loop covered, so the caption
    // sits on the whole run rather than only its first fraction of a second.
    const run = words.slice(i, i + cycle)
    const endS = words[i + cycle * reps - 1].endS
    for (const w of run) out.push(w)
    out[out.length - 1] = { ...run[run.length - 1], endS: Math.max(run[run.length - 1].endS, endS) }
    i += cycle * reps
  }
  return out
}

/**
 * Repair what the recogniser actually got wrong, before any of it becomes
 * captions. Four real artifacts, each deterministic:
 *
 *  - LOOPS. On a stutter or a stretch of near-silence Whisper repeats a token,
 *    sometimes many times. An immediate repeat of the same word with no real gap
 *    is the recogniser skipping, never speech. The same failure also happens to
 *    whole PHRASES over long instrumental audio, which this word by word test
 *    cannot see because no two ADJACENT words match, so collapsePhraseLoops
 *    above handles that shape.
 *  - BARE PUNCTUATION. A chunk that is just "." or "," would otherwise become a
 *    caption clip showing a full stop. Also catches a bare musical note.
 *  - STAGE DIRECTIONS. Whisper was trained on subtitle files, so over music it
 *    writes what the subtitler wrote: [Music], (upbeat music), [MUSIC PLAYING].
 *    Square and round brackets are a note ABOUT the audio and never a transcript
 *    of it, so dropping the run cannot cost him a word he said. It has to work
 *    ACROSS words, because this pipeline asks for word-level timestamps and they
 *    split "[MUSIC PLAYING]" into "[MUSIC" and "PLAYING]": the single-token
 *    filter in wordsFromAsrChunks never sees either half, and both used to land
 *    as captions over his backing track.
 *    Musical notes are deliberately NOT treated as a span the same way. Whisper
 *    puts real transcribed words between "♪ ... ♪", and when music is loud that
 *    span can swallow his voice too, so only a note ON ITS OWN is dropped.
 *  - TAIL HALLUCINATIONS. See TAIL_HALLUCINATIONS above.
 *
 * What this deliberately does NOT do is fix general mishearings. Telling
 * "diamonds" from "diamond's" from "die-monds" needs a language model, and there
 * isn't one running locally. Punctuation is also left ALONE on purpose: the
 * chunker reads sentence-ending marks to decide where a caption must break, so
 * stripping them here would silently flatten those boundaries.
 */
export function tidyTranscribedWords(words: readonly TranscribedWord[]): TranscribedWord[] {
  const out: TranscribedWord[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const text = w.text.trim()
    if (!text) continue
    // Checked BEFORE the punctuation drop, so a tag that opens on its own token
    // ("[", "MUSIC", "PLAYING]") still starts a run instead of being thrown away
    // one bracket at a time and leaving the words in the middle behind.
    if (opensTag(text)) {
      const end = tagRunEnd(words, i)
      if (end > i) {
        i = end - 1
        continue
      }
      // Never closed. Fall through and keep it: see tagRunEnd.
    }
    if (isPunctuationOnly(text)) continue
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

  // Then the phrase-sized version of the same loop, which needs the whole list
  // rather than one word at a time.
  const kept = collapsePhraseLoops(out)

  // Trailing invention: only when it sits after a real pause, so a video that
  // really does end on those words keeps them.
  for (let take = Math.min(4, kept.length); take >= 1; take--) {
    const tail = kept.slice(kept.length - take)
    const phrase = tail
      .map((w) => w.text)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9' ]/g, '')
      .trim()
    if (!TAIL_HALLUCINATIONS.includes(phrase)) continue
    const before = kept[kept.length - take - 1]
    if (before && tail[0].startS - before.endS < 0.6) continue // spoken, not invented
    kept.length = kept.length - take
    break
  }
  return kept
}

/**
 * Map slice-relative word times onto the sequence timeline. The transcribed
 * slice starts at the clip's in point, so timeline time = clip start + word
 * time compressed by the clip's playback speed.
 */
export function timelineWords(
  // The emphasis flag rides through because the picker (captions/emphasis.ts)
  // has to run in CLIP time, where the words and the PCM share one clock. Doing
  // it here rather than re-zipping the two lists by index afterwards means there
  // is only ever one mapping, so the flag cannot end up on the wrong word.
  words: readonly (TranscribedWord & { emphasis?: boolean })[],
  clip: Clip,
): CaptionWord[] {
  const speed = Math.abs(clip.speed) || 1
  return words.map((w) => ({
    text: w.text,
    startS: clip.startS + w.startS / speed,
    endS: clip.startS + w.endS / speed,
    ...(w.emphasis ? { emphasis: true } : {}),
  }))
}

/**
 * Decode the clip's trimmed slice ([inS, outS) of its asset) to mono at
 * `sampleRate`. Uses the same cached decode as playback, then a tiny
 * OfflineAudioContext as the resampler. Browser-only.
 *
 * The rate is a parameter because the two things that listen to a clip want
 * different ones: Whisper is fed 16 kHz, and the RNNoise voice detector in
 * captions/voiceActivity.ts has to be fed 48 kHz (its 480-sample frame is 10 ms
 * only at that rate). The decode itself is cached, so the second render costs a
 * resample and nothing more.
 */
export async function extractClipPcmAt(
  asset: MediaAsset,
  clip: Clip,
  sampleRate: number,
): Promise<Float32Array> {
  const buffer = await getAudioBuffer(asset)
  if (!buffer) throw new Error('clip has no decodable audio')
  const durS = Math.max(0, Math.min(clip.outS, buffer.duration) - clip.inS)
  if (durS <= 0) throw new Error('clip trim leaves no audio')
  const frames = Math.max(1, Math.ceil(durS * sampleRate))
  const ctx = new OfflineAudioContext(1, frames, sampleRate)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start(0, clip.inS, durS)
  const rendered = await ctx.startRendering()
  return new Float32Array(rendered.getChannelData(0))
}

/** The clip's audio at Whisper's input rate. */
export function extractClipPcm(asset: MediaAsset, clip: Clip): Promise<Float32Array> {
  return extractClipPcmAt(asset, clip, TRANSCRIBE_SAMPLE_RATE)
}

export interface TranscribeProgress {
  phase: 'model' | 'listening'
  pct: number | null
  /**
   * True only when model files are really being fetched over the network. A load
   * served out of the local cache reports false, so the pill can stop calling
   * every startup a download.
   */
  downloading?: boolean
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

/**
 * How long the LISTENING phase may run before the worker is given up on and
 * terminated. Model loading is deliberately outside it, because the first load
 * is a 300 MB download and has no business sharing a budget with inference.
 *
 * This is a backstop, not the fix. What kept a music-only clip from eating the
 * renderer is the per-chunk token ceiling in transcribeWorker.ts, which bounds
 * the work at the source. This only guarantees that a run which somehow stops
 * making progress ENDS: the worker is terminated, everything it allocated goes
 * with it, and the caption feature is usable again on the next attempt. A hang
 * that allocates fast enough could still outrun it, and saying otherwise would
 * be claiming a safety net that is not there.
 *
 * The budget is generous on purpose, so it can only ever fire on a genuine
 * fault. Whisper base runs comfortably faster than realtime on this machine's
 * GPU and stays inside a few times realtime on the WASM fallback, so ten
 * seconds of allowance per second of audio is far past any healthy run.
 */
const LISTEN_FLOOR_MS = 60_000
const LISTEN_MS_PER_AUDIO_SECOND = 10_000

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
  // Read the length BEFORE the postMessage below, which TRANSFERS the buffer
  // and leaves this Float32Array detached with a length of zero.
  const audioS = pcm.length / TRANSCRIBE_SAMPLE_RATE
  const worker = getWorker()
  let settled = false
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const stopWatchdog = (): void => {
    if (watchdog === null) return
    clearTimeout(watchdog)
    watchdog = null
  }
  // Assigned by the promise executor (which runs synchronously) so that cancel
  // can drop the listeners too, instead of leaving them attached to a worker it
  // just terminated.
  let cleanup = (): void => {}
  let reject!: (reason: unknown) => void
  const promise = new Promise<AsrChunk[]>((res, rej) => {
    reject = rej
    cleanup = (): void => {
      busy = false
      stopWatchdog()
      worker.removeEventListener('message', onMessage as EventListener)
      worker.removeEventListener('error', onError as EventListener)
    }
    // The run stopped making progress. Terminate rather than wait: inference
    // cannot be interrupted any other way, and terminating is what actually
    // hands the memory back.
    const giveUp = (): void => {
      if (settled) return
      settled = true
      cleanup()
      killWorker()
      rej(new Error('The speech model stopped responding'))
    }
    const onMessage = (e: MessageEvent<TranscribeResponse>): void => {
      const msg = e.data
      if (msg.type === 'progress') {
        // The worker announces 'listening' once, when the model is loaded and
        // inference begins. That is the point the budget starts.
        if (msg.phase === 'listening') {
          stopWatchdog()
          watchdog = setTimeout(giveUp, LISTEN_FLOOR_MS + audioS * LISTEN_MS_PER_AUDIO_SECOND)
        }
        onProgress({ phase: msg.phase, pct: msg.pct })
      } else if (msg.type === 'done') {
        settled = true
        cleanup() // keep the worker ALIVE so the model stays loaded for next time
        res(msg.chunks)
      } else if (msg.type === 'warmed') {
        // Not ours. A boot warm can land in the middle of a real run, and this
        // used to be an `else` that treated ANY other message as a failure: it
        // would have killed the worker and failed his caption run outright.
        // Ignore it and keep listening.
      } else {
        settled = true
        cleanup()
        killWorker() // a hard error may have corrupted the pipeline; rebuild next run
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
  // Transferring the PCM avoids copying up to minutes of audio. Guarded because
  // a throw here (a buffer the caller already detached) would leave `busy` stuck
  // true and every later caption run in the session would report that a
  // transcription was already going, with no way back short of a restart.
  try {
    worker.postMessage({ pcm, language }, [pcm.buffer])
  } catch (err) {
    settled = true
    cleanup()
    killWorker()
    reject(err)
  }
  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      cleanup() // drops the listeners and the watchdog, and clears `busy`
      killWorker() // terminate mid-inference (can't interrupt otherwise)
      reject({ cancelled: true })
    },
  }
}

/**
 * Load the speech model WITHOUT transcribing, so the boot card pays for it
 * instead of his first caption run stalling mid-edit. Resolves true once the
 * model is resident.
 *
 * Deliberately outside the `busy` single-flight lock. A warm is not a run: it
 * neither reads nor produces a transcript, and it must never be able to make a
 * real caption run wait or fail. The worker routes it through the SAME `getAsr`
 * cache the run uses, so if a real run starts mid-warm they share one load
 * rather than fetching the model twice.
 *
 * Never rejects. A model that will not load is a caption problem to be reported
 * when he actually asks for captions, not a reason to hold the app shut.
 */
export function warmTranscriber(language: CaptionLanguage = 'en'): Promise<boolean> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = getWorker()
    } catch {
      resolve(false)
      return
    }
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage as EventListener)
      worker.removeEventListener('error', onError as EventListener)
    }
    const onMessage = (e: MessageEvent<TranscribeResponse>): void => {
      // Only 'warmed' is ours. A 'done'/'progress' belongs to a real run that
      // started alongside this warm, and must be left for its own listener.
      if (e.data.type === 'warmed') {
        cleanup()
        resolve(true)
      } else if (e.data.type === 'error') {
        console.warn('OL Premiere: warming the speech model failed', e.data.message)
        cleanup()
        resolve(false)
      }
    }
    const onError = (): void => {
      cleanup()
      resolve(false)
    }
    worker.addEventListener('message', onMessage as EventListener)
    worker.addEventListener('error', onError as EventListener)
    worker.postMessage({ language, warm: true })
  })
}
