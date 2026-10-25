// Caption width (captionFit.ts): each caption font is measured with its own advances and
// kerning (captionFontMetrics.ts), so the fitter reads a line as wide as the canvas draws it.
// A font with no metrics of its own is an estimate, Montserrat's 700 advances with no kerning.

import { describe, expect, it } from 'vitest'
import { jettismCaptionDef } from './captions'
import { captionFitter, captionLineWidthPx, captionTextWidthPx, fitWordsToFrame } from './captionFit'
import { CAPTION_FONT_STACK, COMIC_STACK, OSWALD_STACK } from '../render/titleFonts'

// What ctx.measureText said in Chromium for these strings at 100 px, with each bundled font
// loaded the way titleFonts.ts registers it and the font string the rasterizer builds (bold for
// Montserrat and Oswald, regular for Lilita One). Read off the browser, not worked out by us.
const CHROMIUM_AT_100: ReadonlyArray<{ font: string; stack: string; widths: ReadonlyArray<readonly [string, number]> }> = [
  {
    font: 'Oswald',
    stack: OSWALD_STACK,
    widths: [
      ['AWAKE', 277.3],
      ["AWAKE DOESN'T REALLY", 948.7],
      ['WAVE YOU', 407.3],
      ['MMMM WWWW', 586.0],
      ['ŠČŘÁ ŽÝ', 341.0],
      ['It’s “quoted”', 504.9],
      ["don't", 196.8],
      ['office waffle', 485.2],
      ['first flow', 359.6],
      ['Everybody', 410.9],
      ['EXTRAORDINARY', 680.0],
      ['LT AVA', 263.5],
    ],
  },
  {
    font: 'Lilita One',
    stack: COMIC_STACK,
    widths: [
      ['AWAKE', 330.6],
      ["AWAKE DOESN'T REALLY", 1065.7],
      ['WAVE YOU', 481.4],
      ['MMMM WWWW', 762.8],
      // Lilita's file has no S, C and R with a caron: the browser draws those in Arial Black.
      ['ŠČŘÁ ŽÝ', 411.266],
      ['It’s “quoted”', 583.0],
      ["don't", 229.8],
      ['office waffle', 541.1],
      ['first flow', 396.2],
      ['Everybody', 456.8],
      ['EXTRAORDINARY', 776.2],
      ['LT AVA', 298.1],
    ],
  },
  {
    font: 'Montserrat',
    stack: CAPTION_FONT_STACK,
    widths: [
      ['AWAKE', 410.186],
      ["AWAKE DOESN'T REALLY", 1341.452],
      ['WAVE YOU', 590.086],
      ['MMMM WWWW', 884.3],
      ['ŠČŘÁ ŽÝ', 456.6],
      ['It’s “quoted”', 679.514],
      ["don't", 274.9],
      ['office waffle', 665.814],
      ['first flow', 478.0],
      ['Everybody', 565.852],
      ['EXTRAORDINARY', 929.107],
      ['LT AVA', 372.086],
    ],
  },
]

describe('the widths agree with what the canvas measures', () => {
  for (const { font, stack, widths } of CHROMIUM_AT_100) {
    it(`${font}: kerning pairs, ligatures, wide letters, Czech capitals, apostrophes and curly quotes`, () => {
      for (const [text, chromium] of widths) {
        expect(captionTextWidthPx(text, 100, stack), `${font} ${JSON.stringify(text)}`).toBeCloseTo(chromium, 2)
      }
    })
  }

  it('is linear in the font size, as the browser is', () => {
    for (const { stack } of CHROMIUM_AT_100) {
      const at100 = captionTextWidthPx("AWAKE DOESN'T REALLY", 100, stack)
      expect(captionTextWidthPx("AWAKE DOESN'T REALLY", 91, stack)).toBeCloseTo(at100 * 0.91, 6)
      expect(captionTextWidthPx("AWAKE DOESN'T REALLY", 190, stack)).toBeCloseTo(at100 * 1.9, 6)
    }
  })

  it('counts a letter typed as a base plus a loose accent as one letter', () => {
    const composed = 'Č'
    const loose = 'Č'
    expect(captionTextWidthPx(loose, 100, OSWALD_STACK)).toBeCloseTo(captionTextWidthPx(composed, 100, OSWALD_STACK), 6)
  })

  it('pulls A-W, W-A and L-Y together in Oswald, which is what made the Word box line fit', () => {
    // Advances alone add up to 961.1 px here; the canvas draws 948.7 px, 1.3 px inside a 950 px line.
    const width = captionTextWidthPx("AWAKE DOESN'T REALLY", 100, OSWALD_STACK)
    expect(width).toBeGreaterThan(948)
    expect(width).toBeLessThan(950)
  })
})

