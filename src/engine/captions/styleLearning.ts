// What he changed about a caption, and what that says about how he writes.
//
// His ask, 2026-08-19: *"Whenever I archive a project and I use captions in it,
// make sure it learns from my speech patterns, even how it types the words, the
// size of everything, and the animations. I want you to really save everything
// and then compare that to what the base model would do and adjust based off of
// that."*
//
// ⛔ THE COMPARISON IS THE WHOLE THING, and it is only possible because every
// caption carries `captionOrigin`: what the speech model said before he touched
// it. This file never guesses what the machine would have written. It reads it.
//
// ⛔ AND IT IS PURE. No store, no DOM, no persistence. It takes finished clips
// and returns facts, so the same function can read a live project, an archived
// one, or a fixture in a test, and cannot behave differently between them.

import type { Clip, TitleDef } from '../types'

/** One caption he kept, as the machine wrote it and as he left it. */
export interface CaptionPair {
  /** What the speech model produced. */
  machine: string
  /** What the video actually shows. */
  his: string
  /** Which model wrote the machine half. A profile must not mix models. */
  model: string
  /** Seconds on screen, so timing habits are learnable too. */
  durS: number
  title: TitleDef | undefined
  /** Entrance animation he shipped, read off the CLIP where appearance lives. */
  appearanceIn: string | undefined
}

/**
 * Every caption in a project that can be compared: it came from a model AND it
 * still exists.
 *
 * ⛔ A CLIP HE DELETED IS NOT A CORRECTION, it is an absence, and this cannot
 * see it. That matters: the strongest signal in the whole set, "the machine
 * heard music and I threw it away", leaves nothing behind to read. Deletions are
 * counted separately at archive time, never inferred here.
 */
export function captionPairs(clips: readonly Clip[]): CaptionPair[] {
  const out: CaptionPair[] = []
  for (const c of clips) {
    if (!c.captionOrigin || !c.title) continue
    out.push({
      machine: c.captionOrigin.text,
      his: c.title.text,
      model: c.captionOrigin.model,
      durS: Math.max(0, c.outS - c.inS),
      title: c.title,
      appearanceIn: c.appearance?.in,
    })
  }
  return out
}

/** How a word is capitalised, judged on the word alone. */
export type CaseShape = 'lower' | 'upper' | 'title' | 'mixed'

export function caseShapeOf(s: string): CaseShape {
  const letters = s.replace(/[^\p{L}]/gu, '')
  if (letters.length === 0) return 'mixed'
  if (letters === letters.toLowerCase()) return 'lower'
  if (letters === letters.toUpperCase()) return 'upper'
  // First letter up and the rest down is the only other shape worth a name.
  if (/^\p{Lu}\p{Ll}*$/u.test(s.trim())) return 'title'
  return 'mixed'
}

/**
 * Same letters, same digits, same word boundaries, ignoring case and
 * punctuation: is this the same thing said, or did he actually retype it?
 *
 * ⛔ THE SPACE IS KEPT AND THAT IS THE WHOLE POINT. An earlier version stripped
 * every non letter and digit including whitespace, which made "cs go" and
 * "CSGO" identical, so the single most valuable rewrite he makes, gluing a
 * name the recogniser split in two, was invisible to the learning. His ask,
 * 2026-08-19, is *"even how it types the words"*, and the spacing of a name is
 * exactly how he types it.
 *
 * Case and punctuation stay excluded, because both are counted on their own
 * above and below: folding them in here would fill the fix list with "cool" to
 * "COOL" for every word he ever shouted.
 */
export const sameWord = (a: string, b: string): boolean => spokenShape(a) === spokenShape(b)

/** Lowercase, punctuation gone, runs of whitespace collapsed to one space. */
const spokenShape = (s: string): string =>
  s
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()

/**
 * A rewrite he made often enough to be a habit rather than a typo.
 *
 * ⛔ KEYED ON THE MACHINE'S SPELLING, LOWERCASED, because that is what a future
 * caption will arrive as. The value keeps his exact spelling including case, so
 * "clutch" to "CLUTCH" and "cs go" to "CS2" are both expressible.
 */
export interface WordFix {
  /** What the model writes, normalised for lookup. */
  from: string
  /** What he replaces it with, verbatim. */
  to: string
  /** How many separate captions he did this in. */
  seen: number
}

