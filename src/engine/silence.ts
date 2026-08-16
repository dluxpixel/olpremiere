// Which parts of a clip are him not talking.
//
// The single largest hand-cost in a voiceover edit is cutting dead air, and it
// is the one job he does on every video. Every short-form editor has this.
//
// ⛔ PURE, AND DELIBERATELY SO. The whole decision about what gets cut lives in
// this function, over word timings and a duration, with no store and no DOM.
// Anything less and the only way to check the arithmetic is to drive a browser
// and listen to it.
//
// The words come from the SAME door auto-caption uses (`wordsForClip`), so a
// clip is never transcribed twice for two features.

/** A word, reduced to the only two things this cares about. Clip-local seconds. */
export interface SpokenWord {
  startS: number
  endS: number
}

export interface SilenceOptions {
  /** Gaps shorter than this are breath and rhythm. They stay. */
  minGapS: number
  /**
   * Air kept on each side of a cut.
   *
   * ⛔ CUTTING AT THE EXACT WORD EDGE SOUNDS CLIPPED. The consonant at the end
   * of a word runs past where the transcriber says the word ended, so a cut on
   * the boundary eats the tail of it and the result sounds like a bad phone
   * call. This is what buys the edit back its air.
   */
  padS: number
}

export const SILENCE_DEFAULTS: SilenceOptions = { minGapS: 0.35, padS: 0.08 }

/** A stretch to REMOVE, in clip-local seconds. */
export interface CutRange {
  startS: number
  endS: number
}

/**
 * The stretches of `[0, durationS]` with no speech in them, worth cutting.
 *
 * Includes the run before the first word and after the last, which are usually
 * the longest two and the ones a "cut the gaps between words" rule misses.
 *
 * Returns ranges in order, non-overlapping, all strictly positive in length.
 */
export function silentRanges(
  words: readonly SpokenWord[],
  durationS: number,
  opts: SilenceOptions = SILENCE_DEFAULTS,
): CutRange[] {
  if (!(durationS > 0)) return []
  const minGap = Math.max(0, opts.minGapS)
  const pad = Math.max(0, opts.padS)

  // No speech at all is not "cut the whole clip". That is a decision about the
  // clip, not about silence in it, and it belongs to whoever called.
  if (words.length === 0) return []

  // Merge the speech first: transcribers overlap words, and an un-merged list
  // produces negative gaps that then read as cuts.
  const speech: CutRange[] = []
  for (const w of [...words].sort((a, b) => a.startS - b.startS)) {
    const s = Math.max(0, Math.min(w.startS, durationS))
    const e = Math.max(s, Math.min(w.endS, durationS))
    const last = speech[speech.length - 1]
    if (last && s <= last.endS) last.endS = Math.max(last.endS, e)
    else speech.push({ startS: s, endS: e })
  }

  const gaps: CutRange[] = []
  const push = (startS: number, endS: number) => {
    if (endS - startS > minGap) gaps.push({ startS, endS })
  }
  push(0, speech[0].startS)
  for (let i = 1; i < speech.length; i++) push(speech[i - 1].endS, speech[i].startS)
  push(speech[speech.length - 1].endS, durationS)

  // Shrink each cut by the pad, then drop the ones the pad swallowed. The pad
  // comes off the speech side only at the head and the tail: there is no word
  // before the first one to protect.
  const out: CutRange[] = []
  for (const g of gaps) {
    const atHead = g.startS <= 0
    const atTail = g.endS >= durationS
    const startS = atHead ? 0 : g.startS + pad
    const endS = atTail ? durationS : g.endS - pad
    if (endS - startS > 1e-3) out.push({ startS, endS })
  }
  return out
}

/** Total seconds `silentRanges` would remove. What the toast reports. */
export function cutTotalS(ranges: readonly CutRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.endS - r.startS), 0)
}
