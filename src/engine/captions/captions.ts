// Jettism-style captions (word-by-word "karaoke" text synced to a voiceover).
// The engine deliberately does NOT introduce a new renderer or clip type: a
// caption is a run of ordinary short TITLE clips, one per spoken word, each
// carrying the house caption style (lowercase white ExtraBold text, black
// outline, dead centre) compiled through the same appearance machinery every
// other clip uses. Preview==export therefore holds by construction, and every
// word stays hand-editable on the timeline.
//
// Every number in the house style and the timing was measured off the reference
// channel's own frames on 2026-07-29. Nothing here is an estimate from a brief.
// Pure: no React, no DOM, no store.

import type { Clip, TitleDef } from '../types'
import { newTitleClip } from '../types'
import { applyAppearanceToClip } from '../anim/appearance'
import { CAPTION_FONT_STACK } from '../render/titleFonts'
import { wordFixFor, type StyleProfile } from './styleProfile'

/** One spoken word with its absolute timeline window, seconds. */
export interface CaptionWord {
  text: string
  startS: number
  endS: number
  /** Keyword highlight: render this word in the emphasis color. */
  emphasis?: boolean
}

/** A 1-3-word group that owns one caption clip. */
export interface CaptionChunk {
  text: string
  startS: number
  endS: number
  emphasis: boolean
}

export interface ChunkOptions {
  /** Words per caption (phrase mode groups up to this; karaoke uses 1). */
  maxWords?: number
  /** Soft character cap per caption: split before a chunk overflows the frame. Infinity = off. */
  maxChars?: number
  /** Reading-speed ceiling (characters/second). Split a chunk that reads too fast. Infinity = off. */
  maxCps?: number
  /** A silence longer than this starts a new chunk instead of joining it. */
  maxGapS?: number
  /**
   * The on-screen duration every caption is aiming for. When set, THIS decides
   * where a caption ends: words are added while doing so gets the block closer
   * to the target, and the word count simply falls out of how fast he is
   * talking. That is what makes every block the same length on the timeline.
   */
  targetS?: number
  /** No chunk spans longer than this even if the words run on. */
  maxSpanS?: number
  /** How long a caption may linger after its last word when nothing follows. */
  holdS?: number
  /**
   * Stretch a caption to meet the NEXT one when the silence between them is at
   * most this. Separate from holdS on purpose: inside a phrase the words should
   * swap with no blank frame, but at a real pause the caption has to get off the
   * screen. One number could not do both, and using holdS for both is what left
   * a caption sitting there while he was not saying it.
   */
  bridgeS?: number
  /** Readability floor. A chunk shorter than this is merged (if mergeShort) so it never flashes. */
  minDurS?: number
  /**
   * Hard ceiling on how long ONE caption may sit on the screen, whatever the
   * transcriber claims. Infinity = off.
   *
   * Needed because a word's duration is not a fact, it is the transcriber's
   * opinion, and it stretches a word across the pause that follows it. On his
   * real footage a single "i'm" came back as 1.9 seconds, which parked one
   * caption on screen for nearly two seconds and left a slab on the timeline
   * next to a picket fence of ordinary words. Every other limit here governs
   * GROUPING, so none of them could touch it: there was only ever one word.
   */
  maxOnScreenS?: number
  /** Merge a sub-minDur or lone-function-word chunk into a soft-adjacent neighbor. */
  mergeShort?: boolean
}

const CHUNK_DEFAULTS: Required<ChunkOptions> = {
  // LEGACY defaults: the new limits are OFF (Infinity / false), so calling with
  // only `maxWords` behaves exactly as before. The tuned short-form set that fixes
  // "words are too short" is PHRASE_CAPTION_OPTIONS below.
  maxWords: 2,
  maxChars: Infinity,
  maxCps: Infinity,
  maxGapS: 0.35,
  targetS: 0, // off: legacy callers group by word count
  maxSpanS: 1.6,
  holdS: 0.4,
  bridgeS: 0.4, // legacy: the bridge WAS holdS, so keep them equal here
  minDurS: 0.18,
  mergeShort: false,
  maxOnScreenS: Infinity, // legacy callers keep the transcriber's word length
}

/**
 * Short-form caption chunking, tuned to the cadence David actually wants:
 *
 *   minecraft | but i'm going | to try | and find | diamonds | without | touching the | color | green!
 *
 * Short bursts of 1-3 words that keep pace with the voice. The earlier set
 * (6 words, 30 chars, a 1.0s floor) was wrong twice over: it grouped far too
 * wide, and the 1.0s floor made the merge pass swallow exactly the fast little
 * chunks that give the style its snap.
 *
 * `minDurS` is now only a flash guard, short enough that real speech is left
 * alone, long enough that nothing appears for a single frame. `mergeShort`
 * stays on because it also folds away a stranded "and" / "the".
 *
 * `maxWords` is the one number the user tunes (Captions dialog); everything
 * here scales sensibly around it.
 */
