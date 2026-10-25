// When a word is SAID, as opposed to when the recogniser says it was.
//
// His words, 2026-10-04: *"the word spacing is just really bad"*, and asked
// which: *"Timing between captions"*. Captions came and went at the wrong
// moments.
//
// ⛔ MEASURED, NOT GUESSED, 2026-10-05. His own corrected caption text was
// force-aligned to his own voice (wav2vec2, a test-only model that never ships)
// across seven of his projects, and every word large-v3-turbo timed through the
// app's real path ("Caption every clip") was set against it. 630 words:
//
//   626 of them started LATE, median 0.19 s, 9 in 10 between 0.09 s and
//   0.34 s late. Only 3 were early by more than a frame. The word ENDS ran
//   late by the same amount, median 0.20 s.
//
// So every caption came on screen about a fifth of a second AFTER he started
// the word and stayed on into the next one: the caption on screen held the word
// he was saying for only 51 percent of the time, and for nearly all the rest it
// was still showing the word before. The old small.en model was worse (48).
//
// The lag is the recogniser's, not the pipeline's: it is already in the raw
// timestamps, before any tidying, filtering or grouping, and every project has
// it (medians 0.15 to 0.22 s). So it is taken off by its measured size, set on
// four of the projects (0.18 s) and checked on the other three. Then two
// things the audio knows better than the timestamps put each edge right: where
// his voice comes back on after a pause, and the dip in his loudness where one
// word runs into the next. Replayed through the app's own pipeline on all
// seven, the caption on screen holds the word he is saying 86 percent of the
// time, captions more than 0.1 s late fell from 387 of 438 to 83, and the three
// held out projects alone went from 53 to 84 percent.
//
// Pure: no DOM, no store.

import type { TranscribedWord } from './transcribe'
import { VOICE_THRESHOLD, type VoiceTrack } from './voiceActivity'

/**
 * Pull every word earlier by the recogniser's measured lag, in clip seconds.
 *
 * Nothing moves before the start of the clip: a word cannot have been said
 * before the audio began. The order and the length of each word are kept, and
 * a word that would be squeezed to nothing against the start of the clip keeps
 * a sliver of its own, so no word is ever lost here.
 *
 * ⛔ A WORD THE ALIGNER TIMED IS NEVER MOVED. Its time comes from the sound
 * (ctcAlign.ts, `aligned`) and not from the recogniser's cross-attention, so it
 * carries none of the lag this takes off: pulling it back by 0.18 s again would
 * put it 0.18 s EARLY. Measured on SAPI speech with known word times, an aligned
 * word starts within 15 ms (median) of the truth where the raw recogniser time is
 * 0.19 s late. A word the aligner could not time (a window it did not trust, or
 * one that moved too far) is still corrected like before, but never to before an
 * aligned word's start that came ahead of it.
 */
export function correctWordLag<T extends TranscribedWord>(words: readonly T[], lagS: number): T[] {
  const out: T[] = words.map((w) => ({ ...w }))
  if (!(lagS > 0)) return out
  const order = out.map((_, i) => i).sort((a, b) => out[a]!.startS - out[b]!.startS)
  let floor = 0
  for (const i of order) {
    const w = out[i]!
    if (w.aligned) {
      floor = Math.max(floor, w.startS)
      continue
    }
    const len = Math.max(0, w.endS - w.startS)
    const startS = Math.max(floor, w.startS - lagS)
    w.startS = startS
    w.endS = Math.max(startS + Math.min(len, MIN_WORD_S), w.endS - lagS)
    floor = startS
  }
  return out
}

/** The least a word keeps when the start of the clip squeezes it. */
const MIN_WORD_S = 0.05

/** The loudness windows meetAtDips is measured on: 10 ms, finer than any word edge it moves. */
export const DIP_ENVELOPE_HOP_S = 0.01

/** How far either way of the recogniser's boundary a loudness dip is looked for. */
export const DIP_REACH_S = 0.08

/** How much quieter than the loudest moment on EACH side a dip must be to count, in dB. */
export const DIP_DEPTH_DB = 10