describe('which metrics a font stack is measured with', () => {
  const awake = (family?: string): number => captionTextWidthPx('AWAKE', 100, family)
  // The estimate: Montserrat's 700 advances added up, no kerning.
  const ESTIMATE_AWAKE = 410.6

  it('estimates for no font and for a font with no metrics of its own', () => {
    expect(awake()).toBeCloseTo(ESTIMATE_AWAKE, 6)
    expect(awake('Arial')).toBeCloseTo(ESTIMATE_AWAKE, 6)
    expect(awake("'Luckiest Guy', 'Arial Black', sans-serif")).toBeCloseTo(ESTIMATE_AWAKE, 6)
  })

  it("measures Montserrat at the weight 800 the app pins it to, not the estimate's 700", () => {
    expect(awake("'Montserrat', sans-serif")).toBeCloseTo(410.186, 2)
    expect(awake(CAPTION_FONT_STACK)).toBeCloseTo(410.186, 2)
  })

  it("uses Lilita One's own when the stack leads with it", () => {
    expect(awake(COMIC_STACK)).toBeCloseTo(330.6, 2)
  })

  it("uses Oswald's own when the stack leads with it", () => {
    expect(awake(OSWALD_STACK)).toBeCloseTo(277.3, 2)
  })

  it('finds Oswald with single quotes, double quotes, none, a leading space or other letter case', () => {
    for (const stack of ["'Oswald', sans-serif", '"Oswald", sans-serif', 'Oswald, sans-serif', "  'Oswald'", "'OSWALD'"]) {
      expect(awake(stack), stack).toBeCloseTo(277.3, 2)
    }
  })

  it('does not take a stack that only lists Oswald after another font, or a longer name that starts the same', () => {
    expect(awake("'Arial Black', 'Oswald', sans-serif")).toBeCloseTo(ESTIMATE_AWAKE, 6)
    expect(awake("'Oswaldo', sans-serif")).toBeCloseTo(ESTIMATE_AWAKE, 6)
    expect(awake("'Lilita One', 'Oswald', sans-serif")).toBeCloseTo(330.6, 2)
  })

  it('reads Oswald about a quarter narrower than Montserrat at the same size', () => {
    const caps = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const ratio = captionTextWidthPx(caps, 100, OSWALD_STACK) / captionTextWidthPx(caps, 100, CAPTION_FONT_STACK)
    expect(ratio).toBeGreaterThan(0.65)
    expect(ratio).toBeLessThan(0.8)
  })
})

describe('the Word box line in Oswald', () => {
  const WORD_BOX_LOOK = { fontSizePx: 91, textCase: 'upper' as const }
  const line = captionLineWidthPx(1080)

  it('is 950 px across a 1080 wide frame', () => {
    expect(line).toBe(950)
  })

  it('fits three words of speech on one line at the 1080x1920 size, where the estimate said 1216 px', () => {
    const oswald = captionFitter({ ...WORD_BOX_LOOK, fontFamily: OSWALD_STACK }, 1080, 1)
    const estimated = captionFitter(WORD_BOX_LOOK, 1080, 1)
    expect(captionTextWidthPx("AWAKE DOESN'T REALLY", 91, OSWALD_STACK)).toBeLessThan(line)
    expect(captionTextWidthPx("AWAKE DOESN'T REALLY", 91)).toBeGreaterThan(line)
    expect(oswald("awake doesn't really")).toBe(true)
    expect(estimated("awake doesn't really")).toBe(false)
  })

  it('fits them on the 1080x2112 phone frame too, 948.7 px against the 950 px line', () => {
    const oswald = captionFitter({ fontSizePx: 100, textCase: 'upper', fontFamily: OSWALD_STACK }, 1080, 1)
    expect(oswald("awake doesn't really")).toBe(true)
    // One pixel bigger and it really is too wide, so the fit is not a loose one.
    expect(captionFitter({ fontSizePx: 101, textCase: 'upper', fontFamily: OSWALD_STACK }, 1080, 1)("awake doesn't really")).toBe(false)
  })

  it('still refuses a run that is too wide for one line in Oswald too', () => {
    const oswald = captionFitter({ ...WORD_BOX_LOOK, fontFamily: OSWALD_STACK }, 1080, 1)
    expect(oswald('something else entirely')).toBe(false)
  })

  it("keeps a word at full size that the estimate would have shrunk", () => {
    const def = { ...jettismCaptionDef('everybody', 1920), fontSizePx: 190, textCase: 'upper' as const }
    expect(fitWordsToFrame({ ...def, fontFamily: OSWALD_STACK }, 1080).fontSizePx).toBe(190)
    expect(fitWordsToFrame({ ...def, fontFamily: "'Montserrat', sans-serif" }, 1080).fontSizePx).toBeLessThan(190)
  })
})

