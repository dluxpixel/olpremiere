// Jettism-style captions (word-by-word "karaoke" text synced to a voiceover).
// The engine deliberately does NOT introduce a new renderer or clip type: a
// caption is a run of ordinary short TITLE clips, one per 1-3-word chunk, each
// carrying the house caption style (white 900-weight text, thick black outline,
// lower-third placement) and a pop entrance compiled through the same
// appearance machinery every other clip uses. Preview==export therefore holds
// by construction, and every word stays hand-editable on the timeline.
// Pure: no React, no DOM, no store.

import type { Clip, TitleDef } from '../types'
import { newTitleClip } from '../types'
import { applyAppearanceToClip } from '../anim/appearance'
import { CAPTION_FONT_STACK } from '../render/titleFonts'

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
  /** Soft character cap per caption — split before a chunk overflows the frame. Infinity = off. */
  maxChars?: number
  /** Reading-speed ceiling (characters/second) — split a chunk that reads too fast. Infinity = off. */
  maxCps?: number
  /** A silence longer than this starts a new chunk instead of joining it. */
  maxGapS?: number
  /** No chunk spans longer than this even if the words run on. */
  maxSpanS?: number
  /** How long a caption may linger after its last word when nothing follows. */
  holdS?: number
  /** Readability floor — a chunk shorter than this is merged (if mergeShort) so it never flashes. */
  minDurS?: number
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
  maxSpanS: 1.6,
  holdS: 0.4,
  minDurS: 0.18,
  mergeShort: false,
}

/**
 * Tuned short-form phrase captions: group words into readable ~4-6 word chunks,
 * cap line length + reading speed, and GUARANTEE a ~1s minimum on screen by
 * MERGING short/orphan words into a neighbor instead of flashing them for a frame.
 * This is what the auto-caption path uses (vs the one-word karaoke house style).
 */
export const PHRASE_CAPTION_OPTIONS: Required<ChunkOptions> = {
  maxWords: 6,
  maxChars: 30,
  maxCps: 20,
  maxGapS: 0.4,
  maxSpanS: 4,
  holdS: 0.4,
  minDurS: 1.0,
  mergeShort: true,
}

/** Ends a sentence → the next word starts a fresh chunk. */
const SENTENCE_END = /[.!?…]["')\]]*$/

/** Short function words that shouldn't stand alone as a caption or end a chunk. */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'but', 'or', 'so', 'is', 'it', 'at', 'by',
  'as', 'my', 'your', 'with', 'that', 'this', 'i', 'we', 'you', 'are', 'was', 'be', 'if', 'our',
])
const normalizeWord = (t: string): string => t.toLowerCase().replace(/[^a-z']/g, '')
const isFunctionWord = (t: string): boolean => FUNCTION_WORDS.has(normalizeWord(t))
const groupText = (ws: CaptionWord[]): string => ws.map((w) => w.text.trim()).join(' ')
const groupSpan = (ws: CaptionWord[]): number => ws[ws.length - 1].endS - ws[0].startS

/**
 * Group timed words into caption chunks. HARD boundaries (sentence end, real
 * silence, emphasis flip) always break; SOFT limits (word count, line length,
 * reading speed, span) break too but can be UNDONE by the merge pass, which folds
 * a too-short or lone-function-word chunk into a soft-adjacent neighbor so nothing
 * flashes for a single frame. Chunks are then extended to meet their successor
 * (seamless) and clamped strictly non-overlapping — the track invariant wins.
 */
export function chunkWords(words: CaptionWord[], options: ChunkOptions = {}): CaptionChunk[] {
  const o = { ...CHUNK_DEFAULTS, ...options }
  const maxWords = Math.max(1, Math.round(o.maxWords))
  const input = words
    .filter((w) => w.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.startS - b.startS)
  if (input.length === 0) return []

  // Build groups, remembering whether the break BEFORE each was HARD — the merge
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
      if (SENTENCE_END.test(last.text) || !!word.emphasis !== !!last.emphasis || word.startS - last.endS > o.maxGapS) {
        hard = true
      } else {
        const span = word.endS - cur[0].startS
        const chars = groupText([...cur, word]).length
        soft =
          cur.length >= maxWords || chars > o.maxChars || span > o.maxSpanS || chars / Math.max(1e-3, span) > o.maxCps
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
  if (o.mergeShort) {
    const fits = (ws: CaptionWord[]): boolean => ws.length <= maxWords && groupText(ws).length <= o.maxChars
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

  const chunks: CaptionChunk[] = groups.map((g) => ({
    text: groupText(g.words),
    startS: g.words[0].startS,
    endS: Math.max(g.words[0].startS, g.words[g.words.length - 1].endS),
    emphasis: g.words.some((w) => w.emphasis),
  }))

  // Seamless hold: run each caption up to its successor (or linger holdS at a
  // real silence / the end), enforce the readability floor, and make the
  // sequence strictly non-overlapping — the track invariant outranks minDurS.
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1]
    const c = chunks[i]
    if (next) {
      c.endS = next.startS - c.endS <= o.holdS ? next.startS : c.endS + o.holdS
    } else {
      c.endS += o.holdS
    }
    c.endS = Math.max(c.endS, c.startS + o.minDurS)
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
  /** Sequence frame size — the style scales off the height. */
  seqHeight: number
  /** Inherit this style instead of the Jettism default (manual split). */
  baseDef?: TitleDef
  /** ALL-CAPS the text (Jettism house style). Default: only without baseDef. */
  upper?: boolean
  emphasisColor?: string
}

/** Scale a 1920-height reference pixel value to this sequence. */
const px = (ref: number, seqHeight: number): number => Math.max(1, Math.round((ref / 1920) * seqHeight))

/** The house caption look: the comic caption face, white fill, thick black
 * outline, just under center (~52% height per the motion-pack brief). */
export function jettismCaptionDef(text: string, seqHeight: number): TitleDef {
  return {
    text,
    fontFamily: CAPTION_FONT_STACK,
    fontSizePx: px(154, seqHeight), // ~8% of frame height
    color: '#ffffff',
    align: 'center',
    vAlign: 'middle',
    bold: true,
    italic: false,
    lineHeight: 1.1,
    offsetXPx: 0,
    // vAlign middle sits at 50%; the brief wants the caption line at ~52%.
    offsetYPx: px(38, seqHeight),
    shadow: { color: 'rgba(0,0,0,0.6)', blurPx: px(6, seqHeight), dx: 0, dy: px(4, seqHeight) },
    outline: { color: '#000000', widthPx: px(9, seqHeight) },
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
}

/**
 * Turn chunks into ready-to-insert title clips: house style (or the inherited
 * base style), emphasis color on keyword chunks, hard-cut by default with an
 * optional pop entrance compiled through the standard appearance path.
 */
export function captionClips(chunks: CaptionChunk[], options: CaptionClipOptions): Clip[] {
  const upper = options.upper ?? options.baseDef === undefined
  const emphasisColor = options.emphasisColor ?? CAPTION_EMPHASIS_COLORS[0]
  return chunks.map((chunk) => {
    const text = upper ? chunk.text.toUpperCase() : chunk.text
    const def: TitleDef = options.baseDef
      ? { ...options.baseDef, text }
      : jettismCaptionDef(text, options.seqHeight)
    if (chunk.emphasis) def.color = emphasisColor
    const clip = newTitleClip(def, chunk.startS, chunk.endS - chunk.startS)
    if (!options.popIn) return clip
    return applyAppearanceToClip(clip, { in: 'pop', durS: CAPTION_POP_DUR_S }, options.seqWidth, options.seqHeight)
  })
}