/**
 * Move the boundary between two words he ran together onto the dip in his
 * loudness between them. Pure.
 *
 * Inside a phrase his voice never stops, so the voice detector cannot say where
 * one word ends, but his loudness almost always dips there: a consonant, a
 * breath of a gap. After the lag is taken off, the recogniser's boundary sits
 * within about a tenth of a second of the real one, so a clear dip within
 * DIP_REACH_S of it is taken to be the real one, and the two words meet there.
 * Measured on four of his projects, this took the caption on screen holding the
 * word he is saying from 84 to 87 percent of the time.
 *
 * Only words that touch (the recogniser's own tiling, at most 50 ms apart) are
 * moved, never a pause, and each keeps at least MIN_WORD_S, so no word is lost
 * and no pause is closed. `envelope` is RMS per `hopS` of the clip's audio.
 *
 * ⛔ A BOUNDARY THAT HAS AN ALIGNED WORD ON EITHER SIDE IS LEFT WHERE THE ALIGNER
 * PUT IT. The dip repairs the recogniser's guess (0.1 s off); the aligner is
 * 0.015 s off, and a loudness dip is not where a word begins ("sixty" has two
 * dips, "so" opens on a rise). Measured on SAPI speech with known word onsets
 * (three recordings, real Whisper timings, 837 letter words, 18 number words,
 * _verify/aligner), with the dips on, aligned words started within 50 ms of the
 * truth 84.5 percent of the time (number words 72.2 percent); with them off,
 * 93.1 percent (83.3 percent), and the word END within 50 ms went from 72.9 to
 * 82.4 percent. Words the aligner did not time still meet at the dips.
 */
export function meetAtDips<T extends TranscribedWord>(words: readonly T[], envelope: ArrayLike<number>, hopS: number): T[] {
  const out: T[] = words.map((w) => ({ ...w }))
  const n = envelope.length
  if (out.length < 2 || n === 0 || !(hopS > 0)) return out
  const db = (k: number): number => 20 * Math.log10(envelope[k]! + 1e-9)
  const frameOf = (t: number): number => Math.round(t / hopS - 0.5)
  const timeOf = (k: number): number => (k + 0.5) * hopS
  const reach = Math.max(1, Math.round(DIP_REACH_S / hopS))
  const order = out.map((_, i) => i).sort((a, b) => out[a]!.startS - out[b]!.startS)
  for (let j = 1; j < order.length; j++) {
    const a = out[order[j - 1]!]!
    const b = out[order[j]!]!
    if (b.startS - a.endS > MIN_WORD_S) continue
    if (a.aligned || b.aligned) continue
    const x = frameOf(b.startS)
    const lo = Math.max(0, frameOf(a.startS + MIN_WORD_S), x - reach)
    const hi = Math.min(n - 1, frameOf(b.endS - MIN_WORD_S), x + reach)
    if (hi <= lo) continue
    let m = lo
    for (let k = lo; k <= hi; k++) if (db(k) < db(m)) m = k
    // The loudest moment on each side, looking a little past the search.
    const side = reach + Math.round(0.1 / hopS)
    let left = -Infinity
    for (let k = Math.max(0, m - side); k < m; k++) left = Math.max(left, db(k))
    let right = -Infinity
    for (let k = m + 1; k <= Math.min(n - 1, m + side); k++) right = Math.max(right, db(k))
    if (Math.min(left, right) - db(m) < DIP_DEPTH_DB) continue
    const t = timeOf(m)
    a.endS = t
    b.startS = t
  }
  return out
}

/**
 * How far a phrase opening word may move to meet his voice. Wider than the
 * spread the measurement left after the lag correction (9 in 10 words within
 * about 0.15 s), narrower than a short word, so it reaches his voice coming on
 * and never the start of the NEXT word.
 */
export const ONSET_REACH_S = 0.2

/**
 * How long his voice has to have been off for it coming back on to be the
 * start of a word, rather than a stop consonant inside one. A "t" or a "k"
 * silences the voice for 50 to 80 ms; a breath between phrases is longer.
 */
export const ONSET_QUIET_S = 0.1