export const PHRASE_CAPTION_OPTIONS: Required<ChunkOptions> = {
  // WIDTH governs, not word count. David: "if words are shorter, maybe group
  // them together", which word count structurally cannot do, because it cannot
  // tell "to try" (6 chars, reads instantly) from "minecraft diamonds" (18, a
  // mouthful). maxChars is therefore the real limiter and maxWords is only a
  // ceiling, so short words pack up and long ones stand alone by themselves.
  //
  // Measured against his own example rather than guessed: at 12 chars / 3 words
  // his 14 words land as
  //   minecraft | but i'm | going to try | and find | diamonds | without | touching the | color green!
  // That is 8 captions against the 9 he wrote by hand, with every single word he put
  // alone ("minecraft", "diamonds", "without") landing alone.
  maxWords: 3,
  maxChars: 12,
  // Permissive on purpose: width does the grouping, and this only has to catch a
  // chunk that is genuinely unreadable for how long it is on screen.
  maxCps: 28,
  maxGapS: 0.4,
  targetS: 0,
  maxSpanS: 2,
  holdS: 0.4,
  bridgeS: 0.4,
  minDurS: 0.35,
  mergeShort: true,
  maxOnScreenS: Infinity,
}

/**
 * AUTO: the only caption mode there is, and EVERY BLOCK IS THE SAME LENGTH.
 *
 * His words, 2026-07-29, correcting me: *"I told you to make it auto-decide how
 * many words it needs per caption so the length of every single text block is
 * the same."* And on 07-28, looking at the old "3 words" run: *"all of these are
 * different sizes and some of these are there for longer."* Different SIZES. He
 * was pointing at the blocks on the timeline, not at the grouping.
 *
 * So the word count is an OUTPUT, never an input. Each caption aims at
 * `targetS` of screen time: words join while joining brings the block closer to
 * that length and stop when they would overshoot it. Fast speech puts three or
 * four words in a block, slow speech one, and the blocks come out even either way.
 *
 * Two rules still outrank the target, because a caption that does not match the
 * voice is worse than an uneven one:
 *   maxGapS 0.25 - a real pause always breaks, so a block never spans silence.
 *   maxChars 14  - a block never overflows the frame.
 * And two timings finish it:
 *   holdS   0.12 - at a pause the block clears the screen almost at once.
 *   bridgeS 0.36 - inside a phrase the next block takes over with no blank frame.
 *
 * `mergeShort` stays OFF: it is what folded a stranded "and" onto "evil".
 *
 * MEASURED 2026-07-29, and it settles the argument: the reference channel was
 * frame-measured over 20 consecutive blocks. Every block held ONE spoken word
 * (two only for a short pair like "of TNT"), and the blocks ran mean 0.49s.
 * So the mechanism above is right and stays: the length is what is held steady
 * and the word count falls out of it. Only the target number was wrong, 0.8
 * against a measured 0.45. holdS and bridgeS are NOT touched, because the
 * sampled clip was continuous speech and therefore measured nothing about what
 * a caption should do at a real pause.
 */
/**
 * The screen time every caption block aims for. MEASURED, not guessed:
 * 20 consecutive blocks off the reference channel on 2026-07-29 ran
 * mean 0.49s, median 0.40s, and 17 of the 19 non-outlier blocks sat between
 * 0.3s and 0.6s. The one 1.3s block was the single word "invisibility", which
 * no rule can shorten, so it is not evidence of a longer target.
 *
 * 0.45 replaces the 0.8 that shipped in v0.1.25. 0.8 was a guess, and it was
 * nearly DOUBLE: it packed two or three words into a block where the reference
 * shows one. This is the one number the measurement moved.
 */
export const AUTO_CAPTION_TARGET_S = 0.45

