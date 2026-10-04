// Caption STYLES: one saved bundle of how his captions look AND how they are cut.
//
// His ask, 2026-10-03: *"make it so I can somehow save caption styles,
// including caption length, how big it is, and stuff like that."* Premiere keeps
// those in two places (the track style for the look, Create captions for the
// length); here they are one thing he names, saves, and picks as the default
// that every new caption run uses.
//
// A style is two halves:
//   look   the title fields patched over the measured house caption (font,
//          size, colour, outline, shadow, background box, position, case),
//          plus the highlight colour, the entrance, and the effect stack.
//   shape  how spoken words are cut into captions (CaptionShape in types.ts).
//
// ⛔ SIZES ARE STORED AT THE HEIGHT THEY WERE SET ON (`refHeight`) AND SCALED TO
// THE SEQUENCE THEY LAND IN. The house caption scales with the frame, so a style
// saved on a 1080x1920 Short and used on a 16:9 video comes out the same size on
// screen. A style kept from before 2026-10-03 has no refHeight and is applied in
// absolute pixels, exactly as it always was, because nobody wrote down which
// frame it was captured on and guessing would change captions he already likes.
//
// Pure: no store, no DOM, no persistence.

import { applyAppearanceToClip } from '../anim/appearance'
import { CAPTION_FONT_STACK } from '../render/titleFonts'
import { clipDurationS } from '../timeline'
import {
  newTitleClip,
  type AppearanceSpec,
  type CaptionShape,
  type Clip,
  type EffectInstance,
  type TitleDef,
} from '../types'
import {
  AUTO_CAPTION_OPTIONS,
  CAPTION_EMPHASIS_COLORS,
  chunkWords,
  jettismCaptionDef,
  spreadWords,
  type CaptionWord,
  type ChunkOptions,
} from './captions'

export type { CaptionShape } from '../types'

/**
 * Every title field a style can carry. The text is the caption's own.
 *
 * ⛔ NULL MEANS "NONE", AND IT HAS TO BE NULL. A style with no outline must take
 * the house outline away, and an `undefined` field does not survive being saved:
 * JSON drops the key, the house outline shows through on the next launch, and
 * the style he saved without an outline comes back with one. Absent still means
 * "keep the house value", which is what a look saved before this file read as.
 */
export type CaptionLook = { [K in keyof Omit<TitleDef, 'text'>]?: TitleDef[K] | null }

export interface CaptionStyle {
  id: string
  name: string
  /** Patched over the measured house caption. Empty is the house look itself. */
  look: CaptionLook
  /**
   * The frame height the look's pixel sizes were set on. Absent means absolute
   * pixels: a style kept from before 2026-10-03 (see the note at the top).
   */
  refHeight?: number
  shape: CaptionShape
  /** The colour of the word the highlight picks. The switch itself is his, per run. */
  emphasisColor: string
  /** Entrance and exit. Absent is the house hard cut. */
  appearance?: AppearanceSpec
  /** The effect stack every caption gets, copied per clip. */
  effects?: EffectInstance[]
  builtin?: boolean
  updatedAt: number
}

/** The measured house look, and what every install starts on. */
export const HOUSE_STYLE_ID = 'house'

/** The frame height the built in styles are written for. */
export const CAPTION_REF_HEIGHT = 1920

export const DEFAULT_EMPHASIS_COLOR = CAPTION_EMPHASIS_COLORS[0]

/** The measured auto cut, with fixed length settings ready for when he switches. */
export const AUTO_SHAPE: CaptionShape = {
  length: 'auto',
  maxWords: 3,
  charsPerLine: 20,
  lines: 1,
  minDurS: AUTO_CAPTION_OPTIONS.minDurS,
  gapFrames: 0,
}

/** What each shaping setting may be set to. The panel and the cleaner both read this. */
export const SHAPE_LIMITS = {
  maxWords: { min: 1, max: 12 },
  charsPerLine: { min: 6, max: 60 },
  minDurS: { min: 0.1, max: 3 },
  gapFrames: { min: 0, max: 30 },
} as const