/**
 * Everything learnable from one project's captions.
 *
 * ⛔ COUNTS, NEVER CONCLUSIONS. Each field says what happened and how often, so
 * a later merge across projects can weigh them. A profile that stored "he
 * prefers upper case" could not later be told it was built from three captions.
 */
export interface StyleSample {
  model: string
  /** How many captions were comparable at all. */
  captions: number
  /** How many he left exactly as the machine wrote them. */
  untouched: number
  /** Rewrites of one word for another word. */
  wordFixes: WordFix[]
  /** How he cases text, counted over captions he did NOT otherwise rewrite. */
  caseCounts: Record<CaseShape, number>
  /** Whether he keeps end punctuation: counts of kept versus stripped. */
  punctuationKept: number
  punctuationStripped: number
  /** Font sizes he shipped, so the common one can be found. */
  sizes: number[]
  /** Entrance animations he shipped, by name, with counts. */
  animations: Record<string, number>
  /** Seconds on screen, so his pacing is learnable. */
  durations: number[]
}

const EMPTY_CASE: Record<CaseShape, number> = { lower: 0, upper: 0, title: 0, mixed: 0 }

/**
 * Read one project's captions into a sample.
 *
 * ⛔ A CAPTION HE NEVER TOUCHED IS EVIDENCE TOO, and the most easily lost kind.
 * Learning only from rewrites would teach the profile that he changes every
 * word, because the ones he was happy with would be invisible. `untouched` is
 * what keeps a fix honest: a word he re-spelled twice out of two matters, and
 * the same word twice out of ninety does not.
 */
export function sampleFromClips(clips: readonly Clip[]): StyleSample | null {
  const pairs = captionPairs(clips)
  if (pairs.length === 0) return null

  const caseCounts: Record<CaseShape, number> = { ...EMPTY_CASE }
  const fixes = new Map<string, Map<string, number>>()
  const sizes: number[] = []
  const animations: Record<string, number> = {}
  const durations: number[] = []
  let untouched = 0
  let punctuationKept = 0
  let punctuationStripped = 0

  for (const p of pairs) {
    durations.push(p.durS)
    if (p.title?.fontSizePx !== undefined) sizes.push(p.title.fontSizePx)

    const machine = p.machine.trim()
    const his = p.his.trim()
    if (machine === his) untouched++

    // Case is read off HIS text always: it is a styling habit, and it applies
    // whether or not he also changed the word.
    caseCounts[caseShapeOf(his)]++

    const machineEnds = /[.,!?;:]$/.test(machine)
    const hisEnds = /[.,!?;:]$/.test(his)
    if (machineEnds && hisEnds) punctuationKept++
    else if (machineEnds && !hisEnds) punctuationStripped++

    // ⛔ ONLY A DIFFERENT WORD COUNTS AS A FIX. If the letters match and only
    // the case or the punctuation differs, that is already recorded above, and
    // recording it here as well would fill the fix list with "cool" to "COOL"
    // for every word he ever shouted.
    if (his.length > 0 && !sameWord(machine, his)) {
      const key = machine.toLowerCase()
      const byTo = fixes.get(key) ?? new Map<string, number>()
      byTo.set(his, (byTo.get(his) ?? 0) + 1)
      fixes.set(key, byTo)
    }

    const anim = p.appearanceIn
    if (typeof anim === 'string') animations[anim] = (animations[anim] ?? 0) + 1
  }

  const wordFixes: WordFix[] = []
  for (const [from, byTo] of fixes) {
    // The single replacement he used most for this word. A word he has spelled
    // two different ways is a word he has not settled, and guessing between
    // them would put a spelling in his video he never chose.
    let bestTo = ''
    let bestN = 0
    for (const [to, n] of byTo) {
      if (n > bestN) {
        bestTo = to
        bestN = n
      }
    }
    if (bestTo) wordFixes.push({ from, to: bestTo, seen: bestN })
  }
  wordFixes.sort((a, b) => b.seen - a.seen || a.from.localeCompare(b.from))

  return {
    model: pairs[0].model,
    captions: pairs.length,
    untouched,
    wordFixes,
    caseCounts,
    punctuationKept,
    punctuationStripped,
    sizes,
    animations,
    durations,
  }
}