describe('a hard line break in the text', () => {
  const def = { fontSizePx: 100, textCase: undefined, fontFamily: OSWALD_STACK }

  it('wraps each side on its own, as the rasterizer does', () => {
    // The two halves are each inside the 950 px line.
    const fits = captionFitter(def, 1080, 2)
    expect(fits('MMMM WWWW\nMMMM')).toBe(true)
    // The same words flowed as one paragraph fit in two lines. With the break after the fourth they
    // are drawn on three, because the first side is too wide for one line by itself.
    expect(fits('MMMM WWWW MMMM WWWW I')).toBe(true)
    expect(fits('MMMM WWWW MMMM WWWW\nI')).toBe(false)
  })

  it('counts the lines it is drawn on, so a break plus a wrap is three', () => {
    expect(captionFitter(def, 1080, 2)('MMMM WWWW MMMM WWWW\nIII')).toBe(false)
    expect(captionFitter(def, 1080, 3)('MMMM WWWW MMMM WWWW\nIII')).toBe(true)
  })
})

describe('an emoji', () => {
  // The emoji face draws it, not the caption's font, about an em wide: 1.1 em is reserved for
  // each picture, counted by grapheme, so a skin tone or a family joined with ZWJ is one picture.
  const FIRE = '\u{1F525}'
  const THUMBS_MEDIUM = '\u{1F44D}\u{1F3FD}'
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
  const HEART = '\u2764\uFE0F'

  it('is reserved 1.1 em, once per picture, however many code points draw it', () => {
    expect([...THUMBS_MEDIUM]).toHaveLength(2)
    expect([...FAMILY]).toHaveLength(7)
    for (const stack of [OSWALD_STACK, CAPTION_FONT_STACK, COMIC_STACK, undefined]) {
      for (const emoji of [FIRE, THUMBS_MEDIUM, FAMILY, HEART]) {
        expect(captionTextWidthPx(emoji, 100, stack), `${stack} ${emoji}`).toBeCloseTo(110, 6)
      }
      expect(captionTextWidthPx(FIRE + THUMBS_MEDIUM + FAMILY, 100, stack)).toBeCloseTo(330, 6)
    }
  })

  it('adds to the words around it, and nothing kerns across it', () => {
    const wide = (t: string): number => captionTextWidthPx(t, 100, OSWALD_STACK)
    expect(wide(`AWAKE ${FIRE} REALLY`)).toBeCloseTo(wide('AWAKE ') + 110 + wide(' REALLY'), 6)
    // A and W kern in Oswald; with a picture between them they do not.
    expect(wide(`A${THUMBS_MEDIUM}W`)).toBeCloseTo(wide('A') + 110 + wide('W'), 6)
    expect(wide('AW')).toBeLessThan(wide('A') + wide('W'))
  })

  it('makes the fitter refuse a line the pictures push past the edge', () => {
    const fits = captionFitter({ fontSizePx: 100, textCase: 'upper', fontFamily: OSWALD_STACK }, 1080, 1)
    expect(fits("awake doesn't really")).toBe(true)
    expect(fits(`awake doesn't really ${FAMILY}`)).toBe(false)
  })
})