export const AUTO_CAPTION_OPTIONS: Required<ChunkOptions> = {
  targetS: AUTO_CAPTION_TARGET_S,
  // A ceiling, not the rule. The target decides in every normal case; these only
  // catch speech so fast that a block would become unreadable. Both are measured:
  // across those 20 blocks the count was 1 word in 15 and 2 in the other 5, NEVER
  // 3, and the widest block on screen was 12 characters ("invisibility").
  maxWords: 2,
  maxChars: 14,
  maxCps: Infinity,
  /**
   * ⛔ ANY MEASURABLE PAUSE BREAKS, and 0.05 is not a guess. His words,
   * 2026-08-13: *"sometimes it just groups them together when it doesn't need
   * to ... then it just looks messy."*
   *
   * MEASURED on 75 seconds of his own voiceover, run through this exact
   * chunker: 131 word boundaries, and they fall into TWO groups with nothing at
   * all in between.
   *
   *   97 of 131 are EXACTLY 0.00s      every one of them inside a phrase
   *   the other 34 are 0.06s or more   every single one a phrase boundary
   *
   * Not one mid-phrase boundary carries a gap, and not one gap sits mid-phrase.
   * The pairs he was complaining about are "Okay, | so" at 0.16s and
   * "Okay, | nice." at 0.24s, both of which the old 0.25 waved through.
   *
   * So this only has to be small enough to catch the smallest real gap and big
   * enough to ignore floating point. It does NOT stop short words pairing up:
   * they tile exactly, which is what he asked to keep.
   */
  maxGapS: 0.05,
  maxSpanS: Infinity,
  holdS: 0.12,
  bridgeS: 0.36,
  minDurS: 0.2,
  /**
   * ⛔ ON, and this REVERSES the call above it at his word.
   *
   * The note that turned it off said it "folded a stranded 'and' onto 'evil'",
   * treating that as the defect. Shown his own captions on 2026-08-13 he chose
   * the opposite: a lone filler word sitting on screen by itself is what looks
   * messy, and 9 of his 97 captions were exactly that ("and", "this", "are").
   *
   * It can only ever merge across a SOFT break, so a word left alone by one of
   * his pauses stays alone. It tidies the ones that were split by width.
   */
  mergeShort: true,
  // The longest block in the whole measured reference was 1.3s, and it was the
  // single word "invisibility". So 1.3 is not a taste call, it is the measured
  // ceiling, and anything longer is the transcriber's padding rather than
  // something he actually said.
  maxOnScreenS: 1.3,
}

/** Ends a sentence → the next word starts a fresh chunk. */
const SENTENCE_END = /[.!?…]["')\]]*$/

/**
 * Exported so the emphasis picker splits phrases on exactly the rule that breaks
 * a block here. Two copies of this regex would be free to drift apart, and the
 * moment they did, a phrase could span a block and put two flags in one caption.
 */
export const endsSentence = (text: string): boolean => SENTENCE_END.test(text)

/** Short function words that shouldn't stand alone as a caption or end a chunk. */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'but', 'or', 'so', 'is', 'it', 'at', 'by',
  'as', 'my', 'your', 'with', 'that', 'this', 'i', 'we', 'you', 'are', 'was', 'be', 'if', 'our',
  // Added 2026-09-23: determiners, possessives and prepositions that belong to
  // the word AFTER them, so a caption stops ending on them ("see any | green").
  'any', 'some', 'these', 'those', 'his', 'her', 'their', 'its', 'from', 'into', 'onto', 'than', 'about',
  'they', 'he', 'she', 'were',
])
const normalizeWord = (t: string): string => t.toLowerCase().replace(/[^a-z']/g, '')
/**
 * The ONE stop list. Exported because the emphasis picker's hard veto has to be
 * this exact set: measured 2026-08-09, raw loudness picks a function word in 7
 * of 14 phrases, so a second list that drifted by one word would put the
 * highlight on "it".
 */
export const isFunctionWord = (t: string): boolean => FUNCTION_WORDS.has(normalizeWord(t))

/**
 * The words that belong to the word AFTER them, so a caption should not end on
 * one: articles, prepositions, conjunctions, determiners and subject pronouns.
 * Narrower than FUNCTION_WORDS on purpose: "could be", "to be" and "do it" end
 * naturally, so the verbs and object pronouns are not in here.
 */
const LEANS_FORWARD = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'at', 'by', 'as', 'with', 'from', 'into', 'onto', 'than', 'about',
  'and', 'but', 'or', 'so', 'if', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'any', 'some', 'these',
  'those', 'this', 'that', 'i', 'we', 'you', 'they', 'he', 'she',
])
export const leansForward = (t: string): boolean => LEANS_FORWARD.has(normalizeWord(t))

