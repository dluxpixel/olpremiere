// Caption width, from each font's own advance table (captionFit.ts). A font with no
// table of its own is measured with Montserrat's, which reads a condensed face far
// too wide: Oswald, the Word box style's face, lost its third word that way.

import { describe, expect, it } from 'vitest'
import { jettismCaptionDef } from './captions'
import { captionFitter, captionLineWidthPx, captionTextWidthPx, fitWordsToFrame } from './captionFit'
import { COMIC_STACK, OSWALD_STACK } from '../render/titleFonts'

// "AWAKE" at 100 px, the widths per 1000 em added up: Montserrat 4106, Lilita One 3376, Oswald 2813.
const MONTSERRAT_AWAKE = 410.6
const LILITA_AWAKE = 337.6
const OSWALD_AWAKE = 281.3

describe('which width table a font stack is measured with', () => {
  const awake = (family?: string): number => captionTextWidthPx('AWAKE', 100, family)

  it('uses Montserrat for no font and for a font with no table of its own', () => {
    expect(awake()).toBeCloseTo(MONTSERRAT_AWAKE, 6)
    expect(awake("'Montserrat', sans-serif")).toBeCloseTo(MONTSERRAT_AWAKE, 6)
    expect(awake('Arial')).toBeCloseTo(MONTSERRAT_AWAKE, 6)
  })

  it("uses Lilita One's own when the stack leads with it", () => {
    expect(awake(COMIC_STACK)).toBeCloseTo(LILITA_AWAKE, 6)
  })

  it("uses Oswald's own when the stack leads with it", () => {
    expect(awake(OSWALD_STACK)).toBeCloseTo(OSWALD_AWAKE, 6)
  })

  it('finds Oswald with single quotes, double quotes, none, a leading space or other letter case', () => {
    for (const stack of ["'Oswald', sans-serif", '"Oswald", sans-serif', 'Oswald, sans-serif', "  'Oswald'", "'OSWALD'"]) {
      expect(awake(stack), stack).toBeCloseTo(OSWALD_AWAKE, 6)
    }
  })

  it('does not take a stack that only lists Oswald after another font, or a longer name that starts the same', () => {
    expect(awake("'Arial Black', 'Oswald', sans-serif")).toBeCloseTo(MONTSERRAT_AWAKE, 6)
    expect(awake("'Oswaldo', sans-serif")).toBeCloseTo(MONTSERRAT_AWAKE, 6)
    expect(awake("'Lilita One', 'Oswald', sans-serif")).toBeCloseTo(LILITA_AWAKE, 6)
  })

  it('reads Oswald about a quarter narrower than Montserrat at the same size', () => {
    const caps = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const ratio = captionTextWidthPx(caps, 100, OSWALD_STACK) / captionTextWidthPx(caps, 100)
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

  it("fits three words of speech on one line at the 1080x1920 size, where Montserrat's widths said 1216 px", () => {
    const oswald = captionFitter({ ...WORD_BOX_LOOK, fontFamily: OSWALD_STACK }, 1080, 1)
    const montserrat = captionFitter(WORD_BOX_LOOK, 1080, 1)
    expect(captionTextWidthPx("AWAKE DOESN'T REALLY", 91, OSWALD_STACK)).toBeLessThan(line)
    expect(captionTextWidthPx("AWAKE DOESN'T REALLY", 91)).toBeGreaterThan(line)
    expect(oswald("awake doesn't really")).toBe(true)
    expect(montserrat("awake doesn't really")).toBe(false)
  })

  it('still refuses a run that is too wide for one line in Oswald too', () => {
    const oswald = captionFitter({ ...WORD_BOX_LOOK, fontFamily: OSWALD_STACK }, 1080, 1)
    expect(oswald('something else entirely')).toBe(false)
  })

  it("keeps a word at full size that Montserrat's widths would have shrunk", () => {
    const def = { ...jettismCaptionDef('everybody', 1920), fontSizePx: 190, textCase: 'upper' as const }
    expect(fitWordsToFrame({ ...def, fontFamily: OSWALD_STACK }, 1080).fontSizePx).toBe(190)
    expect(fitWordsToFrame({ ...def, fontFamily: "'Montserrat', sans-serif" }, 1080).fontSizePx).toBeLessThan(190)
  })
})
