// How much audio the voice detector gets to look at.
//
// His words, 2026-08-12: "it still sometimes even adds imaginary words, maybe
// even from the music."
//
// ⛔ MEASURED, not guessed. His project is 44 clips, 30 of them under three
// seconds, median 1.43 s. `dropWordsWithoutVoice` returns every word untouched
// when the analysed audio is shorter than MIN_ANALYSED_CLIP_S, so on TWO THIRDS
// of his timeline the filter that removes imagined words did nothing at all.
//
// The floor itself is right and is not being lowered. Its own comment explains
// the trade honestly: a short window makes the statistic meaningless, and every
// guard in voiceActivity.ts leans the same way on purpose, because a stray
// caption is annoying and a deleted sentence is his work gone. That reasoning
// still holds. What was wrong was the assumption underneath it, that short clips
// are the edge case.
//
// So: give the detector MORE AUDIO rather than a lower bar. A 1.4 s clip was cut
// out of a 278 s recording and the audio either side of the cut is sitting right
// there. Analysing it costs nothing in accuracy and buys the confidence the floor
// was asking for.

/**
 * Seconds of source audio the detector wants before it will judge anything.
 *
 * Twelve because `voiceActivity.ts` records that a pure instrumental clip clears
 * the 0.9 bar on only 0.004 of its frames, so "shorter than about ten seconds can
 * land on a flat zero" and keep its junk captions. Twelve clears that with a
 * little room, and it CAPS the work: voice analysis costs about 77 ms per second
 * of audio, so a bounded window means a caption sweep cannot get slower per clip
 * as his recordings get longer.
 */
export const VOICE_CONTEXT_TARGET_S = 12

export interface ContextWindow {
  /** Source seconds to start the analysed window at. */
  fromS: number
  /** Source seconds to end it at. */
  toS: number
  /**
   * Where the CLIP begins inside that window. A word at clip time t sits at
   * t + offsetS in the analysed audio, and without this every word would be
   * compared against the wrong frames.
   */
  offsetS: number
}

/**
 * Widen a clip's audio window with the recording either side of it, up to
 * `VOICE_CONTEXT_TARGET_S`, without ever running off the ends of the source.
 *
 * Padding is split evenly, and whatever one side cannot give is taken from the
 * other, so a clip at the very start of a recording still gets a full window
 * instead of half of one.
 */
export function contextWindowFor(inS: number, outS: number, sourceDurationS: number): ContextWindow {
  const srcEnd = Math.max(0, sourceDurationS)
  const from = Math.max(0, Math.min(inS, srcEnd))
  const to = Math.max(from, Math.min(outS, srcEnd))
  const want = VOICE_CONTEXT_TARGET_S - (to - from)
  if (want <= 0) return { fromS: from, toS: to, offsetS: 0 }

  // Ask for half either side, then spend what one side refuses on the other.
  const left = Math.min(want / 2, from)
  const right = Math.min(want - left, srcEnd - to)
  // Snapped at the ends. Subtracting these in floating point leaves dust like
  // 7e-16, and a window that starts a hair before zero would shift every word
  // onto the wrong frame for the sake of a rounding error.
  const snap = (v: number, edge: number) => (Math.abs(v - edge) < 1e-9 ? edge : v)
  const fromS = snap(Math.max(0, from - Math.min(want - right, from)), 0)
  const toS = snap(Math.min(srcEnd, to + right), srcEnd)
  return { fromS, toS, offsetS: from - fromS }
}