/** The built in styles. Read only: he saves a copy to change one. */
export const BUILTIN_CAPTION_STYLES: readonly CaptionStyle[] = [
  {
    id: HOUSE_STYLE_ID,
    name: 'House style',
    builtin: true,
    // Empty on purpose: the house caption IS jettismCaptionDef, measured off the
    // reference frames and scaled to every sequence. Anything written here would
    // be a copy of it that could drift.
    look: {},
    shape: AUTO_SHAPE,
    emphasisColor: DEFAULT_EMPHASIS_COLOR,
    updatedAt: 0,
  },
  {
    id: 'builtin-yellow-pop',
    name: 'Yellow punch',
    builtin: true,
    look: { textCase: 'upper', color: '#FFD400', outline: { color: '#000000', widthPx: 14 } },
    refHeight: CAPTION_REF_HEIGHT,
    shape: AUTO_SHAPE,
    emphasisColor: '#3B7DFF',
    appearance: { in: 'pop', out: 'popOut', durS: 0.16 },
    updatedAt: 0,
  },
  {
    id: 'builtin-clean',
    name: 'Clean fade',
    builtin: true,
    look: { textCase: null, color: '#ffffff', outline: { color: '#000000', widthPx: 6 } },
    refHeight: CAPTION_REF_HEIGHT,
    shape: AUTO_SHAPE,
    emphasisColor: DEFAULT_EMPHASIS_COLOR,
    appearance: { in: 'fadeIn', out: 'fadeOut', durS: 0.2 },
    updatedAt: 0,
  },
  {
    // The Premiere default, for a video that wants subtitles rather than the
    // word by word look: whole phrases in two balanced lines on a dark box,
    // low in the frame but clear of the Shorts buttons.
    id: 'builtin-subtitles',
    name: 'Subtitles',
    builtin: true,
    look: {
      fontFamily: CAPTION_FONT_STACK,
      fontSizePx: 64,
      bold: true,
      color: '#ffffff',
      outline: null,
      shadow: null,
      box: { color: 'rgba(0,0,0,0.6)', paddingPx: 18, radiusPx: 8 },
      vAlign: 'bottom',
      offsetYPx: -380,
      lineHeight: 1.2,
    },
    refHeight: CAPTION_REF_HEIGHT,
    shape: { length: 'fixed', maxWords: 8, charsPerLine: 24, lines: 2, minDurS: 0.7, gapFrames: 2 },
    emphasisColor: DEFAULT_EMPHASIS_COLOR,
    updatedAt: 0,
  },
]

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Any stored or typed shape, made safe: every field present and inside its limits. */
export function cleanShape(raw: unknown): CaptionShape {
  const r = (raw ?? {}) as Partial<CaptionShape>
  const L = SHAPE_LIMITS
  return {
    length: r.length === 'fixed' ? 'fixed' : 'auto',
    maxWords: Math.round(clamp(num(r.maxWords, AUTO_SHAPE.maxWords), L.maxWords.min, L.maxWords.max)),
    charsPerLine: Math.round(clamp(num(r.charsPerLine, AUTO_SHAPE.charsPerLine), L.charsPerLine.min, L.charsPerLine.max)),
    lines: r.lines === 2 ? 2 : 1,
    minDurS: Math.round(clamp(num(r.minDurS, AUTO_SHAPE.minDurS), L.minDurS.min, L.minDurS.max) * 100) / 100,
    gapFrames: Math.round(clamp(num(r.gapFrames, AUTO_SHAPE.gapFrames), L.gapFrames.min, L.gapFrames.max)),
  }
}

/**
 * Would these two cut the same words into the same captions? The fixed length
 * settings only count when the length is fixed: an auto style that happens to
 * remember "4 words" from an earlier switch cuts exactly like one that says 3.
 */
export function sameShape(a: CaptionShape, b: CaptionShape): boolean {
  if (a.length !== b.length || a.minDurS !== b.minDurS || a.gapFrames !== b.gapFrames) return false
  if (a.length === 'auto') return true
  return a.maxWords === b.maxWords && a.charsPerLine === b.charsPerLine && a.lines === b.lines
}

