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
// The widths are Montserrat's own, at the weight `bold` draws (700), read off
// the bundled font file. A table and not a canvas, so node tests, the preview
// and the export all get the same answer. Kerning is left out, which only ever
// makes a line read a hair wider than it draws: a pair right at the edge is cut
// in two rather than allowed to wrap. Lilita One has its own table (the Oveon
// style, 2026-10-12): it draws about a fifth narrower than Montserrat, so with
// Montserrat's widths a long word in it was shrunk to a size it never needed.
// Oswald has its own table too (the Word box style, 2026-10-19): it is a
// condensed face, about 28% narrower than Montserrat at the same size, so with
// Montserrat's widths the style's fixed three words were measured too wide for
// the line and cut to two on a 1080x1920 frame. Any other font is measured with
// Montserrat's widths, which is close for the sans fonts and an estimate for the rest.
//
// Pure: no canvas, no store.

import { wrapLinesWith } from '../render/titleRaster'
import type { TitleDef } from '../types'

/** Montserrat at weight 700, advance per 1000 em, for ' ' (32) to '~' (126). */
const ADVANCE = [
  283, 289, 437, 720, 638, 877, 728, 230, 357, 358, 434, 599, 262, 386, 262, 392, 679, 392, 590, 592, 689, 595, 637, 620,
  660, 637, 262, 262, 599, 599, 599, 589, 1035, 766, 765, 724, 826, 671, 639, 771, 808, 328, 541, 740, 604, 955, 808,
  844, 732, 844, 735, 638, 618, 788, 746, 1163, 714, 676, 671, 368, 392, 368, 600, 500, 600, 617, 690, 591, 692, 631,
  387, 700, 691, 301, 307, 655, 301, 1049, 691, 655, 690, 690, 431, 531, 435, 687, 598, 937, 595, 598, 543, 391, 309,
  391, 599,
] as const

/** Lilita One (its one weight), advance per 1000 em, for ' ' (32) to '~' (126). */
const LILITA_ADVANCE = [
  188, 287, 460, 833, 531, 798, 667, 301, 430, 422, 557, 602, 305, 525, 229, 573, 639, 406, 525, 528, 598, 524, 575, 500,
  570, 565, 277, 277, 484, 580, 450, 584, 867, 655, 594, 561, 616, 493, 472, 621, 644, 429, 462, 620, 435, 907, 648,
  696, 570, 706, 590, 531, 502, 628, 661, 953, 683, 615, 563, 385, 587, 385, 687, 636, 350, 517, 520, 424, 565, 486,
  375, 516, 501, 273, 271, 531, 272, 788, 551, 513, 555, 511, 396, 450, 368, 544, 521, 752, 557, 537, 454, 362, 628,
  362, 459,
] as const

/** Oswald at weight 700, advance per 1000 em, for ' ' (32) to '~' (126). */
const OSWALD_ADVANCE = [
  256, 257, 360, 534, 485, 1006, 570, 170, 338, 328, 423, 449, 238, 324, 244, 422, 550, 385, 514, 514, 524, 509, 538,
  439, 521, 538, 278, 285, 398, 442, 398, 483, 950, 551, 588, 563, 586, 447, 434, 582, 610, 301, 349, 567, 443, 704,
  561, 586, 571, 586, 600, 514, 445, 588, 526, 697, 515, 493, 433, 332, 422, 324, 476, 368, 307, 460, 506, 468, 503,
  470, 320, 502, 509, 265, 269, 510, 274, 753, 507, 483, 505, 504, 383, 424, 351, 504, 421, 597, 442, 448, 392, 374,
  262, 379, 481,
] as const

/** A character outside the table and with no plain letter under it: about a capital's width. */
const OTHER = 720

/** The width table for a font stack: Lilita One's or Oswald's own when it leads, Montserrat's otherwise. */
function tableFor(fontFamily?: string): readonly number[] {
  if (fontFamily && /^\s*['"]?Lilita One/i.test(fontFamily)) return LILITA_ADVANCE
  if (fontFamily && /^\s*['"]?Oswald\b/i.test(fontFamily)) return OSWALD_ADVANCE
  return ADVANCE
}

/** Width of one character, per 1000 em. An accented letter is as wide as its plain one. */
function advance(ch: string, table: readonly number[]): number {
  const at = (c: number): number | undefined => (c >= 32 && c <= 126 ? table[c - 32] : undefined)
  return at(ch.charCodeAt(0)) ?? at(ch.normalize('NFD').charCodeAt(0)) ?? OTHER
}

/** How wide this text draws at this font size, in pixels, in this font stack (Montserrat when absent). */
export function captionTextWidthPx(text: string, fontSizePx: number, fontFamily?: string): number {
  const table = tableFor(fontFamily)
  let units = 0
  for (const ch of text) units += advance(ch, table)
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
 * (the house case for a fresh run), so what is measured is what is drawn.
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
    const wrapped = wrapLinesWith(measure, shown.replace(/\n/g, ' '), maxW)
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