/** A word the recogniser ended with a phrase mark: where the speaker himself broke. */
const PHRASE_COMMA = /[,;:\u2013\u2014]["')\]]*$/

/**
 * What each soft rule costs, on the same scale as the length rule (a block 50%
 * over its target length costs 1.5, one 50% under it 0.5). `flash` is the floor
 * of the cost of a caption more than a frame shorter than readable, and it grows
 * with the shortfall. Ordered by how bad each looks on screen:
 * a caption too brief to read is worst, then a stranded "and", then a pair welded
 * across his comma, then a caption ending on a word that belongs to the next one.
 * Exported so the tests can pin the ORDER, which is the actual decision.
 */
export const SOFT_COST = {
  flash: 4,
  loneFunctionWord: 3,
  pairAcrossComma: 2.5,
  endsOnFunctionWord: 2,
  blankPerSecond: 8,
} as const
const groupText = (ws: CaptionWord[]): string => ws.map((w) => w.text.trim()).join(' ')
const groupSpan = (ws: CaptionWord[]): number => ws[ws.length - 1].endS - ws[0].startS

/**
 * Group timed words into caption chunks. HARD boundaries (sentence end, real
 * silence, emphasis flip) always break; SOFT limits (word count, line length,
 * reading speed, span) break too but can be UNDONE by the merge pass, which folds
 * a too-short or lone-function-word chunk into a soft-adjacent neighbor so nothing
 * flashes for a single frame. Chunks are then extended to meet their successor
 * (seamless) and clamped strictly non-overlapping, because the track invariant wins.
 */
export function chunkWords(words: CaptionWord[], options: ChunkOptions = {}): CaptionChunk[] {
  const o = { ...CHUNK_DEFAULTS, ...options }
  const maxWords = Math.max(1, Math.round(o.maxWords))
  const sorted = words
    .filter((w) => w.text.trim().length > 0 && isSpeechWord(w.text))
    .slice()
    .sort((a, b) => a.startS - b.startS)

  // ⛔ A WORD CANNOT STILL BE BEING SAID AFTER THE NEXT ONE HAS STARTED.
  //
  // The recogniser says otherwise, and it does it on his real audio: 8 of the 61
  // word boundaries in one of his takes OVERLAP, including the same word twice
  // 0.02 s apart ("my"[20.72,21] then "my"[20.74,21], "god!"[21,21.24] then
  // "god,"[21,21.34]). Nothing downstream expected that. The seamless-hold pass
  // clamps a caption to the start of the next one, so an overlap became a
  // caption on screen for 0.02 SECONDS, less than a frame, and a hard enough
  // overlap deleted the word outright.
  //
  // Fixed at the door instead of guarded for in three places further down: the
  // ends are pulled back to the next word's start, and a stutter that the pull
  // reduces to nothing is dropped, which loses no text because the word after it
  // says the same thing. A word that is genuinely distinct is always kept, even
  // if the recogniser left it no room, because losing his words is the one thing
  // this pipeline may never do.
  // ⛔ ONLY AN OVERLAPPING REPEAT, and that word is doing all the work.
  //
  // A repeat the model emitted TWICE OVER THE SAME MOMENT is the model skipping
  // at a chunk seam: "my"[20.72,21] then "my"[20.74,21], "we" then "We". Both
  // reached his screen. `transcribe.ts` already collapses stutters, but it walks
  // the recogniser's EMISSION order, and at a seam that is not time order, so
  // the two halves are not neighbours when it looks. Sorted, they always are.
  //
  // ⚠️ REPEATED SPEECH NEVER OVERLAPS ITSELF. Saying "very very good" gives two
  // "very"s back to back, not on top of each other, so this cannot reach them.
  // A first cut of this used the same 0.12 s nearness test `transcribe.ts` uses
  // and would have eaten one of them: the tests caught it.
  const input: CaptionWord[] = []
  for (let i = 0; i < sorted.length; i++) {
    let w = sorted[i]!
    while (i + 1 < sorted.length) {
      const next = sorted[i + 1]!
      if (normalizeWord(w.text) !== normalizeWord(next.text) || next.startS >= w.endS - 1e-9) break
      w = { ...w, endS: Math.max(w.endS, next.endS) }
      i++
    }
    const after = sorted[i + 1]
    const endS = after ? Math.min(w.endS, after.startS) : w.endS
    input.push(endS === w.endS ? w : { ...w, endS })
  }
  if (input.length === 0) return []

  // ⛔ ONE DECISION, NOT A CHAIN OF REPAIRS (2026-09-23).
  //
  // His words: *"this still sucks, cuz i add one rule like split words and it
  // breaks another."* He was right about the mechanism, and the history in this
  // file is the proof. Grouping used to be a greedy pass followed by two repair
  // passes (merge the short ones, hand a trailing "of" forward), and every rule
  // added since needed a guard in the others: the merge learned to respect the
  // on-screen ceiling, the hand-forward learned not to leave a flash behind, and
  // the hand-forward had to be forbidden from ever looping with the merge. Each
  // fix was a new way for two rules to disagree about the same words.
  //
  // So grouping is now ONE global choice. Every way of cutting a phrase into
  // captions is scored, and the cheapest wins (dynamic programming, so it is
  // exact and costs only words x maxWords). Rules come in exactly two kinds:
  //
  //   HARD, and never broken, because a cut that breaks one is simply not a
  //   candidate: a sentence end, a real pause, a highlight edge, and the
  //   ceilings (words per caption, width, reading speed, time on screen).
  //
  //   SOFT, as costs that trade against each other on one scale: even block
  //   lengths, no lone "and", no caption ending on a word that belongs to the
  //   next one, no pair welded across a comma, nothing on screen too briefly to
  //   read.
  //
  // Adding a rule is adding a cost. It can make the others trade differently,
  // it can never make a caption break a hard rule, and there is no order for two
  // rules to fight over.
  const n = input.length
  // A hard break BEFORE word k: a sentence ended, the highlight flips, or he paused.
  const hardBefore: boolean[] = input.map(
    (w, k) =>
      k > 0 &&
      (endsSentence(input[k - 1]!.text) ||
        !!w.emphasis !== !!input[k - 1]!.emphasis ||
        w.startS - input[k - 1]!.endS > o.maxGapS),
  )
  const maxSeg = Math.max(1, maxWords)

  /**
   * How long this block will actually SIT ON SCREEN, which is what he sees on
   * the timeline and what "every block the same length" is about. The timing
   * stage below turns a block into exactly this: inside a phrase it runs to the
   * next caption, at a pause it lingers holdS, and nothing outstays the ceiling.
   */
  const shownFor = (i: number, j: number): number => {
    const start = input[i]!.startS
    const lastEnd = input[j - 1]!.endS
    const next = input[j]
    const until = next && next.startS - lastEnd <= o.bridgeS ? next.startS : lastEnd + o.holdS
    return Math.min(Math.max(0, until - start), input[j - 1]!.startS - start + o.maxOnScreenS)
  }

  /**
   * Seconds of empty screen the on-screen ceiling leaves between this caption
   * and the next one INSIDE a phrase. At a real pause a gap is correct and costs
   * nothing; mid-phrase it is the screen going blank while he talks. Since the
   * ceiling counts from the last word, grouping can no longer add any, so this
   * only weighs the blank a padded last word brings with it.
   */
  const blankAfter = (j: number): number => {
    const next = input[j]
    if (!next || next.startS - input[j - 1]!.endS > o.bridgeS) return 0
    return Math.max(0, next.startS - input[j - 1]!.startS - o.maxOnScreenS)
  }

  /** May words [i, j) share one caption at all? The hard rules, all of them. */
  const allowed = (i: number, j: number): boolean => {
    for (let k = i + 1; k < j; k++) if (hardBefore[k]) return false
    // One word is always allowed: a long word has to go SOMEWHERE, and losing his
    // words is the one thing this pipeline may never do.
    if (j - i === 1) return true
    const ws = input.slice(i, j)
    if (ws.length > maxWords) return false
    const chars = groupText(ws).length
    if (chars > o.maxChars) return false
    const span = groupSpan(ws)
    if (span > o.maxSpanS) return false
    // ⛔ THE CEILING ASKS WHEN THE LAST WORD STARTS, NOT WHEN IT ENDS. A word's
    // end is the recogniser's opinion and it swallows the pause after it: his
    // "like" at the end of a take came back 1.5 s long. Measuring the pair by that
    // end refused "and like" and left a lone "and". What the ceiling protects is
    // the last word getting read before the caption is cut, so that is the rule.
    if (ws[ws.length - 1]!.startS - ws[0]!.startS > o.maxOnScreenS - o.minDurS) return false
    return chars / Math.max(1e-3, span) <= o.maxCps
  }

  /** What words [i, j) cost as one caption. Every soft rule is one line here. */
  const cost = (i: number, j: number): number => {
    const ws = input.slice(i, j)
    const shown = shownFor(i, j)
    let c = 0
    if (o.targetS > 0) {
      // EVEN LENGTHS. Overshooting the target costs three times what falling
      // short does: that ratio is what reproduces the measured reference, where a
      // pair of 0.3 s words shows as two blocks and a pair of 0.25 s words as one.
      // LINEAR, not squared: squared, one long final word (his last word plus
      // the hold after it) outweighed every phrasing rule put together and left
      // "subscribe and | like" on screen instead of "subscribe | and like".
      const d = (shown - o.targetS) / o.targetS
      c += d > 0 ? 3 * d : -d
    } else {
      // No target (the legacy and phrase callers): fewer, fuller blocks.
      c += 1
    }
    if (o.mergeShort) {
      const last = ws[ws.length - 1]!
      const midPhrase = j < n && !hardBefore[j]
      // A lone "and" / "the" / "to" on screen by itself.
      if (ws.length === 1 && isFunctionWord(last.text) && !endsSentence(last.text) && midPhrase) c += SOFT_COST.loneFunctionWord
      // "careful of | these": the "of" belongs to the words after it.
      if (ws.length > 1 && leansForward(last.text) && !endsSentence(last.text) && midPhrase) c += SOFT_COST.endsOnFunctionWord
      // "wait, there's": the comma is where HE put the break.
      for (let k = 0; k < ws.length - 1; k++) if (PHRASE_COMMA.test(ws[k]!.text)) c += SOFT_COST.pairAcrossComma
      // Too brief to read: the full weight from the floor down, growing with the
      // shortfall. The worst thing a caption can be is unreadable.
      if (shown < o.minDurS) c += SOFT_COST.flash * (1 + (o.minDurS - shown) / Math.max(1e-3, o.minDurS))
      // Blank screen while he is still talking: the ceiling cut this caption
      // before the next one arrives mid-phrase. Charged per second of blank.
      const blank = blankAfter(j)
      if (blank > 0) c += SOFT_COST.blankPerSecond * blank
    }
    return c
  }

  // best[j]: cheapest way to caption words [0, j). from[j]: where its last caption starts.
  const best = new Array<number>(n + 1).fill(Infinity)
  const from = new Array<number>(n + 1).fill(0)
  best[0] = 0
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= Math.max(0, j - maxSeg); i--) {
      if (!allowed(i, j)) {
        // A hard break inside means no longer block can be allowed either.
        if (i < j - 1 && hardBefore[i + 1]) break
        continue
      }
      const total = best[i]! + cost(i, j)
      // Ties go to the SHORTER last block, so equal-cost choices fill the early
      // blocks first, which is what the old greedy grouping did and every legacy
      // caller expects.
      if (total < best[j]! - 1e-9) {
        best[j] = total
        from[j] = i
      }
    }
  }
  const groups: CaptionWord[][] = []
  for (let j = n; j > 0; j = from[j]!) groups.unshift(input.slice(from[j]!, j))

  // Where each caption's LAST word starts: the on-screen ceiling counts from
  // there (see the timing stage below).
  const lastStarts = groups.map((ws) => ws[ws.length - 1]!.startS)
  const chunks: CaptionChunk[] = groups.map((ws) => ({
    text: groupText(ws),
    startS: ws[0]!.startS,
    // The LATEST end among its words, not the last word's: with overlapping
    // recogniser spans the last word can end before an earlier one does.
    endS: Math.max(ws[0]!.startS, ...ws.map((w) => w.endS)),
    emphasis: ws.some((w) => w.emphasis),
  }))

  // Seamless hold: run each caption up to its successor (or linger holdS at a
  // real silence / the end), enforce the readability floor, and make the
  // sequence strictly non-overlapping, since the track invariant outranks minDurS.
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1]
    const c = chunks[i]
    if (next) {
      // Inside a phrase: hand straight over, no blank frame. Across a real pause:
      // linger only holdS, so nothing is on screen while he is not talking.
      c.endS = next.startS - c.endS <= o.bridgeS ? next.startS : c.endS + o.holdS
    } else {
      c.endS += o.holdS
    }
    c.endS = Math.max(c.endS, c.startS + o.minDurS)
    // The ceiling goes on LAST, after the hold and the bridge, because those are
    // the two things that stretch a caption. It sits above minDurS on purpose:
    // if the two ever disagree the caption leaves, rather than overstaying.
    //
    // ⛔ COUNTED FROM THE LAST WORD'S START (2026-09-23), which for one word is
    // exactly what it always was. Counted from the caption's START, a pair was
    // cut sooner than its last word alone would have been, so pairing a word
    // made the screen go blank mid-phrase: 42.7 s of it across 3000 test takes.
    // The ceiling exists so a word the recogniser padded with a pause does not
    // park on screen, and that is a question about the last word.
    c.endS = Math.min(c.endS, lastStarts[i]! + o.maxOnScreenS)
    if (next) {
      c.endS = Math.min(c.endS, next.startS)
      next.startS = Math.max(next.startS, c.endS)
      next.endS = Math.max(next.endS, next.startS)
    }
  }
  return chunks.filter((c) => c.endS - c.startS > 1e-6)
}