/**
 * The chunker settings for a shape.
 *
 * AUTO is AUTO_CAPTION_OPTIONS untouched, so a style that leaves the length on
 * auto cuts exactly what every caption run has cut since 2026-07-29.
 *
 * FIXED keeps every rule that makes a caption match the voice, and that is the
 * part that answers his 2026-07-28 complaint about the old words per caption
 * dial (*"it welds words together across the pauses"*): a pause and a sentence
 * end still always break, so a longer caption never sits on screen while he is
 * not saying it. What changes is only how full a caption may get: up to his
 * word count and his characters per line times his lines, with no target length
 * pulling it shorter. The on screen ceiling grows with the word count so a full
 * caption has time to be read, and still counts from its last word.
 */
export function chunkOptionsFor(shape: CaptionShape, fps: number): ChunkOptions {
  const gapS = shape.gapFrames > 0 ? shape.gapFrames / Math.max(1, fps) : 0
  if (shape.length === 'auto') return { ...AUTO_CAPTION_OPTIONS, minDurS: shape.minDurS, gapS }
  return {
    ...AUTO_CAPTION_OPTIONS,
    targetS: 0,
    maxWords: shape.maxWords,
    maxChars: shape.charsPerLine * shape.lines,
    maxOnScreenS: Math.min(8, AUTO_CAPTION_OPTIONS.maxOnScreenS + 0.6 * (shape.maxWords - 1)),
    minDurS: shape.minDurS,
    gapS,
  }
}

/**
 * Two lines, balanced: the break goes at the space that makes the longer line
 * as short as it can be, the way a subtitle is set. One line, auto length, or a
 * caption that already fits on one line is returned as it came.
 */
export function breakLines(text: string, shape: CaptionShape): string {
  if (shape.length !== 'fixed' || shape.lines !== 2) return text
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.join(' ').length <= shape.charsPerLine) return words.join(' ')
  let best = 1
  let bestLen = Infinity
  for (let i = 1; i < words.length; i++) {
    const longer = Math.max(words.slice(0, i).join(' ').length, words.slice(i).join(' ').length)
    // Ties go to the shorter top line, which reads as the natural pyramid.
    if (longer < bestLen) {
      best = i
      bestLen = longer
    }
  }
  return `${words.slice(0, best).join(' ')}\n${words.slice(best).join(' ')}`
}

/** Every pixel size in a look, times k. Fonts never go below 1px. */
export function scaleLook(look: CaptionLook, k: number): CaptionLook {
  if (Math.abs(k - 1) < 1e-9) return look
  const r = (v: number): number => Math.round(v * k)
  const out: CaptionLook = { ...look }
  if (typeof look.fontSizePx === 'number') out.fontSizePx = Math.max(1, r(look.fontSizePx))
  if (typeof look.offsetXPx === 'number') out.offsetXPx = r(look.offsetXPx)
  if (typeof look.offsetYPx === 'number') out.offsetYPx = r(look.offsetYPx)
  if (look.outline) out.outline = { ...look.outline, widthPx: r(look.outline.widthPx) }
  if (look.shadow) {
    out.shadow = { ...look.shadow, blurPx: r(look.shadow.blurPx), dx: r(look.shadow.dx), dy: r(look.shadow.dy) }
  }
  if (look.box) out.box = { ...look.box, paddingPx: r(look.box.paddingPx), radiusPx: r(look.box.radiusPx) }
  return out
}

/** The style's look in this sequence's pixels. */
export function lookAt(style: Pick<CaptionStyle, 'look' | 'refHeight'>, seqHeight: number): CaptionLook {
  return scaleLook(style.look, style.refHeight ? seqHeight / style.refHeight : 1)
}

/**
 * The full title a caption in this style gets: the house caption at this
 * height, the style over it, and the highlight colour on the word he leaned on.
 */
export function captionDefFor(
  style: Pick<CaptionStyle, 'look' | 'refHeight' | 'emphasisColor'>,
  text: string,
  seqHeight: number,
  emphasized = false,
): TitleDef {
  const def = { ...jettismCaptionDef(text, seqHeight) } as Record<string, unknown>
  for (const [k, v] of Object.entries(lookAt(style, seqHeight))) {
    if (v === null) delete def[k]
    else if (v !== undefined) def[k] = v
  }
  const out = { ...def, text } as unknown as TitleDef
  if (emphasized) out.color = style.emphasisColor
  return out
}

