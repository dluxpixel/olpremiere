// Telling his VOICE from the music under it, so a caption run stops writing
// words over an instrumental intro.
//
// THE SIGNAL IS ALREADY IN THE APP. denoise.ts runs RNNoise (the model OBS's
// "Noise Suppression" filter uses) over a clip's PCM and throws away what
// `processFrame` returns. That return value is the model's own voice-activity
// probability, 0 to 1, for the 10 ms frame it just saw. Reading it is not a new
// model and not a new dependency: the same wasm was already computing it and
// the app was dropping it on the floor.
//
// Why there is no hand-rolled DSP here. A research pass measured the obvious
// features and every one of them failed on the case that actually matters,
// which is speech OVER music, not speech VERSUS music:
//  - 4 Hz syllabic modulation scored the MUSIC higher (0.384) than synthetic
//    speech (0.301), because a 110-130 BPM bed puts its modulation peak dead on
//    the syllable rate.
//  - Low-energy frame ratio failed in the DANGEROUS direction: speech over
//    music measured LOWER than music alone, so it would have voted delete on
//    his real sentences.
//  - Zero crossing rate (38% error), pitch autocorrelation (locks onto the more
//    periodic source, which is the music) and modulation-spectrum flatness (its
//    separation vanished once 18 ms of timing jitter was added to the music)
//    all failed too.
//  - Scheirer and Slaney's own 13-feature classifier gets about 65% on this
//    three-way problem. Hand-rolled DSP does not solve it.
// So the only opinion in this file is the model's, plus a deliberately timid
// rule about when to act on it.
//
// Two numbers that are load-bearing:
//  - 48 kHz, NOT the 16 kHz Whisper is fed. RNNoise's frameSize is 480 samples
//    and the net wants 10 ms frames, so the PCM has to be rendered at 48 kHz.
//  - > 0.9, not > 0.5. Room tone at -48 dBFS measured a MEDIAN probability of
//    0.474 and yet ZERO frames above 0.9, and white noise measured a median of
//    0.613 with a MAX of 0.806. The high bar is the whole trick: it is what
//    makes "quiet" safe to call quiet.
//
// Fraction of frames above 0.9, measured through this exact path (48 kHz,
// 0x7fff scaling) in headless chromium:
//    digital silence     0.000
//    white noise         0.000
//    instrumental bed    0.004
//    speech              0.177
//    SPEECH OVER MUSIC   0.417
// That last line is the one that matters, and it is why this feature exists at
// all. Every hand-rolled feature listed above failed because a mixture looked
// less like speech than clean speech did. This one goes the other way: his
// voice over a music bed is the case the model is MOST confident about, more
// confident than clean speech, while the bed on its own is a hundred times
// quieter. The failure mode that would cost him work is the one it is best at.
//
// Cost, measured in headless chromium on his machine (not extrapolated from
// node): 77 ms per second of audio, about 13x realtime, plus 50 ms to load the
// wasm and 28 ms for the extra 48 kHz render. A 60 s clip is 4.6 s of work.
// That is why the analysis is started ALONGSIDE the Whisper worker rather than
// before it (see transcribeActions.wordsForClip) and why the loop yields to the
// event loop: the wait is hidden behind an inference that takes longer, and the
// progress pill keeps painting instead of freezing for five seconds.

import { PCM_SCALE, ensureRnnoise, type DenoiseEngine } from '../denoise'
import type { Clip, MediaAsset } from '../types'
import { extractClipPcmAt, type TranscribedWord } from './transcribe'
import { contextWindowFor } from './voiceContext'

/** RNNoise wants 10 ms frames, and frameSize is 480 samples. */
export const VOICE_SAMPLE_RATE = 48000

/** Above this, the frame contains a voice. Deliberately not 0.5: see the header. */
export const VOICE_THRESHOLD = 0.9

/** A quiet stretch shorter than this says nothing; anything can go quiet for half a second. */
export const MIN_QUIET_RUN_S = 1.0

/** How far the quiet has to reach past a word, on BOTH sides, before it counts against it. */
export const QUIET_MARGIN_S = 0.3

/** Under this, there is not enough clip for the statistic to mean anything. */
export const MIN_ANALYSED_CLIP_S = 3

/** How long the frame loop may run before letting the browser paint. */
const SLICE_MS = 12

