// Does a caption fit across the frame? Measured, not counted in letters.
//
// The auto cut used to cap a caption at 14 letters, and 14 was measured for
// LOWERCASE house captions on a 1080x1920 frame. An UPPERCASE style, a style he
// made bigger, or the taller Phone frame (the font grows with the height, the
// width does not) put "SOMETHING ELSE" on two lines, and a long single word ran
// past the side margin. So the chunker now asks this file whether the words fit
// in the lines the style allows, at the style's own size and case, and a single
// word too wide for the line is drawn smaller instead of off the frame.
//
// The widths must be the ones the rasterizer gets from ctx.measureText, or the
// fitter and the drawing disagree about where a line wraps. They are: the three
// faces the built in styles draw in (Montserrat at the weight 800 the app pins
// it to, Lilita One, Oswald at 700) each have their advances AND their kerning
// pairs in captionFontMetrics.ts, measured in Chromium itself. A table and not
// a canvas, so node tests, the preview and the export all get the same answer.
//
// Why kerning matters, 2026-10-20: with advances alone "AWAKE DOESN'T REALLY"
// in the Word box read 961 px against a 950 px line, so the fitter cut it into
// two captions when it draws as 948.7 px and fits. That left 1.3 px of room, too
// little for a safety margin to be the answer, so the fitter measures what the
// canvas measures, to a hundredth of a pixel or better. The same file also had
// Montserrat at 700 while the app pins the face to 800, which is the dangerous
// way to be off (up to 25 units per 1000 em too narrow): a house caption the
// fitter passed could wrap on the canvas.
//
// Any other font is still an ESTIMATE: Montserrat's 700 widths with no
// kerning, close for the sans fonts and rougher for the rest. A font with no
// metrics here can still wrap a line the fitter let through.
//
// Pure: no canvas, no store.

import { wrapLinesWith } from '../render/titleRaster'
import type { TitleDef } from '../types'
import { LILITA_METRICS, MONTSERRAT_METRICS, OSWALD_METRICS, type FontMetrics } from './captionFontMetrics'

/** Montserrat at weight 700, advance per 1000 em, for ' ' (32) to '~' (126). The estimate for a font with no metrics. */
const ESTIMATE_ADVANCE = [
  283, 289, 437, 720, 638, 877, 728, 230, 357, 358, 434, 599, 262, 386, 262, 392, 679, 392, 590, 592, 689, 595, 637, 620,
  660, 637, 262, 262, 599, 599, 599, 589, 1035, 766, 765, 724, 826, 671, 639, 771, 808, 328, 541, 740, 604, 955, 808,
  844, 732, 844, 735, 638, 618, 788, 746, 1163, 714, 676, 671, 368, 392, 368, 600, 500, 600, 617, 690, 591, 692, 631,
  387, 700, 691, 301, 307, 655, 301, 1049, 691, 655, 690, 690, 431, 531, 435, 687, 598, 937, 595, 598, 543, 391, 309,
  391, 599,
] as const

/** What a font with no metrics of its own is measured as. */
const ESTIMATE: FontMetrics = { advance: ESTIMATE_ADVANCE }

/** A character outside the table and with no plain letter under it: about a capital's width. */
const OTHER = 720

/**
 * What one emoji is reserved, per 1000 em. An emoji is drawn from the emoji face
 * (the Apple set first, emojiFont.ts), never the title's own font, and is about
 * an em wide there, so 1.1 em keeps the fitter on the safe side of it. Counted per
 * GRAPHEME: a skin tone (👍🏽) or a ZWJ family is several code points drawn as
 * one picture, and code point by code point it read as two to seven unknown
 * characters, up to five times too wide.
 */
const EMOJI = 1100

/** Any emoji at all; the fast path skips the grapheme split for plain text. */
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}/u

let graphemes: Intl.Segmenter | null = null

/** A font stack that starts with this family (quoted or not), as the title fonts spell it. */
const leading = (family: string): RegExp => new RegExp(`^\\s*['"]?${family}['"]?\\s*(,|$)`, 'i')
const LEADS_MONTSERRAT = leading('Montserrat')
const LEADS_LILITA = leading('Lilita One')
const LEADS_OSWALD = leading('Oswald')

/** The metrics for a font stack: the face that leads it when we have measured it, the estimate otherwise. */
function metricsFor(fontFamily?: string): FontMetrics {
  if (!fontFamily) return ESTIMATE
  if (LEADS_MONTSERRAT.test(fontFamily)) return MONTSERRAT_METRICS
  if (LEADS_LILITA.test(fontFamily)) return LILITA_METRICS
  if (LEADS_OSWALD.test(fontFamily)) return OSWALD_METRICS
  return ESTIMATE
}

/** A font's metrics unpacked once into lookups: its ligature pattern, the class of each left and right character, and units by class pair. */
interface Compiled {
  readonly fuse: RegExp | null
  readonly left: ReadonlyMap<string, number>
  readonly right: ReadonlyMap<string, number>
  readonly units: ReadonlyMap<number, number>
  readonly stride: number
}

const compiled = new WeakMap<FontMetrics, Compiled>()

