// His caption style, learned across every project he has archived, and applied
// to the next one.
//
// His ask, 2026-08-19: *"I want you to really save everything and then compare
// that to what the base model would do and adjust based off of that."* This is
// the "adjust" half. `styleLearning.ts` reads one project; this merges many and
// decides what is settled enough to act on.
//
// ⛔ IT IS PURE, like its neighbour. Where the profile is STORED is somebody
// else's problem, so this can be tested exhaustively without a browser.

import type { CaseShape, StyleSample, WordFix } from './styleLearning'

/**
 * How many separate captions must show the same rewrite before it is applied
 * without being asked.
 *
 * ⛔ TWO, NOT ONE, AND THE DIFFERENCE IS THE POINT. One is a typo, a one-off
 * proper noun, or him fixing a word that only appears in that video. Applying
 * those silently would put words into his next video that he never chose, in a
 * feature whose entire promise is that it sounds like him. Two separate times is
 * the cheapest evidence that it is a habit.
 */
export const FIX_CONFIDENCE = 2

/**
 * How much of a majority a styling habit needs before it becomes the default.
 * Seventy percent, because case and punctuation are visible on every single
 * caption: a coin-flip majority would flip his whole video on one more sample.
 */
export const HABIT_MAJORITY = 0.7

/** The smallest number of captions that can settle a styling habit at all. */
export const HABIT_MIN_SAMPLES = 10

export interface StyleProfile {
  /** Which model these corrections were made against. */
  model: string
  /** Total comparable captions behind this profile. */
  captions: number
  /** Rewrites seen at least FIX_CONFIDENCE times, strongest first. */
  fixes: WordFix[]
  /** Rewrites seen once: real, but not yet trusted to apply unasked. */
  candidates: WordFix[]
  /** His settled casing, or null while it is still a coin flip. */
  caseHabit: CaseShape | null
  /** True when he reliably strips end punctuation the model wrote. */
  stripsPunctuation: boolean | null
  /** The font size he actually ships, or null when he has not settled on one. */
  fontSizePx: number | null
  /** The entrance animation he actually ships, or null. */
  animation: string | null
  /** Typical seconds on screen, the median rather than the mean. */
  medianDurS: number | null
}

/**
 * Fold every project's sample into one profile.
 *
 * ⛔ SAMPLES FROM A DIFFERENT MODEL ARE DROPPED, not merged. A correction made
 * against whisper-base says "base misheard this"; the same correction against
 * whisper-small might never have been needed. Mixing them teaches the profile
 * the difference between two models and calls it his style. The model swap on
 * 2026-08-18 makes this immediate rather than theoretical.
 */
export function buildProfile(samples: readonly StyleSample[], model: string): StyleProfile | null {
  const mine = samples.filter((s) => s.model === model)
  if (mine.length === 0) return null

  const captions = mine.reduce((n, s) => n + s.captions, 0)
  if (captions === 0) return null

  // Rewrites, summed across projects. A word he fixed once in each of three
  // videos is a firmer habit than one he fixed three times in a single video,
  // but both clear the bar, and pretending to know the difference would be
  // arithmetic dressed up as judgement.
  const byFrom = new Map<string, Map<string, number>>()
  for (const s of mine) {
    for (const f of s.wordFixes) {
      const byTo = byFrom.get(f.from) ?? new Map<string, number>()
      byTo.set(f.to, (byTo.get(f.to) ?? 0) + f.seen)
      byFrom.set(f.from, byTo)
    }
  }

  const fixes: WordFix[] = []
  const candidates: WordFix[] = []
  for (const [from, byTo] of byFrom) {
    let to = ''
    let seen = 0
    let total = 0
    for (const [candidate, n] of byTo) {
      total += n
      if (n > seen) {
        to = candidate
        seen = n
      }
    }
    if (!to) continue
    // ⛔ A WORD HE HAS SPELLED TWO WAYS IS NOT SETTLED, however often. Taking
    // the winner of 5 against 4 would put the loser's spelling in front of him
    // roughly half the time he expected it, which reads as the feature being
    // broken rather than as it having a preference.
    const decisive = seen >= total * HABIT_MAJORITY
    const entry = { from, to, seen }
    if (seen >= FIX_CONFIDENCE && decisive) fixes.push(entry)
    else candidates.push(entry)
  }
  fixes.sort((a, b) => b.seen - a.seen || a.from.localeCompare(b.from))
  candidates.sort((a, b) => b.seen - a.seen || a.from.localeCompare(b.from))

  // Casing.
  const caseTotals: Record<CaseShape, number> = { lower: 0, upper: 0, title: 0, mixed: 0 }
  for (const s of mine) {
    for (const k of Object.keys(caseTotals) as CaseShape[]) caseTotals[k] += s.caseCounts[k] ?? 0
  }
  const caseHabit = majorityKey(caseTotals, captions)

  // Punctuation. Only captions where the model actually wrote some can vote.
  const kept = mine.reduce((n, s) => n + s.punctuationKept, 0)
  const stripped = mine.reduce((n, s) => n + s.punctuationStripped, 0)
  const punctVotes = kept + stripped
  const stripsPunctuation =
    punctVotes >= HABIT_MIN_SAMPLES
      ? stripped >= punctVotes * HABIT_MAJORITY
        ? true
        : kept >= punctVotes * HABIT_MAJORITY
          ? false
          : null
      : null

  const sizes = mine.flatMap((s) => s.sizes)
  const durations = mine.flatMap((s) => s.durations)

  const animTotals: Record<string, number> = {}
  for (const s of mine) {
    for (const [k, n] of Object.entries(s.animations)) animTotals[k] = (animTotals[k] ?? 0) + n
  }
  const animVotes = Object.values(animTotals).reduce((a, b) => a + b, 0)
  const animation = animVotes >= HABIT_MIN_SAMPLES ? majorityKey(animTotals, animVotes) : null

  return {
    model,
    captions,
    fixes,
    candidates,
    caseHabit,
    stripsPunctuation,
    // ⛔ THE MODE, NOT THE MEAN, for size. He works at a handful of deliberate
    // sizes; averaging 96 and 120 produces 108, a number he has never once
    // chosen and would have to correct every time.
    fontSizePx: sizes.length >= HABIT_MIN_SAMPLES ? modeOf(sizes) : null,
    animation,
    medianDurS: durations.length > 0 ? medianOf(durations) : null,
  }
}

