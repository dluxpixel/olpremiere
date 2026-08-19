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
])
const normalizeWord = (t: string): string => t.toLowerCase().replace(/[^a-z']/g, '')
/**
 * The ONE stop list. Exported because the emphasis picker's hard veto has to be
 * this exact set: measured 2026-08-09, raw loudness picks a function word in 7
 * of 14 phrases, so a second list that drifted by one word would put the
 * highlight on "it".
 */
export const isFunctionWord = (t: string): boolean => FUNCTION_WORDS.has(normalizeWord(t))
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

  // Build groups, remembering whether the break BEFORE each was HARD. The merge
  // pass may only cross SOFT breaks, never a sentence / silence / emphasis edge.
  interface Group {
    words: CaptionWord[]
    breakBeforeHard: boolean
  }
  const groups: Group[] = []
  let cur: CaptionWord[] = []
  let curBreakHard = false
  for (const word of input) {
    const last = cur[cur.length - 1]
    let hard = false
    let soft = false
    if (cur.length > 0) {
      if (endsSentence(last.text) || !!word.emphasis !== !!last.emphasis || word.startS - last.endS > o.maxGapS) {
        hard = true
      } else {
        const span = word.endS - cur[0].startS
        const chars = groupText([...cur, word]).length
        // Hard ceilings first: a caption may never outgrow the frame or the word cap.
        const overCap =
          cur.length >= maxWords || chars > o.maxChars || span > o.maxSpanS || chars / Math.max(1e-3, span) > o.maxCps
        if (o.targetS > 0) {
          // AIM AT THE TARGET. Take the word if it brings this block CLOSER to the
          // target length, stop if it would overshoot past it. Fast speech puts
          // three or four words in a block, slow speech one, and either way the
          // block occupies the same span of timeline. That is the whole ask: 'make
          // it auto-decide how many words it needs per caption so the length of
          // every single text block is the same'.
          // A DEAD HEAT SPLITS. When taking the word overshoots the target by
          // exactly as much as leaving it undershoots, both blocks are equally
          // even, so the tie is broken toward one word, which is what the
          // reference channel does in 15 of its 20 blocks. The epsilon is not a
          // fudge: without it the winner is decided by binary rounding noise on
          // the order of 1e-17, so 0.3 + 0.3 against a 0.45 target came out
          // joined while the identical case in whole cents came out split.
          const without = last.endS - cur[0].startS
          soft = overCap || Math.abs(span - o.targetS) >= Math.abs(without - o.targetS) - 1e-9
        } else {
          soft = overCap
        }
      }
    }
    if (hard || soft) {
      groups.push({ words: cur, breakBeforeHard: curBreakHard })
      cur = []
      curBreakHard = hard
    }
    cur.push(word)
  }
  if (cur.length > 0) groups.push({ words: cur, breakBeforeHard: curBreakHard })

  // Merge pass: fold a too-short or lone-function-word group into the neighbor it
  // shares a SOFT break with (prefer the shorter-span side), while the merge still
  // respects maxWords + maxChars. Never crosses a hard break, so sentence/silence/
  // emphasis edges are preserved and an isolated word is extended (not merged).
  /**
   * May these words share ONE caption? Used by both merge passes below.
   *
   * ⛔ IT HAS TO RESPECT EVERY CEILING THE GROUPING PASS RESPECTS, and it used to
   * check only the word count and the width. `maxOnScreenS` is the one that
   * matters and the failure is ugly: the ceiling is measured from the block's
   * START, so merging a word onto the front moves the start earlier and the
   * ceiling can then cut the caption off WHILE ITS LAST WORD IS STILL BEING
   * SPOKEN. Measured over 3000 takes, that alone added 30 percent more blank
   * screen time, and every bit of it came from a merge that outgrew the ceiling.
   *
   *   "be"(2.04-2.64) + "but"(2.64-3.54) merged spans 1.5s against a 1.3s
   *   ceiling, so the caption left the screen at 3.34 and the next one did not
   *   arrive until 3.54: a fifth of a second of nothing while he is talking.
   *
   * Refusing the merge is right rather than raising the ceiling: the ceiling is
   * measured off the reference channel and the merge is the optional part.
   */
  const fits = (ws: CaptionWord[]): boolean => {
    if (ws.length > maxWords) return false
    const chars = groupText(ws).length
    if (chars > o.maxChars) return false
    const span = groupSpan(ws)
    if (span > o.maxSpanS || span > o.maxOnScreenS) return false
    return chars / Math.max(1e-3, span) <= o.maxCps
  }
  if (o.mergeShort) {
    let i = 0
    while (i < groups.length && groups.length > 1) {
      const g = groups[i]
      const tooShort = groupSpan(g.words) < o.minDurS || (g.words.length === 1 && isFunctionWord(g.words[0].text))
      if (tooShort) {
        const left = i > 0 && !g.breakBeforeHard ? groups[i - 1] : null
        const right = i < groups.length - 1 && !groups[i + 1].breakBeforeHard ? groups[i + 1] : null
        const leftOk = left ? fits([...left.words, ...g.words]) : false
        const rightOk = right ? fits([...g.words, ...right.words]) : false
        let side: 'left' | 'right' | null = null
        if (leftOk && rightOk) side = groupSpan(left!.words) <= groupSpan(right!.words) ? 'left' : 'right'
        else if (leftOk) side = 'left'
        else if (rightOk) side = 'right'
        if (side === 'left') {
          left!.words = [...left!.words, ...g.words]
          groups.splice(i, 1)
          continue
        }
        if (side === 'right') {
          right!.words = [...g.words, ...right!.words]
          right!.breakBeforeHard = g.breakBeforeHard
          groups.splice(i, 1)
          continue
        }
      }
      i++
    }
  }

  // A CAPTION MUST NOT END ON A FUNCTION WORD.
  //
  // `FUNCTION_WORDS` says in its own comment that these "shouldn't stand alone
  // as a caption OR END A CHUNK", and only the first half was ever built. The
  // second half is what he was looking at on 2026-08-13: his own line came out
  // as `we have | to be | careful of | these.`, and "careful of" is a phrase cut
  // in the middle, because grouping is decided by clock time and "of" belongs to
  // "these" rather than to "careful".
  //
  // So a trailing function word is handed FORWARD to the caption it belongs
  // with. Only across a SOFT break, so it can never cross one of his pauses, and
  // never when it would leave a lone function word behind, which would trade one
  // of these for the other and could ping-pong with the merge pass above. One
  // pass, no loop.
  if (o.mergeShort) {
    for (let i = 0; i < groups.length - 1; i++) {
      const g = groups[i]!
      const next = groups[i + 1]!
      if (next.breakBeforeHard || g.words.length < 2) continue
      const tail = g.words[g.words.length - 1]!
      // A word that ends the sentence is a boundary, not a dangling preposition.
      if (!isFunctionWord(tail.text) || endsSentence(tail.text)) continue
      const left = g.words.slice(0, -1)
      if (left.length === 1 && isFunctionWord(left[0]!.text)) continue
      // ⛔ AND NEVER LEAVE A FLASH BEHIND. This pass runs AFTER the merge above,
      // which is the only thing that repairs a too-short group, so anything it
      // shortens past the readability floor stays shortened. Measured over 6000
      // takes before this guard: 8.5 percent of them gained a caption under the
      // floor, the worst at 0.10s, which is three frames. That is the hairline
      // picket fence on his timeline, and a word he cannot read.
      if (groupSpan(left) < o.minDurS) continue
      const moved = [tail, ...next.words]
      if (!fits(moved)) continue
      g.words = left
      next.words = moved
    }
  }

  const chunks: CaptionChunk[] = groups.map((g) => ({
    text: groupText(g.words),
    startS: g.words[0].startS,
    endS: Math.max(g.words[0].startS, g.words[g.words.length - 1].endS),
    emphasis: g.words.some((w) => w.emphasis),
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
    c.endS = Math.min(c.endS, c.startS + o.maxOnScreenS)
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

/** Pop-in length: ~4 frames at 30fps, matching the genre's snap. */
export const CAPTION_POP_DUR_S = 0.13

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