/**
 * Manual mode (no transcription): spread the words of a text across a time
 * window, weighted by word length so long words get more screen time. A word
 * wrapped in *asterisks* is an emphasis keyword (the asterisks are stripped).
 */
export function spreadWords(text: string, startS: number, durationS: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || durationS <= 0) return []
  const parsed = tokens.map((t) => {
    const emphasis = /^\*.+\*$/.test(t)
    return { text: emphasis ? t.slice(1, -1) : t, emphasis }
  })
  const weights = parsed.map((p) => p.text.length + 2)
  const total = weights.reduce((a, b) => a + b, 0)
  const words: CaptionWord[] = []
  let t = startS
  for (let i = 0; i < parsed.length; i++) {
    const span = (weights[i] / total) * durationS
    words.push({
      text: parsed[i].text,
      startS: t,
      endS: i === parsed.length - 1 ? startS + durationS : t + span,
      ...(parsed[i].emphasis ? { emphasis: true } : {}),
    })
    t += span
  }
  return words
}

// ---------------------------------------------------------------------------
// The Jettism caption style (target parameters from the channel spec, scaled
// to the sequence so 1080x1920 and 720x1280 look identical).

/** Keyword highlight palette (spec: blue / yellow). Yellow is the default. */
export const CAPTION_EMPHASIS_COLORS = ['#FFD400', '#3B7DFF'] as const