/** Voice probability per frame, in order. */
export interface VoiceTrack {
  readonly probs: Float32Array
  /** Seconds of audio one frame covers. */
  readonly frameS: number
  /**
   * Where the CLIP begins inside the analysed audio. The window is widened with
   * the recording either side of the cut (see voiceContext.ts), so a word at
   * clip time t sits at t + offsetS in these frames. Zero when nothing was
   * added, which is every clip already long enough to judge on its own.
   */
  readonly offsetS: number
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * RNNoise's voice probability for every whole frame of `pcm`.
 *
 * The engine is injected so this is testable with a deterministic fake instead
 * of the wasm. A partial tail frame is skipped rather than zero-padded: padding
 * would read as quiet anyway, and the run at the end of a clip is already
 * treated as open-ended by the rule below.
 *
 * Yields to the event loop every SLICE_MS so a minute of audio does not lock the
 * UI. Resolves null if `signal` aborts mid-analysis.
 */
export async function voiceTrackFromPcm(
  engine: DenoiseEngine,
  pcm: Float32Array,
  sampleRate: number,
  opts: { signal?: { aborted: boolean }; onSlice?: () => Promise<void>; sliceMs?: number } = {},
): Promise<VoiceTrack | null> {
  const size = engine.frameSize
  const total = Math.floor(pcm.length / size)
  const probs = new Float32Array(total)
  const breathe = opts.onSlice ?? nextTask
  const sliceMs = opts.sliceMs ?? SLICE_MS
  const state = engine.createDenoiseState()
  try {
    const frame = new Float32Array(size)
    let sliceStart = performance.now()
    for (let f = 0; f < total; f++) {
      const base = f * size
      // RNNoise reads 16-bit-PCM-range floats, the same scaling denoiseChannel uses.
      for (let k = 0; k < size; k++) frame[k] = pcm[base + k]! * PCM_SCALE
      probs[f] = state.processFrame(frame)
      if (performance.now() - sliceStart >= sliceMs) {
        await breathe()
        if (opts.signal?.aborted) return null
        sliceStart = performance.now()
      }
    }
  } finally {
    state.destroy()
  }
  // Zero here: this builds a track from raw PCM and knows nothing about clips.
  // voiceTrackForClip stamps the real offset on after widening the window.
  return { probs, frameS: size / sampleRate, offsetS: 0 }
}

/**
 * The voice track for a clip's trimmed slice, or null when it cannot be had.
 *
 * NEVER rejects and never throws. A browser with wasm blocked, an asset that
 * will not decode, an aborted run: every one of them means "no opinion", and no
 * opinion must leave his captions exactly as Whisper heard them.
 */
export async function voiceTrackForClip(
  asset: MediaAsset,
  clip: Clip,
  signal?: { aborted: boolean },
): Promise<VoiceTrack | null> {
  try {
    const engine = await ensureRnnoise()
    if (signal?.aborted) return null
    // ⛔ WIDEN THE WINDOW WITH THE RECORDING EITHER SIDE OF THE CUT. Measured on
    // his own project, 2026-08-12: 30 of his 44 clips are under three seconds,
    // median 1.43 s, and `dropWordsWithoutVoice` hands every word straight back
    // when the analysed audio is shorter than MIN_ANALYSED_CLIP_S. **So on two
    // thirds of his timeline this filter did nothing at all** and whatever the
    // recogniser imagined over the music stayed in.
    //
    // The floor is NOT lowered: a short window really does make the statistic
    // meaningless, and every guard in this file leans one way on purpose because
    // a stray caption is annoying and a deleted sentence is his work gone. This
    // buys the confidence the floor was asking for instead of waiving it.
    const win = contextWindowFor(clip.inS, clip.outS, asset.durationS)
    const pcm = await extractClipPcmAt(asset, { ...clip, inS: win.fromS, outS: win.toS }, VOICE_SAMPLE_RATE)
    if (signal?.aborted) return null
    const track = await voiceTrackFromPcm(engine, pcm, VOICE_SAMPLE_RATE, { signal })
    return track && { ...track, offsetS: win.offsetS }
  } catch (err) {
    console.warn('OL Premiere: voice detection unavailable, captioning everything Whisper heard', err)
    return null
  }
}

/** A stretch with no voiced frame in it, in clip-relative seconds. */
interface QuietSpan {
  fromS: number
  toS: number
}

/**
 * The quiet stretches long enough to be worth believing.
 *
 * A span touching the start or the end of the clip reaches to infinity on that
 * side. There is no audio out there at all, and no audio is certainly not his
 * voice, so an intro that begins at t=0 gets the same treatment as one in the
 * middle. Without this the commonest case of all, music before he starts
 * talking, could never be caught: nothing can extend 300 ms before t=0.
 *
 * The LENGTH test still uses the measured span only. Infinity is allowed to
 * satisfy the margin, never to manufacture the second of evidence.
 */
function qualifyingQuietSpans(track: VoiceTrack): QuietSpan[] {
  const { probs, frameS } = track
  const n = probs.length
  const spans: QuietSpan[] = []
  let f = 0
  while (f < n) {
    if (probs[f]! > VOICE_THRESHOLD) {
      f++
      continue
    }
    let end = f
    while (end < n && probs[end]! <= VOICE_THRESHOLD) end++
    if ((end - f) * frameS >= MIN_QUIET_RUN_S) {
      spans.push({
        fromS: f === 0 ? -Infinity : f * frameS,
        toS: end === n ? Infinity : end * frameS,
      })
    }
    f = end
  }
  return spans
}

/**
 * Reasons to keep a word the audio has already voted against. Every one of them
 * is a tie-breaker, and every tie-breaker breaks the same way: keep it.
 */
function keepAnyway(words: readonly TranscribedWord[], drop: boolean[], i: number): boolean {
  const last = words.length - 1
  // A LONE word between two survivors is never dropped, whatever the audio
  // says. One word missing out of the middle of a sentence is the worst thing
  // this feature could do to him, and a real junk stretch is never one word
  // wide with speech either side of it.
  if (i > 0 && i < last && !drop[i - 1] && !drop[i + 1]) return true
  // A survivor within 300 ms means the recogniser put this word right up
  // against speech. Whisper's word timings are worth a couple of hundred
  // milliseconds at best, so that is too close to call.
  for (let j = i - 1; j >= 0; j--) {
    if (drop[j]) continue
    if (words[i]!.startS - words[j]!.endS < QUIET_MARGIN_S) return true
    break
  }
  for (let j = i + 1; j <= last; j++) {
    if (drop[j]) continue
    if (words[j]!.startS - words[i]!.endS < QUIET_MARGIN_S) return true
    break
  }
  return false
}

/**
 * Drop the words that sit in silence, keep everything else. Pure.
 *
 * The bar is set high ON PURPOSE. A junk caption over his intro music is
 * annoying; a missing caption over a sentence he actually said is the app
 * losing his work. So a word only goes when ALL of this holds:
 *  - it sits in a quiet run of at least MIN_QUIET_RUN_S, and
 *  - that run reaches QUIET_MARGIN_S past the word on BOTH sides, and
 *  - the clip is long enough for the statistic to mean anything, and
 *  - it has no surviving neighbour within QUIET_MARGIN_S, and
 *  - it is not a lone word between two survivors.
 *
 * The neighbour test is run to a fixpoint, so a word rescued on one pass can
 * rescue the next one along. That makes a densely packed run of junk butted up
 * against real speech survive whole, which is the right way to lose: nobody,
 * including the model, can tell where his sentence starts in there.
 *
 * The last two guards are the important ones, and they exist because of a
 * measurement that nearly sank this whole idea.
 *
 * A clip of DRY synthetic speech, talking start to finish with no music under
 * it, reported one unbroken 18.7 second stretch of "no voice" out of 20
 * seconds, and only 0.052 of its frames above 0.9. RNNoise is a noise
 * SUPPRESSION model: its confidence is calibrated on voice in a mix, and the
 * cleaner and more synthetic the input, the less sure it gets. The same voice
 * with a music bed under it measured 0.522. So the model is at its best exactly
 * where this feature is needed and at its worst where it is not needed at all,
 * which is lucky, but a rule that trusted it blindly would have deleted an
 * entire dry voiceover.
 *
 * Hence: it may only ever TRIM. If it wants more than half a clip's words, it is
 * not trimming junk off a take, it is disagreeing with the recogniser about the
 * whole clip, and in that argument the recogniser wins. Together with the
 * no-voice-anywhere check (a flat zero is what a wrong sample rate, wrong
 * scaling, or a wasm that loaded but does nothing all look like) that is two
 * guards pointing the same way. They overlap, deliberately: both can only ever
 * hand words back.
 *
 * The price is known and accepted. A clip of PURE instrumental, with no voice in
 * it at all, clears 0.9 on only 0.004 of its frames, so one shorter than about
 * ten seconds can land on a flat zero and keep its junk captions. That is the
 * failure worth having: a stray caption over a music-only clip is annoying, a
 * deleted sentence is his work gone.
 */
export function dropWordsWithoutVoice(
  words: readonly TranscribedWord[],
  track: VoiceTrack,
): TranscribedWord[] {
  const n = track.probs.length
  if (words.length === 0 || n === 0) return [...words]
  if (n * track.frameS < MIN_ANALYSED_CLIP_S) return [...words]

  let voiced = 0
  for (let f = 0; f < n; f++) if (track.probs[f]! > VOICE_THRESHOLD) voiced++
  if (voiced === 0) return [...words]

  const spans = qualifyingQuietSpans(track)
  if (spans.length === 0) return [...words]

  // Word times are CLIP-relative; the spans are relative to the analysed window,
  // which now starts before the clip does. Without the shift every word would be
  // compared against frames from the wrong moment.
  const off = track.offsetS
  const drop = words.map((w) =>
    spans.some((s) => s.fromS <= w.startS + off - QUIET_MARGIN_S && s.toS >= w.endS + off + QUIET_MARGIN_S),
  )
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < words.length; i++) {
      if (!drop[i] || !keepAnyway(words, drop, i)) continue
      drop[i] = false
      changed = true
    }
  }

  // Trimming only. Wanting the majority of a transcript is the signature of a
  // model that has misread the clip, not of junk at the edges of a take.
  const going = drop.filter(Boolean).length
  if (going * 2 > words.length) return [...words]
  return words.filter((_, i) => !drop[i])
}