/** The key holding at least HABIT_MAJORITY of `total`, or null. */
function majorityKey<K extends string>(counts: Record<K, number>, total: number): K | null {
  if (total < HABIT_MIN_SAMPLES) return null
  let best: K | null = null
  let bestN = 0
  for (const [k, n] of Object.entries(counts) as [K, number][]) {
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  return best !== null && bestN >= total * HABIT_MAJORITY ? best : null
}

function modeOf(xs: readonly number[]): number | null {
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best: number | null = null
  let bestN = 0
  for (const [x, n] of counts) {
    if (n > bestN) {
      best = x
      bestN = n
    }
  }
  return best
}

function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

/**
 * The settled rewrite for exactly this caption, or null.
 *
 * ⛔ SEPARATE FROM `applyProfile` BECAUSE ONLY THIS HALF IS SAFE TO APPLY
 * UNASKED. A rewrite is a word he typed himself, twice, so putting it back is
 * repeating him. His CASING and his punctuation habit are inferred from counts,
 * and the caption preset he saved in the app already states both explicitly. An
 * inference must never overrule a switch he actually set, so the caption run
 * asks this, and the whole-profile version stays for the suggestion list.
 */
export function wordFixFor(machineText: string, profile: StyleProfile | null): WordFix | null {
  if (!profile) return null
  const raw = machineText.trim().toLowerCase()
  if (!raw) return null
  return profile.fixes.find((f) => f.from === raw) ?? null
}

/**
 * Apply the settled half of the profile to one freshly transcribed caption.
 *
 * ⛔ WORD REWRITES ONLY MATCH THE WHOLE CAPTION. Every caption in this app is
 * one word (`AUTO_CAPTION_OPTIONS`), so a whole-caption match IS a word match,
 * and matching inside a longer string would turn "cs" into "CS2" in the middle
 * of "cost" the first time he wrote a sentence by hand.
 *
 * ⛔ AND IT NEVER TOUCHES A CAPTION HE HAS ALREADY EDITED. This runs at
 * transcription time, on machine output, and nowhere else.
 */
export function applyProfile(machineText: string, profile: StyleProfile | null): string {
  if (!profile) return machineText
  const raw = machineText.trim()
  if (raw.length === 0) return machineText

  const hit = wordFixFor(raw, profile)
  let out = hit ? hit.to : raw

  // Punctuation before case, so stripping cannot resurrect a capital.
  if (profile.stripsPunctuation === true) out = out.replace(/[.,!?;:]+$/, '')

  // ⛔ A REWRITE HE TYPED CARRIES ITS OWN CASE and must not be re-cased. He
  // typed "CS2" and "iPhone" the way he wanted them; forcing the profile's
  // lowercase habit over the top would hand back "cs2" and "iphone", which is
  // the feature actively undoing the thing it just learned.
  if (!hit && profile.caseHabit) {
    if (profile.caseHabit === 'upper') out = out.toUpperCase()
    else if (profile.caseHabit === 'lower') out = out.toLowerCase()
    else if (profile.caseHabit === 'title') out = out.charAt(0).toUpperCase() + out.slice(1).toLowerCase()
  }
  return out
}

/**
 * What the profile would change about a run it has NOT been allowed to apply:
 * the suggestion half of his ask.
 *
 * His words, 2026-08-19: *"Sometimes, even suggest improvements... Maybe I'll
 * apply them, because even those that I finished are like 8 to maybe 9 out of
 * 10."* So this returns the diff and changes nothing.
 */
export interface StyleSuggestion {
  before: string
  after: string
  /** Why, in his language, short enough to sit on one line. */
  reason: string
  seen: number
}

export function suggestFor(texts: readonly string[], profile: StyleProfile | null): StyleSuggestion[] {
  if (!profile) return []
  const out = new Map<string, StyleSuggestion>()
  for (const t of texts) {
    const after = applyProfile(t, profile)
    if (after === t.trim()) continue
    const key = `${t} ${after}`
    const prev = out.get(key)
    if (prev) prev.seen++
    else {
      const fix = profile.fixes.find((f) => f.from === t.trim().toLowerCase())
      out.set(key, {
        before: t,
        after,
        reason: fix ? `You write this as "${fix.to}"` : 'Matches how you style your captions',
        seen: 1,
      })
    }
  }
  return [...out.values()].sort((a, b) => b.seen - a.seen)
}