export interface CaptionStyleOptions {
  /** Sequence frame size (the style scales off the height). */
  seqHeight: number
  /** Inherit this style instead of the Jettism default (manual split). */
  baseDef?: TitleDef
  /**
   * Force ALL-CAPS. OFF by default now: the house style was measured as
   * lowercase, so the default path runs `captionHouseCase` instead. Kept
   * because shouting a caption is a legitimate thing to want.
   */
  upper?: boolean
  emphasisColor?: string
}

/**
 * House caption case, measured off the reference frames on 2026-07-29: captions
 * are written in LOWERCASE with sentence punctuation dropped, while acronyms
 * keep their capitals ("TNT", "PvP"). Until now the app SHOUTED every caption,
 * which was the loudest wrong thing on the screen.
 *
 * A word is lowercased unless it is all-caps or carries a capital after its
 * first letter, which is what separates a real acronym from an ordinary word
 * that a transcriber happened to start a sentence with.
 *
 * Only sentence punctuation goes. Apostrophes stay, because they live inside
 * the word ("i'm"), and ! and ? stay, because the measurement found no periods
 * or commas but never caught him dropping a question mark.
 */
export function captionHouseCase(text: string): string {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[.,;:"]/g, ''))
    .filter(Boolean)
    .map((w) => {
      // Letters in ANY script. With `A-Za-z` a Czech acronym whose letters are
      // accented had nothing left to test and was lowercased: "ČR" came out
      // "čr". Longer ones like ŠKODA survived only because they had enough plain
      // letters left over, which is luck rather than a rule.
      const letters = w.replace(/[^\p{L}]/gu, '')
      const isAcronym =
        letters.length >= 2 && (letters === letters.toUpperCase() || /\p{Lu}/u.test(letters.slice(1)))
      return isAcronym ? w : alwaysCapital(w.toLowerCase())
    })
    .join(' ')
}

/**
 * The handful of words that are wrong in lowercase even in a lowercase style.
 *
 * His ask, 2026-08-06: *"make it so it automatically capitalizes some
 * characters, for example, I and stuff like that."*
 *
 * The house look IS lowercase, measured off his own reference frames, and that
 * is not being undone: "minecraft" stays lowercase because that is the style.
 * But a lone "i" is not a style choice, it reads as a typo, and the transcriber
 * hands it over correctly capitalised before this function flattens it. So the
 * pronoun and its contractions are put back.
 *
 * Deliberately NOT a proper-noun dictionary. Guessing at names would capitalise
 * the wrong words far more often than the right ones, and every miss is visible
 * on screen for the whole clip.
 */
const ALWAYS_CAPITAL = new Set(['i', "i'm", "i'll", "i've", "i'd", 'i̇'])

function alwaysCapital(word: string): string {
  // Compare without the trailing ! or ? the house style keeps, so "i'm!" works,
  // and with a CURLY apostrophe folded to a straight one. Whisper writes U+2019
  // often, and the set below only holds the straight form, so "i’m" fell through
  // and rendered lowercase: the exact typo the 2026-08-06 request was about,
  // still on screen whenever the recogniser chose the nicer quote.
  const core = word.replace(/[!?]+$/, '').replace(/[’ʼ]/g, "'")
  if (!ALWAYS_CAPITAL.has(core)) return word
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * Tokens a transcriber emits that are NOT speech and must never become a
 * caption: bare punctuation ("." or ","), and bracketed stage directions
 * ("(laughs)", "[Music]").
 *
 * Found on his real footage 2026-07-29, not in theory. A bare "." survived
 * chunking, then `captionHouseCase` stripped it to nothing, so the run came out
 * carrying **caption clips with no text at all**: invisible on the frame, and a
 * hairline sliver on the timeline that he could see and could not explain.
 *
 * ⛔ LETTERS AND DIGITS IN ANY SCRIPT, not `A-Za-z0-9`. The ASCII version threw
 * away every word without a plain latin letter in it, so this quietly deleted
 * "Ó" out of a Czech line and EVERY word of a Russian, Japanese, Korean, Greek
 * or Arabic one. The app offers Czech and Auto-detect, and Auto-detect is backed
 * by the 99 language model, so that path paid for a full Whisper run and then
 * came back with "No words to caption".
 *
 * `transcribe.ts` had this exact bug and was rewritten to `\p{L}\p{N}` to fix
 * it. This copy one layer down was missed, so `tidyTranscribedWords` carefully
 * kept a word that `chunkWords` then dropped. Same escape, same reason.
 */
const NON_SPEECH = /^[^\p{L}\p{N}]*$|^[([{].*[)\]}]$/u
export const isSpeechWord = (text: string): boolean => !NON_SPEECH.test(text.trim())

/** Scale a 1920-height reference pixel value to this sequence. */
const px = (ref: number, seqHeight: number): number => Math.max(1, Math.round((ref / 1920) * seqHeight))

/**
 * The house caption look. Every number here was MEASURED off the reference
 * channel's own frames on 2026-07-29, replacing the motion-pack brief's
 * estimates, which were wrong in three visible ways: the text was half again
 * too big, it sat below centre instead of on it, and it was SHOUTED in caps.
 *
 * Measured, as fractions of frame height so 1080x1920 and 720x1280 match:
 *   cap height  3.8% H, which Montserrat reaches at px(105) at 1920.
 *   position    dead centre, horizontally and vertically. No offset.
 *   outline     10% of cap height VISIBLE, so about 7px at 1920.
 *   shadow      +2/+2 px on a 640-tall source, so px(6) here, at 40% opacity.
 *
 * CAP HEIGHT is the number to hold, not point size. Cap height is what was
 * measured off the frames (white pixel rows); the point size in the write-up
 * was derived from it through an assumed face, so it only holds for that face.
 * Montserrat's capitals are 0.70 of its em, so 105 is what puts this font's
 * caps on the measured 3.8%. Rendered back and checked: 3.81% H.
 *
 * The outline number is DOUBLED to px(14) on purpose. `outline.widthPx` is a
 * canvas lineWidth, and a canvas stroke is centred on the glyph edge, so only
 * half of it lands outside the letter where the eye can see it. The measurement
 * is of the visible black band, so the setting has to be twice it. This is also
 * why the old 9px read thin next to the reference: it was showing 4.5px.
 *
 * Source resolution was 360x640, so the pixel-derived numbers carry about
 * one source pixel of error, which is 0.15% of frame height.
 */
export function jettismCaptionDef(text: string, seqHeight: number): TitleDef {
  return {
    text,
    fontFamily: CAPTION_FONT_STACK,
    fontSizePx: px(105, seqHeight), // puts Montserrat's caps on the measured 3.8% H
    color: '#ffffff',
    align: 'center',
    vAlign: 'middle',
    bold: true,
    italic: false,
    lineHeight: 1.1,
    offsetXPx: 0,
    // Dead centre. vAlign middle already sits at 50%, which is where the
    // measured caption block sits, so there is nothing to nudge.
    offsetYPx: 0,
    shadow: { color: 'rgba(0,0,0,0.4)', blurPx: px(6, seqHeight), dx: px(6, seqHeight), dy: px(6, seqHeight) },
    outline: { color: '#000000', widthPx: px(15, seqHeight) },
  }
}

/**
 * Pop-in length: 0.1 s, three frames at 30 fps, measured off the caption
 * short he picked as the reference on 2026-09-23 (see POP_FROM in
 * anim/appearance.ts). Was 0.13, which with the old curve spent most of a
 * short word's screen time still growing.
 */
export const CAPTION_POP_DUR_S = 0.1

export interface CaptionClipOptions extends CaptionStyleOptions {
  seqWidth: number
  /**
   * Compile a pop entrance onto each caption. The brief's house style is a
   * HARD CUT (instant word swap), so this is off by default.
   */
  popIn?: boolean
  /**
   * The speech model these chunks came out of, e.g.
   * `onnx-community/whisper-small.en_timestamped`. Given, every caption is
   * stamped with what the machine said before he touched it, which is the raw
   * material the style learning compares against. Absent for callers that are
   * not a transcription (a hand-built run), and then nothing is stamped: an
   * origin nobody can attribute to a model is worse than none.
   */
  model?: string
  /**
   * What he has taught the captions across every project he archived, or null
   * the first time. Only its settled word rewrites are used here: see
   * `wordFixFor` for why the casing half is deliberately left out.
   */
  profile?: StyleProfile | null
}

/**
 * Turn chunks into ready-to-insert title clips: house style (or the inherited
 * base style), emphasis color on keyword chunks, hard-cut by default with an
 * optional pop entrance compiled through the standard appearance path.
 *
 * Case follows the style: the house look gets the measured lowercase, an
 * inherited base style is left exactly as he typed it, and `upper` shouts.
 */
export function captionClips(chunks: CaptionChunk[], options: CaptionClipOptions): Clip[] {
  const emphasisColor = options.emphasisColor ?? CAPTION_EMPHASIS_COLORS[0]
  return chunks.map((chunk) => {
    // ⛔ HIS OWN REWRITE WINS AND IS NOT RE-CASED. He typed "CS2" twice in his
    // finished work, so putting "CS2" back is repeating him rather than
    // guessing at him. Running it through the house case afterwards would hand
    // back "cs2", which is the feature undoing the only thing it learned.
    const learned = wordFixFor(chunk.text, options.profile ?? null)
    const text = learned
      ? learned.to
      : options.upper
        ? chunk.text.toUpperCase()
        : options.baseDef
          ? chunk.text
          : captionHouseCase(chunk.text)
    const def: TitleDef = options.baseDef
      ? { ...options.baseDef, text }
      : jettismCaptionDef(text, options.seqHeight)
    if (chunk.emphasis) def.color = emphasisColor
    let clip = newTitleClip(def, chunk.startS, chunk.endS - chunk.startS)
    // ⛔ THE RAW CHUNK TEXT, NOT `text` ABOVE. `text` has already been through
    // the app's own casing, and stamping that would teach the profile the
    // difference between OUR house style and his, which he never asked about
    // and can read off the preset anyway. What is wanted is his delta from the
    // MACHINE, so the machine's own words are what get kept.
    if (options.model) clip = { ...clip, captionOrigin: { text: chunk.text, model: options.model } }
    if (!options.popIn) return clip
    return applyAppearanceToClip(clip, { in: 'pop', durS: CAPTION_POP_DUR_S }, options.seqWidth, options.seqHeight)
  })
}