/**
 * Dress one caption clip in a style: the title, the entrance and the effects.
 * The text, timing and everything the run stamped on it are kept.
 *
 * The entrance follows the style both ways, because it is part of the look: a
 * hard cut style takes a pop away. The effect stack only arrives: a style with
 * none leaves the blur or grade he put on one caption alone.
 */
export function dressCaption(clip: Clip, style: CaptionStyle, seqWidth: number, seqHeight: number): Clip {
  if (!clip.title) return clip
  let next: Clip = { ...clip, title: captionDefFor(style, clip.title.text, seqHeight, clip.captionEmphasis === true) }
  // Copied per clip, never shared: editing one caption's effect must not change another.
  if (style.effects?.length) next = { ...next, effects: style.effects.map((e) => ({ ...e })) }
  if (style.appearance) next = applyAppearanceToClip(next, style.appearance, seqWidth, seqHeight)
  else if (next.appearance) next = applyAppearanceToClip(next, {}, seqWidth, seqHeight)
  return next
}

/** One word read back off a caption clip, and which clip it came from. */
interface SourcedWord extends CaptionWord {
  source: number
}

/**
 * The words on screen, read back off finished captions so they can be cut
 * again at a different length.
 *
 * A one word caption gives its word back exactly. A caption holding several
 * spreads them across its time the way the manual split does, which is exact at
 * every caption's edges and close inside one. At a pause, the hold the run added
 * after the last word is taken back off, so cutting the same captions twice does
 * not push them later each time.
 */
function wordsOnScreen(clips: readonly Clip[], holdS: number, maxGapS: number): SourcedWord[] {
  const out: SourcedWord[] = []
  clips.forEach((clip, i) => {
    const text = clip.title?.text ?? ''
    const startS = clip.startS
    let endS = startS + clipDurationS(clip)
    const next = clips[i + 1]
    if (!next || next.startS - endS > maxGapS) endS = Math.max(startS + 0.05, endS - holdS)
    const tokens = text.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return
    const emphasis = clip.captionEmphasis === true
    const words: CaptionWord[] =
      tokens.length === 1
        ? [{ text: tokens[0]!, startS, endS }]
        : spreadWords(tokens.map((t) => t.replace(/^\*(.+)\*$/, '$1')).join(' '), startS, endS - startS)
    for (const w of words) out.push({ text: w.text, startS: w.startS, endS: w.endS, ...(emphasis ? { emphasis: true } : {}), source: i })
  })
  return out
}

/**
 * Cut finished captions again at a style's length, and dress them in its look.
 *
 * What he typed survives: the words are read off the clips, not off the
 * recogniser, so every correction he made is in the result. A new caption that
 * is exactly some of the old ones put together keeps what the speech model
 * originally said, joined, so the style learning still has its pairs; one that
 * splits an old caption has no honest original and carries none.
 */