describe('a character the emoji face leaves out', () => {
  // emojiFont.ts keeps the copyright, registered and trade mark signs out of the face's unicode-range
  // ("they read as text in a caption"), so the title's own font draws them at their own, narrow,
  // width. Unicode calls them pictographs, and the fitter used to reserve a whole emoji for each.
  const COPYRIGHT = '\u00A9'
  const REGISTERED = '\u00AE'
  const TRADE_MARK = '\u2122'
  // The section sign: in no width table and no emoji range, so it is measured the same plain way.
  const PLAIN = '\u00A7'
  const FIRE = '\u{1F525}'
  const stacks = [OSWALD_STACK, CAPTION_FONT_STACK, COMIC_STACK, undefined]

  it('measures the copyright, registered and trade mark signs as plain text', () => {
    for (const stack of stacks) {
      const plain = captionTextWidthPx(PLAIN, 100, stack)
      expect(plain, `${stack}`).toBeLessThan(100)
      for (const sign of [COPYRIGHT, REGISTERED, TRADE_MARK]) {
        expect(captionTextWidthPx(sign, 100, stack), `${stack} ${sign}`).toBeCloseTo(plain, 6)
      }
    }
  })

  it('reads (c) 2026, typed with the real copyright sign, as plain text', () => {
    for (const stack of stacks) {
      const wide = (t: string): number => captionTextWidthPx(t, 100, stack)
      expect(wide(`${COPYRIGHT} 2026`), `${stack}`).toBeCloseTo(wide(`${PLAIN} 2026`), 6)
      expect(wide(`${COPYRIGHT} 2026`), `${stack}`).toBeLessThan(wide(`${FIRE} 2026`) - 30)
      expect(wide(`AWAKE ${TRADE_MARK}`), `${stack}`).toBeCloseTo(wide(`AWAKE ${PLAIN}`), 6)
    }
  })

  it('still reserves a picture for the same sign when it asks for the emoji look', () => {
    // The emoji selector (U+FE0F) after it is a request for the picture, drawn by the emoji font.
    for (const stack of stacks) expect(captionTextWidthPx(`${COPYRIGHT}\uFE0F`, 100, stack), `${stack}`).toBeCloseTo(110, 6)
  })
})

describe('a skin toned, keycap or flag emoji', () => {
  const THUMBS_UP = '\u{1F44D}'
  const TONES = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}']
  const CZECH = '\u{1F1E8}\u{1F1FF}'
  const BRITISH = '\u{1F1EC}\u{1F1E7}'
  const stacks = [OSWALD_STACK, CAPTION_FONT_STACK, COMIC_STACK, undefined]

  it('gives a thumbs up in every skin tone one picture, 1.1 em', () => {
    for (const stack of stacks) {
      for (const tone of TONES) {
        expect([...THUMBS_UP + tone], tone).toHaveLength(2)
        expect(captionTextWidthPx(THUMBS_UP + tone, 100, stack), `${stack} ${tone}`).toBeCloseTo(110, 6)
      }
      expect(captionTextWidthPx(THUMBS_UP, 100, stack), `${stack}`).toBeCloseTo(110, 6)
    }
  })

  it('gives a keycap the width it is drawn at: one picture, not a digit and a mark', () => {
    for (const stack of stacks) {
      for (const base of ['1', '9', '#', '*']) {
        expect(captionTextWidthPx(`${base}\uFE0F\u20E3`, 100, stack), `${stack} ${base}`).toBeCloseTo(110, 6)
        expect(captionTextWidthPx(`${base}\u20E3`, 100, stack), `${stack} ${base} bare`).toBeCloseTo(110, 6)
      }
    }
  })

  it('leaves a bare digit, # and * at their own width: they are the keycap bases, not emoji', () => {
    for (const stack of stacks) {
      for (const base of ['1', '9', '#', '*']) {
        expect(captionTextWidthPx(base, 100, stack), `${stack} ${base}`).toBeLessThan(100)
      }
    }
  })

  it('gives a flag (two regional indicators) one picture, and two flags two', () => {
    for (const stack of stacks) {
      expect([...CZECH]).toHaveLength(2)
      expect(captionTextWidthPx(CZECH, 100, stack), `${stack}`).toBeCloseTo(110, 6)
      expect(captionTextWidthPx(CZECH + BRITISH, 100, stack), `${stack}`).toBeCloseTo(220, 6)
    }
  })

  it('adds a keycap and a flag to the words around them', () => {
    const wide = (t: string): number => captionTextWidthPx(t, 100, OSWALD_STACK)
    expect(wide(`TOP 1\uFE0F\u20E3 ${CZECH}`)).toBeCloseTo(wide('TOP ') + 110 + wide(' ') + 110, 6)
  })
})
