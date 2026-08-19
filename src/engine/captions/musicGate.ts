// Telling a SONG from him, which the voice detector next door cannot do and
// was never able to.
//
// His complaint, 2026-08-19: *"It still captures songs too."*
//
// ⛔ WHY THIS EXISTS WHEN `voiceActivity.ts` ALREADY DOES SOMETHING LIKE IT.
// That file reads RNNoise's voice probability and its own measurements say what
// it can and cannot do: a rigid instrumental bed reads **18.3 percent voiced**
// against **17.7 percent for clean speech**. Those overlap, so no threshold on
// that number can separate them, and its header records a research pass where
// every hand rolled feature failed the same way. It is a safety net that stops
// junk leaking into a clip he talks over. It is not, and cannot be, the thing
// that silences a music only clip.
//
// ⛔ AND THE CONCLUSION DRAWN FROM THAT WAS TOO WIDE. What was proven is that
// nothing anybody can WRITE BY HAND separates speech from music. Measured
// 2026-08-19 in `_verify/ast-music-probe.mjs`, a classifier trained on AudioSet
// separates them by a factor of twenty on the very fixtures that killed
// everything else:
//
//     his voice, bed 12 dB LOUDER than him      0.259   <- worst real case
//     his voice under the hallucinating bed     0.324
//     his voice over silence                    0.848
//     camman18, real speech over real music     0.832, 0.570
//     the hallucinating bed alone               0.003
//     music only                                0.002
//     room tone                                 0.009
//     digital silence                           0.013   <- best junk case
//
// ⛔ THE MODEL IS INJECTED, NEVER IMPORTED HERE. Everything in this file is
// arithmetic over scores, so the whole gate can be proved against a hand
// written score track in node, with no wasm, no download and no browser. That
// is the same shape `voiceActivity.ts` uses for its engine and it is the reason
// either of them can be trusted.

import type { TranscribedWord } from './transcribe'

/**
 * Seconds of audio judged at once.
 *
 * Five, because the measurement above was made at five and it is the number the
 * separation is known to hold at. Shorter windows would place a word more
 * precisely and have never been measured, and a gate is not the place to find
 * out. AudioSet's own clips are ten seconds long.
 */
export const WINDOW_S = 5

/**
 * How much speech a window must show before its words are believed.
 *
 * ⛔ FIVE TIMES BELOW THE WORST REAL CASE AND FIVE TIMES ABOVE THE BEST JUNK
 * ONE. The worst file containing his voice scored 0.259 and the best file
 * containing none scored 0.013, so 0.05 is not a tuned number: it is the middle
 * of a gap wide enough that tuning does not matter. If a future measurement
 * narrows that gap, this whole gate should be reconsidered rather than nudged.
 */
export const SPEECH_BAR = 0.05

/**
 * AudioSet labels that mean a person is talking.
 *
 * ⛔ 'Singing' IS NOT ON THIS LIST AND THAT IS THE POINT. A sung lyric is the
 * thing he is complaining about. A song being well transcribed is exactly the
 * failure, so treating singing as speech would keep every word of it.
 */
export const SPEECH_LABELS = [
  'Speech',
  'Male speech, man speaking',
  'Female speech, woman speaking',
  'Narration, monologue',
  'Conversation',
]

/** One score per window, in order, covering the clip from its own zero. */
export interface SpeechTrack {
  readonly scores: Float32Array
  /** Seconds one window covers. */
  readonly windowS: number
}

/** What a classifier has to look like. transformers.js already looks like this. */
export type Classify = (pcm: Float32Array) => Promise<{ label: string; score: number }[]>

/** The best score among the labels that mean somebody is talking. */
export function speechScore(results: readonly { label: string; score: number }[]): number {
  let best = 0
  for (const r of results) {
    if (SPEECH_LABELS.includes(r.label) && r.score > best) best = r.score
  }
  return best
}

/**
 * Score every window of `pcm`, INCLUDING the last part window.
 *
 * ⛔ THE TAIL IS SCORED, AND IT USED NOT TO BE. Skipping it looked like the safe
 * choice and the old comment argued for it: an unscored tail is treated as
 * speech by `scoreForWord`, which is the direction that cannot delete his work.
 *
 * What that actually bought was up to five seconds of invented captions
 * surviving at the END of every single clip, because on a clip that is nothing
 * but music the tail rule keeps whatever the recogniser wrote there. On a
 * timeline of forty short clips that is forty little runs of junk, which is the
 * bug he reported rather than a safety margin.
 *
 * It is also what stopped "this clip has nobody talking in it" from ever being
 * a complete answer, and that answer is worth having: it lets a whole-timeline
 * sweep skip the recogniser on a clip instead of spending a minute listening to
 * a song.
 *
 * The tail is only scored when there is at least a SECOND of it, which is the
 * same floor this function already used to decide it had an opinion at all.
 * Anything shorter is still left unscored and still reads as speech.
 *
 * Yields between windows so a long clip does not lock the interface, the same
 * way the voice analysis does. Resolves null if `signal` aborts.
 */