export function recutCaptions(
  clips: readonly Clip[],
  style: CaptionStyle,
  seq: { width: number; height: number; fps: number },
): Clip[] {
  const sorted = clips.filter((c) => c.title).slice().sort((a, b) => a.startS - b.startS)
  if (sorted.length === 0) return []
  const options = chunkOptionsFor(style.shape, seq.fps)
  const words = wordsOnScreen(sorted, AUTO_CAPTION_OPTIONS.holdS, options.maxGapS ?? AUTO_CAPTION_OPTIONS.maxGapS)
  const chunks = chunkWords(words, options)
  // How many words each old caption gave, to tell a whole caption from a piece.
  const perSource = new Map<number, number>()
  for (const w of words) perSource.set(w.source, (perSource.get(w.source) ?? 0) + 1)

  return chunks.map((chunk) => {
    const inside = words.filter((w) => w.startS >= chunk.startS - 1e-6 && w.startS < chunk.endS - 1e-6)
    const sources = [...new Set(inside.map((w) => w.source))]
    const whole = sources.length > 0 && sources.every((s) => inside.filter((w) => w.source === s).length === perSource.get(s))
    const origins = sources.map((s) => sorted[s]!.captionOrigin)
    const model = origins[0]?.model
    const keepsOrigin = whole && model !== undefined && origins.every((o) => o?.model === model)
    const first = sorted[sources[0] ?? 0]!
    let clip = newTitleClip(
      captionDefFor(style, breakLines(chunk.text, style.shape), seq.height, chunk.emphasis),
      chunk.startS,
      chunk.endS - chunk.startS,
    )
    if (chunk.emphasis) clip = { ...clip, captionEmphasis: true }
    if (keepsOrigin) clip = { ...clip, captionOrigin: { text: origins.map((o) => o!.text).join(' '), model: model! } }
    // A style with no effects keeps the ones the first of its words wore.
    if (!style.effects?.length && first.effects.length) clip = { ...clip, effects: first.effects.map((e) => ({ ...e })) }
    return dressCaption(clip, style, seq.width, seq.height)
  })
}

/** The fields a style keeps from a title. Everything but the words. */
const LOOK_FIELDS = [
  'fontFamily',
  'fontSizePx',
  'bold',
  'italic',
  'textCase',
  'color',
  'outline',
  'shadow',
  'box',
  'align',
  'vAlign',
  'offsetXPx',
  'offsetYPx',
  'lineHeight',
  'invertBackdrop',
] as const satisfies readonly (keyof TitleDef)[]

/**
 * A title's look, as a style holds it: every field written out, the ones it
 * does not have as null so they stay off after a save. Nested objects are copied.
 */
export function lookOfTitle(title: TitleDef): CaptionLook {
  const out: Record<string, unknown> = {}
  for (const k of LOOK_FIELDS) {
    const v = title[k]
    out[k] = v === undefined ? null : v && typeof v === 'object' ? { ...v } : v
  }
  return out as CaptionLook
}

/** Read one stored style, or null for anything that is not one. */
export function cleanStyle(raw: unknown): CaptionStyle | null {
  const r = raw as Partial<CaptionStyle> | null
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.name !== 'string') return null
  const look = r.look && typeof r.look === 'object' ? (r.look as CaptionLook) : {}
  return {
    id: r.id,
    name: r.name.trim() || 'Caption style',
    look,
    ...(typeof r.refHeight === 'number' && r.refHeight > 0 ? { refHeight: r.refHeight } : {}),
    shape: cleanShape(r.shape),
    emphasisColor: typeof r.emphasisColor === 'string' && r.emphasisColor ? r.emphasisColor : DEFAULT_EMPHASIS_COLOR,
    ...(r.appearance && typeof r.appearance === 'object' ? { appearance: r.appearance } : {}),
    ...(Array.isArray(r.effects) && r.effects.length ? { effects: r.effects } : {}),
    updatedAt: num(r.updatedAt, 0),
  }
}

/** The shape of a look preset saved before caption styles existed (state/textPresets.ts). */
export interface LegacyTextPreset {
  id: string
  name: string
  style: Partial<TitleDef>
  appearance?: AppearanceSpec
  effects?: EffectInstance[]
}

/**
 * A look he saved before 2026-10-03, as a caption style that makes exactly the
 * captions it made then: its pixels absolute (no refHeight), the auto cut every
 * caption had, and the highlight colour the run always used. Same id, so the
 * default he had picked still points at it.
 */
export function styleFromLegacyPreset(p: LegacyTextPreset, at: number): CaptionStyle | null {
  if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') return null
  const style = p.style && typeof p.style === 'object' ? { ...p.style } : {}
  delete (style as Partial<TitleDef>).text
  return {
    id: p.id,
    name: p.name,
    look: style as CaptionLook,
    shape: AUTO_SHAPE,
    emphasisColor: DEFAULT_EMPHASIS_COLOR,
    ...(p.appearance ? { appearance: p.appearance } : {}),
    ...(p.effects?.length ? { effects: p.effects } : {}),
    updatedAt: at,
  }
}
