// "Let's make it universal: the text speed thing. For example, if the word clip
// is too long, then why should the normal animation still be very slow just
// because the text is long?" (2026-09-23)
//
// Until then every speed was a SHARE of the clip (the 2026-08-06 ladder), so
// Normal was a different speed on every word. Now a named speed is the same
// number of seconds on every clip, and a clip with only an entrance may use its
// whole length, which is what keeps the rungs apart on a short word.
//
// The 2026-08-06 complaint still holds as a test: "some speeds are just not
// actually very slow". Rungs must stay DIFFERENT on a real word caption.

import { describe, expect, it } from 'vitest'
import { APPEARANCE_SPEEDS, autoAppearanceDur } from './appearanceActions'
import { appearanceWindowS } from '../engine/anim/appearance'

const RUNGS = APPEARANCE_SPEEDS.map((s) => s.seconds)
/** What a per-word caption actually looks like: a pop in, nothing out. */
const WORD_S = 0.32
const TITLE_S = 2.5

/** What the compiler REALLY animates over, ceiling included. */
const entranceOnly = (durS: number, clipS: number) => appearanceWindowS({ in: 'pop', durS }, clipS)
const bothSides = (durS: number, clipS: number) => appearanceWindowS({ in: 'pop', out: 'popOut', durS }, clipS)

describe('the animation speed is the same on every clip', () => {
  it('Normal is one speed on a short word, a long word and a title', () => {
    const normal = APPEARANCE_SPEEDS.find((s) => s.label === 'Normal')!.seconds
    const got = [0.3, 0.6, 1.2, TITLE_S, 10].map((clipS) => entranceOnly(normal, clipS))
    expect(new Set(got.map((n) => n.toFixed(6))).size).toBe(1)
    expect(got[0]).toBeCloseTo(normal, 9)
  })

  it('THE OLD BUG: a share of the clip made Normal three times slower on a longer word', () => {
    // The 2026-08-06 ladder: Normal was 22% of the clip.
    const share = (clipS: number) => 0.22 * clipS
    expect(share(1.2) / share(0.4)).toBeCloseTo(3, 6)
  })

  it('every rung is a DIFFERENT speed on a per-word caption', () => {
    const fits = RUNGS.filter((d) => d <= WORD_S)
    const got = fits.map((d) => entranceOnly(d, WORD_S))
    expect(new Set(got.map((n) => n.toFixed(4))).size).toBe(fits.length)
    // Snappy, Normal and a word-length Smooth: at least three of the four.
    expect(new Set(RUNGS.map((d) => entranceOnly(d, WORD_S).toFixed(4))).size).toBeGreaterThanOrEqual(3)
  })

  it('the rungs climb in real steps, so he can see the difference', () => {
    for (let i = 1; i < RUNGS.length; i++) expect(RUNGS[i]).toBeGreaterThan(RUNGS[i - 1] * 1.4)
  })

  it('every rung is distinct on a long title, entrance and exit both', () => {
    const got = RUNGS.map((d) => bothSides(d, TITLE_S))
    expect(got).toEqual(RUNGS)
  })

  it('an entrance can still never run into its own exit', () => {
    for (const clipS of [0.2, 0.32, 1, TITLE_S]) {
      for (const d of RUNGS) expect(bothSides(d, clipS)).toBeLessThanOrEqual(clipS / 2 + 1e-9)
    }
  })

  it('no animation outlasts its clip', () => {
    for (const clipS of [0.05, 0.2, WORD_S]) {
      for (const d of RUNGS) expect(entranceOnly(d, clipS)).toBeLessThanOrEqual(clipS + 1e-9)
    }
  })

  it('the rungs sit on the numbers the app already stands behind', () => {
    // Snappy is the measured caption pop, Normal the default for a new title.
    expect(RUNGS[0]).toBe(0.1)
    expect(RUNGS[1]).toBe(0.25)
  })

  it('Auto is the one that fits each clip, and it still sits inside the ladder', () => {
    const auto = autoAppearanceDur(WORD_S)
    expect(auto).toBeGreaterThanOrEqual(RUNGS[0] * 0.8)
    expect(auto).toBeLessThanOrEqual(RUNGS.at(-1)!)
    expect(autoAppearanceDur(2)).toBeGreaterThan(autoAppearanceDur(0.3))
  })
})