function compile(metrics: FontMetrics): Compiled {
  let made = compiled.get(metrics)
  if (!made) {
    const classes = (lists: readonly string[]): Map<string, number> => {
      const out = new Map<string, number>()
      lists.forEach((chars, i) => {
        for (const ch of chars) out.set(ch, i + 1)
      })
      return out
    }
    const kern = metrics.kern
    const stride = (kern?.right.length ?? 0) + 1
    const units = new Map<number, number>()
    const pairs = kern?.pairs ?? []
    for (let i = 0; i + 2 < pairs.length; i += 3) units.set(pairs[i]! * stride + pairs[i + 1]!, pairs[i + 2]!)
    // Longest first, so ffi is taken before ff and fi before f.
    const letters = Object.keys(metrics.ligatures ?? {}).sort((x, y) => y.length - x.length)
    made = {
      fuse: letters.length ? new RegExp(letters.join('|'), 'g') : null,
      left: classes(kern?.left ?? []),
      right: classes(kern?.right ?? []),
      units,
      stride,
    }
    compiled.set(metrics, made)
  }
  return made
}

/** Width of one character, per 1000 em. An accented letter is as wide as its plain one unless the font says otherwise. */
function advance(ch: string, metrics: FontMetrics): number {
  const at = (c: number): number | undefined => (c >= 32 && c <= 126 ? metrics.advance[c - 32] : undefined)
  return at(ch.charCodeAt(0)) ?? metrics.extra?.[ch] ?? at(ch.normalize('NFD').charCodeAt(0)) ?? OTHER
}

/**
 * How wide this text draws at this font size, in pixels, in this font stack
 * (the estimate when the stack leads with a font we have not measured). The
 * text is taken as the canvas shapes it: composed, so a letter typed as a base
 * plus a loose accent is one letter wide, and with the font's ligatures fused.
 */
export function captionTextWidthPx(text: string, fontSizePx: number, fontFamily?: string): number {
  const metrics = metricsFor(fontFamily)
  const c = compile(metrics)
  const ligatures = metrics.ligatures
  let shaped = text.normalize('NFC')
  if (c.fuse && ligatures) shaped = shaped.replace(c.fuse, (m) => ligatures[m] ?? m)
  let units = 0
  let prev = ''
  const add = (run: string): void => {
    for (const ch of run) {
      units += advance(ch, metrics)
      if (prev) {
        const l = c.left.get(prev)
        const r = c.right.get(ch)
        if (l !== undefined && r !== undefined) units += c.units.get(l * c.stride + r) ?? 0
      }
      prev = ch
    }
  }
  if (!HAS_PICTOGRAPH.test(shaped)) {
    add(shaped)
  } else {
    graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const { segment } of graphemes.segment(shaped)) {
      if (HAS_PICTOGRAPH.test(segment)) {
        // Another face draws it, so nothing kerns across it.
        units += EMOJI
        prev = ''
      } else {
        add(segment)
      }
    }
  }
  return (units / 1000) * fontSizePx
}

/** The width a title's lines may use in this frame: the frame less 6% each side (titleRaster.titleLayout). */
export const captionLineWidthPx = (frameW: number): number => Math.max(1, frameW - 2 * Math.round(frameW * 0.06))

/** The text as it is drawn: the title's case is applied at draw time, not stored. */
const drawn = (text: string, textCase: TitleDef['textCase']): string =>
  textCase === 'upper' ? text.toUpperCase() : textCase === 'lower' ? text.toLowerCase() : text

/**
 * "Do these words fit in `lines` lines of this caption?" for the chunker.
 * `prepare` turns the words it groups into the text the caption will hold
 * (the house case for a fresh run, and the hard line break of a two line
 * style), so what is measured is what is drawn. A '\n' in that text is a hard
 * break exactly as the rasterizer takes it: each side of it wraps on its own, so
 * a two line caption whose balanced halves are not both inside the line is not
 * a fit, even when the same words flowed as one paragraph would be.
 */
export function captionFitter(
  def: Pick<TitleDef, 'fontSizePx' | 'textCase'> & Partial<Pick<TitleDef, 'fontFamily'>>,
  frameW: number,
  lines: number,
  prepare: (text: string) => string = (t) => t,
): (text: string) => boolean {
  const maxW = captionLineWidthPx(frameW)
  const measure = (s: string): number => captionTextWidthPx(s, def.fontSizePx, def.fontFamily)
  return (text) => {
    const shown = drawn(prepare(text), def.textCase)
    const wrapped = wrapLinesWith(measure, shown, maxW)
    return wrapped.length <= lines && wrapped.every((l) => measure(l) <= maxW)
  }
}

/**
 * The same title with its font made just small enough that its widest word fits
 * the line, or the title untouched when it already does. A word is never broken,
 * so a word wider than the line used to run past the side margin, and with its
 * outline, off the frame. The outline shrinks with the letters so it keeps its look.
 */
export function fitWordsToFrame(def: TitleDef, frameW: number): TitleDef {
  if (!(def.fontSizePx > 0)) return def
  const maxW = captionLineWidthPx(frameW)
  const words = drawn(def.text, def.textCase).split(/\s+/).filter(Boolean)
  const widest = Math.max(0, ...words.map((w) => captionTextWidthPx(w, def.fontSizePx, def.fontFamily)))
  if (widest <= maxW) return def
  const k = maxW / widest
  return {
    ...def,
    fontSizePx: Math.max(1, Math.floor(def.fontSizePx * k)),
    ...(def.outline ? { outline: { ...def.outline, widthPx: Math.max(1, Math.round(def.outline.widthPx * k)) } } : {}),
  }
}
