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
import { CAPTION_FONT_STACK, COMIC_STACK, OSWALD_STACK } from '../render/titleFonts'
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
  CAPTION_POP_DUR_S,
  captionCase,
  chunkWords,
  jettismCaptionDef,
  litWordColors,
  saidWords,
  spreadWords,
  type CaptionWord,
  type ChunkOptions,
} from './captions'
import { captionFitter, fitWordsToFrame } from './captionFit'
import { WORD_POP_SIZE } from './wordPop'

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
  /**
   * 'spoken' keeps his capitals and full stops. Absent is the house lowercase,
   * which is what every style made before this existed, his saved ones too.
   */
  caseRule?: 'spoken'
  builtin?: boolean
  updatedAt: number
}

/** The measured house look, and what every install starts on. */
export const HOUSE_STYLE_ID = 'house'

/** The frame height the built in styles are written for. */
export const CAPTION_REF_HEIGHT = 1920

export const DEFAULT_EMPHASIS_COLOR = CAPTION_EMPHASIS_COLORS[0]

/** The Word box colours off his frame: a dark see-through fill and a crimson border. */
export const DEFAULT_WORD_BOX: NonNullable<TitleDef['wordBox']> = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }

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
  {
    // ItsOveon's captions. His ask, 2026-10-12: *"look at Oveon's font and copy
    // it exactly"*. Measured off the frames of one of Oveon's own Shorts at
    // 1080x1920, not guessed: Lilita One (the closest of every free comic face
    // laid over Oveon's letters), white, a black outline about 12 px wide as it
    // shows (the raster strokes under the fill, so half of widthPx shows), no
    // shadow, no box, the letters 218 px tall at 1920 and centred on the frame.
    // One word at a time, in the case it was said, popping in on the house pop
    // (the same 0.1 s grow Oveon's frames show) and cut straight out. A long word
    // is drawn smaller to fit the width, the way Oveon's "Everybody" is.
    // ⛔ bold is OFF: Lilita has one weight, and asking for 700 draws a smeared
    // fake bold that Oveon's letters do not have.
    id: 'builtin-oveon',
    name: 'Oveon',
    builtin: true,
    look: {
      fontFamily: COMIC_STACK,
      fontSizePx: 218,
      bold: false,
      color: '#ffffff',
      outline: { color: '#000000', widthPx: 25 },
      shadow: null,
      box: null,
      textCase: null,
      vAlign: 'middle',
      offsetYPx: 0,
      lineHeight: 1.2,
    },
    refHeight: CAPTION_REF_HEIGHT,
    shape: { length: 'fixed', maxWords: 1, charsPerLine: 20, lines: 1, minDurS: AUTO_SHAPE.minDurS, gapFrames: 0 },
    emphasisColor: DEFAULT_EMPHASIS_COLOR,
    caseRule: 'spoken',
    appearance: { in: 'pop', durS: CAPTION_POP_DUR_S },
    updatedAt: 0,
  },
  {
    // His ask, 2026-10-19, with a frame of a Short: *"Look at this text ...
    // completely copy the system ... Also add it as an option if I want to
    // highlight my text too."* Three words at a time in white capitals with a dark
    // outline, and a rounded box with a crimson border and a dark see-through fill
    // round the word being said. The box is an overlay: it never moves a word.
    // Measured off his frame, not guessed:
    //   face     Oswald 700. The ink of the whole line and of each word, against
    //            the height of its capitals, is within 4% of his; Montserrat, the
    //            house face, is 58% too wide. The stems match as well (0.22 of the
    //            cap height against his 0.21).
    //   size     91 px at 1920: the caps come out 74 px tall, the house caption's
    //            own cap height (105 px of Montserrat at 0.70), so the line fills
    //            the frame the way the house caption does.
    //   outline  13 px: 0.06 of his frame's em shows outside the letters (the
    //            raster strokes under the fill, so half of widthPx shows), and
    //            his frame's em is 25 px of caps over 0.694, which is 106 px here.
    //   box      colours only here. The shape is fixed in em (titleRaster.ts).
    id: 'builtin-word-box',
    name: 'Word box',
    builtin: true,
    look: {
      fontFamily: OSWALD_STACK,
      fontSizePx: 91,
      bold: true,
      color: '#ffffff',
      outline: { color: '#000000', widthPx: 13 },
      shadow: null,
      box: null,
      textCase: 'upper',
      vAlign: 'middle',
      offsetYPx: 0,
      lineHeight: 1.1,
      wordBox: { ...DEFAULT_WORD_BOX },
      // The box swells with the word being said: a small pop, the letters stay white.
      wordPopSize: WORD_POP_SIZE,
    },
    refHeight: CAPTION_REF_HEIGHT,
    shape: { length: 'fixed', maxWords: 3, charsPerLine: 20, lines: 1, minDurS: AUTO_SHAPE.minDurS, gapFrames: 0 },
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
 * caption has time to be read, and still counts from its last word. And the key
 * word highlight is coloured inside the phrase instead of cut out of it (CA-13).
 */
export function chunkOptionsFor(
  shape: CaptionShape,
  fps: number,
  /** Does a group fit across the frame (captionFitterFor)? Absent counts letters only. */
  fits: ((text: string) => boolean) | null = null,
): ChunkOptions {
  const gapS = shape.gapFrames > 0 ? shape.gapFrames / Math.max(1, fps) : 0
  // Every caption on the sequence's frames (captions.ts putOnFrames). A rate
  // that is not a real one leaves the times alone rather than inventing a grid.
  const onFrames = Number.isFinite(fps) && fps > 0 ? fps : 0
  if (shape.length === 'auto') return { ...AUTO_CAPTION_OPTIONS, minDurS: shape.minDurS, gapS, fps: onFrames, fits }
  return {
    ...AUTO_CAPTION_OPTIONS,
    targetS: 0,
    maxWords: shape.maxWords,
    maxChars: shape.charsPerLine * shape.lines,
    maxOnScreenS: Math.min(8, AUTO_CAPTION_OPTIONS.maxOnScreenS + 0.6 * (shape.maxWords - 1)),
    minDurS: shape.minDurS,
    gapS,
    fps: onFrames,
    fits,
    emphasisBreaks: false,
  }
}

/**
 * Does a group of words fit one caption of this style in this frame: its lines
 * (one for auto), its size scaled to the frame, its case. `prepare` is what
 * the run does to the words before they are shown (the house case). A two line
 * style then breaks them (breakLines) as the run does, so the fitter measures
 * the two paragraphs that are drawn and not the words flowed as one.
 */
export function captionFitterFor(
  style: Pick<CaptionStyle, 'look' | 'refHeight' | 'emphasisColor' | 'shape'>,
  seq: { width: number; height: number },
  prepare?: (text: string) => string,
): (text: string) => boolean {
  const lines = style.shape.length === 'fixed' ? style.shape.lines : 1
  const shown = (text: string): string => breakLines(prepare ? prepare(text) : text, style.shape)
  return captionFitter(captionDefFor(style, '', seq.height), seq.width, lines, shown)
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
  const cased = inStyleCase(clip, style)
  // A word wider than the line is drawn smaller rather than off the frame.
  const def = captionDefFor(style, cased.text, seqHeight, clip.captionEmphasis === true)
  // The word he leaned on, lit inside a longer caption in this style's colour (CA-13).
  const lit = clip.captionEmphasis ? undefined : litWordColors(cased.words ?? clip.captionWords, style.emphasisColor)
  const title = fitWordsToFrame(lit ? { ...def, wordColors: lit } : def, seqWidth)
  let next: Clip = { ...clip, title, ...(cased.words ? { captionWords: cased.words } : {}) }
  // Copied per clip, never shared: editing one caption's effect must not change another.
  if (style.effects?.length) next = { ...next, effects: style.effects.map((e) => ({ ...e })) }
  if (style.appearance) next = applyAppearanceToClip(next, style.appearance, seqWidth, seqHeight)
  else if (next.appearance) next = applyAppearanceToClip(next, {}, seqWidth, seqHeight)
  return next
}

/**
 * The caption's words in the style's case rule, when he has not touched them.
 *
 * A caption's text is cased once, when the run makes it, so putting a style
 * that says "As spoken" on house captions changed nothing anyone could see.
 * What the machine said is kept on the clip (captionOrigin), so a caption that
 * still reads exactly as either rule wrote it can be written again in the
 * other. A caption he retyped is his, and stays as he typed it.
 */
function inStyleCase(clip: Clip, style: Pick<CaptionStyle, 'caseRule' | 'shape'>): { text: string; words?: Clip['captionWords'] } {
  const text = clip.title?.text ?? ''
  const origin = clip.captionOrigin?.text
  if (origin === undefined) return { text }
  const flat = text.replace(/\s+/g, ' ').trim()
  const rule = style.caseRule ?? 'house'
  const want = captionCase(origin, rule)
  if (flat === want || (flat !== captionCase(origin, 'house') && flat !== captionCase(origin, 'spoken'))) return { text }
  const next = text.includes('\n') ? breakLines(want, style.shape) : want
  const tokens = want.split(' ')
  const kept = clip.captionWords
  const words = kept && kept.length === tokens.length ? kept.map((w, i) => ({ ...w, text: tokens[i]! })) : undefined
  return { text: next, words }
}

/** One word read back off a caption clip, and which clip it came from. */
interface SourcedWord extends CaptionWord {
  source: number
}

/**
 * The words this caption still says, at the times they were said, or null once
 * he has retyped it (or trimmed a word off), because then those times belong
 * to words that are not there.
 */
function wordsAsSaid(clip: Clip, tokens: readonly string[]): CaptionWord[] | null {
  const kept = clip.captionWords
  if (!kept || kept.length !== tokens.length || kept.some((w, i) => w.text !== tokens[i])) return null
  const rate = Math.abs(clip.speed) || 1
  const startS = clip.startS
  const endS = startS + clipDurationS(clip)
  // Clip time to timeline: a trim or a split moved the in point, not the words.
  const at = (t: number): number => startS + (t - clip.inS) / rate
  const words = kept.map((w) => ({ text: w.text, startS: at(w.startS), endS: at(w.endS), lit: w.emphasis === true }))
  // The first word may sit a hair before the caption: its start went onto a frame.
  if (words.some((w) => w.startS < startS - 0.05 || w.startS >= endS)) return null
  let floor = startS
  return words.map((w) => {
    const s = Math.max(floor, w.startS)
    floor = s
    return { text: w.text, startS: s, endS: Math.min(endS, Math.max(s + 1e-3, w.endS)), ...(w.lit ? { emphasis: true } : {}) }
  })
}

/**
 * A caption after a cut in the Words tab took some of its time away: it says
 * only the words still said inside it, or it is null when none are (a sliver
 * of hold left after a word that was cut). Before this both halves of a split
 * caption kept the whole text, so cutting "like" out of "and like" still read
 * "and like". A caption with no word times, or one he retyped, is left as it is.
 *
 * ⛔ ONLY THE EDGE THE CUT MADE DROPS WORDS (R-1). `cut` says which edges of
 * this piece are a cut: `start` for the piece after the cut, `end` for the
 * piece before it. An edge the cut never touched keeps every word, even one
 * whose middle plays past it, because a caption can already end before its
 * last word's middle with no cut at all: a style's gap ends it two frames
 * early, he trimmed it, or frame rounding moved it. Reading every edge used to
 * drop that last word off captions far from the cut, or delete a one word
 * caption outright, all over the video, on one cut of one "um".
 */
export function captionAfterCut(clip: Clip, cut: { start: boolean; end: boolean }): Clip | null {
  const kept = clip.captionWords
  const tokens = (clip.title?.text ?? '').split(/\s+/).filter(Boolean)
  if (!clip.title || !kept || kept.length !== tokens.length || kept.some((w, i) => w.text !== tokens[i])) return clip
  if (!cut.start && !cut.end) return clip
  const rate = Math.abs(clip.speed) || 1
  const endS = clip.startS + clipDurationS(clip)
  // A word belongs to the piece its middle plays in: its edges sit on the cut.
  const inside = kept.filter((w) => {
    const mid = clip.startS + ((w.startS + w.endS) / 2 - clip.inS) / rate
    return (!cut.start || mid >= clip.startS - 1e-6) && (!cut.end || mid < endS)
  })
  if (inside.length === kept.length) return clip
  if (inside.length === 0) return null
  return { ...clip, title: { ...clip.title, text: inside.map((w) => w.text).join(' ') }, captionWords: inside }
}

/**
 * A caption the cut did not touch, that still says a word the cut took (S-2):
 * a style's gap ends a caption a couple of frames early, so its last word plays
 * past its end, and a cut that starts where the caption ends takes that word
 * while the caption keeps its id and its out point. `was` is the caption as it
 * was before the cut, `now` the same caption after it. Its words whose middle
 * played inside the cut are dropped; null when none are left.
 */
export function captionWithoutCutWords(was: Clip, now: Clip, cut: { startS: number; endS: number }): Clip | null {
  const kept = now.captionWords
  const tokens = (now.title?.text ?? '').split(/\s+/).filter(Boolean)
  if (!now.title || !kept || kept.length !== tokens.length || kept.some((w, i) => w.text !== tokens[i])) return now
  const rate = Math.abs(was.speed) || 1
  const left = kept.filter((w) => {
    const mid = was.startS + ((w.startS + w.endS) / 2 - was.inS) / rate
    return !(mid >= cut.startS - 1e-6 && mid < cut.endS - 1e-6)
  })
  if (left.length === kept.length) return now
  if (left.length === 0) return null
  return { ...now, title: { ...now.title, text: left.map((w) => w.text).join(' ') }, captionWords: left }
}

/**
 * The words on screen, read back off finished captions so they can be cut
 * again at a different length.
 *
 * ⛔ A CAPTION THAT STILL SAYS WHAT IT WAS MADE WITH GIVES EVERY WORD BACK AT
 * THE TIME HE SAID IT (captionWords). Spreading by letter count is exact only
 * at a caption's edges, so auto, then Subtitles, then auto again put every word
 * start where its letters said and not where he said it, undoing the timing fix
 * of c022d56 on every round trip.
 *
 * Otherwise (he retyped it, or it came from before word times were kept): a one
 * word caption gives its word back exactly, and a caption holding several
 * spreads them across its time the way the manual split does. At a pause, the
 * hold the run added after the last word is taken back off, so cutting the same
 * captions twice does not push them later each time.
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
      wordsAsSaid(clip, tokens) ??
      (tokens.length === 1
        ? [{ text: tokens[0]!, startS, endS }]
        : spreadWords(tokens.map((t) => t.replace(/^\*(.+)\*$/, '$1')).join(' '), startS, endS - startS))
    for (const w of words) {
      out.push({ text: w.text, startS: w.startS, endS: w.endS, ...(emphasis || w.emphasis ? { emphasis: true } : {}), source: i })
    }
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
  const options = chunkOptionsFor(style.shape, seq.fps, captionFitterFor(style, seq))
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
    const said = saidWords(chunk, chunk.text)
    if (said) clip = { ...clip, captionWords: said }
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
  // The box round the word being said: his colours only, the shape is fixed.
  'wordBox',
  // The word being said, lit in a colour of its own, and swelling a little as it is said.
  'wordPop',
  'wordPopSize',
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
    ...(r.caseRule === 'spoken' ? { caseRule: 'spoken' as const } : {}),
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
