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
  /** Words per caption (Jettism runs 1-3). */
  maxWords?: number
  /** A silence longer than this starts a new chunk instead of joining it. */
  maxGapS?: number
  /** No chunk spans longer than this even if the words run on. */
  maxSpanS?: number
  /** How long a caption may linger after its last word when nothing follows. */
  holdS?: number
  /** Readability floor — never flash a caption shorter than this if avoidable. */
  minDurS?: number
}

const CHUNK_DEFAULTS: Required<ChunkOptions> = {
  maxWords: 2,
  maxGapS: 0.35,
  maxSpanS: 1.6,
  holdS: 0.3,
  minDurS: 0.18,
}

/** Ends a sentence → the next word starts a fresh chunk. */
const SENTENCE_END = /[.!?…]["')\]]*$/

/**
 * Group timed words into caption chunks. Break on chunk size, on real
 * silences, on sentence punctuation, and around emphasized words (an
 * emphasized word gets its own chunk so the whole caption can flip color).
 * Chunks are then extended to meet their successor — Jettism captions stay on
 * screen until replaced — and clamped so clips can NEVER overlap on a track.
 */
export function chunkWords(words: CaptionWord[], options: ChunkOptions = {}): CaptionChunk[] {
  const o = { ...CHUNK_DEFAULTS, ...options }
  const maxWords = Math.max(1, Math.round(o.maxWords))
  const input = words
    .filter((w) => w.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.startS - b.startS)
  if (input.length === 0) return []

  const groups: CaptionWord[][] = []
  let cur: CaptionWord[] = []
  for (const word of input) {
    const last = cur[cur.length - 1]
    const breakBefore =
      cur.length > 0 &&
      (cur.length >= maxWords ||
        !!word.emphasis !== !!last.emphasis ||
        word.startS - last.endS > o.maxGapS ||
        word.endS - cur[0].startS > o.maxSpanS ||
        SENTENCE_END.test(last.text))
    if (breakBefore) {
      groups.push(cur)
      cur = []
    }
    cur.push(word)
  }
  if (cur.length > 0) groups.push(cur)

  const chunks: CaptionChunk[] = groups.map((g) => ({
    text: g.map((w) => w.text.trim()).join(' '),
    startS: g[0].startS,
    endS: Math.max(g[0].startS, g[g.length - 1].endS),
    emphasis: g.some((w) => w.emphasis),
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

/** The house caption look: heavy white text, thick black outline, at ~72% height. */
export function jettismCaptionDef(text: string, seqHeight: number): TitleDef {
  return {
    text,
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSizePx: px(154, seqHeight), // ~8% of frame height
    color: '#ffffff',
    align: 'center',
    vAlign: 'middle',
    bold: true,
    italic: false,
    lineHeight: 1.1,
    offsetXPx: 0,
    // vAlign middle sits at 50%; the spec wants the caption line at ~72%.
    offsetYPx: px(422, seqHeight),
    shadow: { color: 'rgba(0,0,0,0.6)', blurPx: px(6, seqHeight), dx: 0, dy: px(4, seqHeight) },
    outline: { color: '#000000', widthPx: px(9, seqHeight) },
  }
}

/** Pop-in length: ~4 frames at 30fps, matching the genre's snap. */
export const CAPTION_POP_DUR_S = 0.13

export interface CaptionClipOptions extends CaptionStyleOptions {
  seqWidth: number
}

/**
 * Turn chunks into ready-to-insert title clips: house style (or the inherited
 * base style), emphasis color on keyword chunks, and the pop entrance compiled
 * to real keyframes through the standard appearance path.
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
    return applyAppearanceToClip(clip, { in: 'pop', durS: CAPTION_POP_DUR_S }, options.seqWidth, options.seqHeight)
  })
}