export async function speechTrackFromPcm(
  classify: Classify,
  pcm: Float32Array,
  sampleRate: number,
  opts: { signal?: { aborted: boolean }; onWindow?: () => Promise<void>; windowS?: number } = {},
): Promise<SpeechTrack | null> {
  const windowS = opts.windowS ?? WINDOW_S
  const size = Math.round(windowS * sampleRate)
  if (size <= 0 || pcm.length < size) {
    // Under one window there is nothing to compare against. One score for the
    // whole thing is still worth having: a two second clip of pure music is
    // exactly the case he keeps hitting.
    if (pcm.length < sampleRate) return null
    const res = await classify(pcm)
    return { scores: Float32Array.from([speechScore(res)]), windowS: pcm.length / sampleRate }
  }
  const count = Math.floor(pcm.length / size)
  // The tail sits at index `count`, which is exactly where `scoreForWord` looks
  // for a word inside it, so nothing downstream needs to know it is shorter.
  const tail = pcm.length - count * size
  const scoreTail = tail >= sampleRate
  const scores = new Float32Array(count + (scoreTail ? 1 : 0))
  for (let i = 0; i < count; i++) {
    if (opts.signal?.aborted) return null
    const res = await classify(pcm.subarray(i * size, (i + 1) * size))
    scores[i] = speechScore(res)
    if (opts.onWindow) await opts.onWindow()
  }
  if (scoreTail) {
    if (opts.signal?.aborted) return null
    scores[count] = speechScore(await classify(pcm.subarray(count * size)))
  }
  return { scores, windowS }
}

/**
 * True when not one window in the clip shows anybody talking.
 *
 * Since the tail is scored too, this covers the WHOLE clip rather than most of
 * it, which is what makes it safe to act on: a caller can skip the recogniser
 * outright and know the answer matches what `dropWordsInMusic` would have done
 * to every word it returned.
 */
export function isPureMusic(track: SpeechTrack, bar = SPEECH_BAR): boolean {
  if (track.scores.length === 0) return false
  for (const s of track.scores) if (s >= bar) return false
  return true
}

/**
 * The best score of every window a word touches.
 *
 * ⛔ THE BEST, NOT THE ONE IT STARTS IN. A word straddling a boundary belongs to
 * whichever side is talking, and the cost of being wrong is asymmetric: keeping
 * a junk word is an annoyance he deletes, deleting a real word is his work gone.
 * A word past the last scored window scores 1, so an unscored tail keeps
 * everything.
 */
export function scoreForWord(track: SpeechTrack, startS: number, endS: number): number {
  const first = Math.floor(startS / track.windowS)
  const last = Math.floor(Math.max(startS, endS - 1e-6) / track.windowS)
  let best = 0
  let seen = false
  for (let i = first; i <= last; i++) {
    if (i < 0 || i >= track.scores.length) continue
    seen = true
    if (track.scores[i] > best) best = track.scores[i]
  }
  return seen ? best : 1
}

/**
 * Drop the words that sit in music.
 *
 * ⛔ THIS ONE IS ALLOWED TO TAKE THE WHOLE TRANSCRIPT, AND ITS NEIGHBOUR IS NOT.
 * `dropWordsWithoutVoice` refuses to remove the majority of a run, deliberately,
 * because its instrument overlaps with speech and a big decision made on a
 * doubtful reading costs him a sentence. This instrument does not overlap: the
 * worst file containing his voice outscores the best file containing none by
 * twenty times. On a clip where every single window says nobody is talking,
 * every word in it is invented, and handing him a caption track of the song is
 * the bug he reported. **A refusal to act on a confident reading is not caution,
 * it is the feature not working.**
 *
 * ⛔ A NULL TRACK KEEPS EVERY WORD. No opinion is never an opinion against him.
 */
export function dropWordsInMusic(
  words: readonly TranscribedWord[],
  track: SpeechTrack | null,
  bar = SPEECH_BAR,
): TranscribedWord[] {
  if (!track || track.scores.length === 0) return [...words]
  return words.filter((w) => scoreForWord(track, w.startS, w.endS) >= bar)
}