/**
 * Put a word that opens a phrase where his voice comes on. Pure.
 *
 * A caption appearing before he speaks is a word on screen he has not said, and
 * one appearing after is the screen behind him. The voice detector sees the
 * moment his voice comes on after a pause to within a frame, which no word
 * timestamp does, so a word whose start lies within ONSET_REACH_S of such a
 * moment is moved onto it, either way. The word before it is ended there if it
 * ran on into it.
 *
 * Words inside a phrase have no such moment (his voice never stops between
 * them), so they keep the corrected timing. And the same guard as
 * trimWordsToVoice: if the detector hears his voice in fewer than half of the
 * clip's words, it is not hearing this voice well enough to place any of them.
 *
 * ⛔ A WORD THE ALIGNER TIMED KEEPS ITS START. The aligner reads the sound itself
 * and puts a word's start on the sound to a frame; the voice detector here
 * does it only to about a frame too, and was built to rescue the recogniser's
 * guesses, which an aligned word is not. Measured on the phrase starts after a
 * pause in the synthetic speech, whose true onsets are known (n=52, within
 * 50 ms of the truth): the aligner alone 96.2%, the snap on top of it 84.6%.
 * ("Bias" in the harness tables is the median of start minus true start, so a
 * minus is early: the aligner alone sat 10 ms early, bias -10 ms. The snap's own
 * bias was not kept, the stored run having been made with the guard below; the
 * +20 ms beside it in those tables is the old chain on Whisper's words with no
 * aligner, 20 ms late.) So the snap skips an aligned word's start. It still
 * ends the word BEFORE at the moment his voice went off: that is an end move,
 * and ends are the trim's business (see state/transcribeActions.ts).
 */
export function snapOnsetsToVoice<T extends TranscribedWord>(
  words: readonly T[],
  track: VoiceTrack,
  opts: { reachS?: number; quietS?: number } = {},
): T[] {
  const out: T[] = words.map((w) => ({ ...w }))
  const { probs, frameS } = track
  const n = probs.length
  if (out.length === 0 || n === 0 || !(frameS > 0)) return out
  const off = track.offsetS
  const frameAt = (t: number): number => Math.floor((t + off) / frameS + 1e-6)
  const timeOf = (f: number): number => f * frameS - off
  const voiced = (f: number): boolean => f >= 0 && f < n && probs[f]! > VOICE_THRESHOLD
  const heardIn = (w: TranscribedWord): boolean => {
    for (let f = Math.max(0, frameAt(w.startS)); f < Math.min(n, Math.ceil((w.endS + off) / frameS)); f++) if (voiced(f)) return true
    return false
  }
  if (out.filter(heardIn).length * 2 < out.length) return out

  const quiet = Math.max(1, Math.round((opts.quietS ?? ONSET_QUIET_S) / frameS))
  /** His voice comes on at frame f after at least `quiet` frames without it. */
  const comesOn = (f: number): boolean => {
    if (!voiced(f) || f - quiet < 0) return false
    for (let k = f - quiet; k < f; k++) if (voiced(k)) return false
    return true
  }
  const order = out.map((_, i) => i).sort((a, b) => out[a]!.startS - out[b]!.startS)
  for (let k = 0; k < order.length; k++) {
    const w = out[order[k]!]!
    const prev = k > 0 ? out[order[k - 1]!]! : null
    const next = k + 1 < order.length ? out[order[k + 1]!]! : null
    const at = frameAt(w.startS)
    const reach = Math.round((opts.reachS ?? ONSET_REACH_S) / frameS)
    let best = -1
    for (let d = 0; d <= reach && best < 0; d++) {
      if (comesOn(at - d)) best = at - d
      else if (d > 0 && comesOn(at + d)) best = at + d
    }
    if (best < 0) continue
    const onS = timeOf(best)
    // Where his voice went off before it came back on: the word before ended
    // there, whatever its timestamp says.
    let q = best - 1
    while (q > 0 && !voiced(q - 1)) q--
    const offS = timeOf(q)
    // Never past the start of the next word, never so late that the word is
    // gone, and only when the quiet comes AFTER the word before has begun, so
    // that word keeps its own voice and the two can never run together.
    if (onS >= w.endS - MIN_WORD_S || (next && onS >= next.startS) || (prev && offS <= prev.startS + MIN_WORD_S)) continue
    if (!w.aligned) w.startS = Math.max(0, onS)
    if (prev) prev.endS = Math.min(prev.endS, offS)
  }
  return out
}
