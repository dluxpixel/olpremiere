// "Some speeds are just not actually very slow, and the very fast is really,
// really fast. There are just too many options." (2026-08-06)
//
// Both halves were one bug. The ladder was absolute seconds (0.1 to 1.0) while
// appearanceWindowS clamps the window to HALF the clip, and this is used on
// per-word captions about a third of a second long. So four of the seven rungs
// clamped to the SAME value on a real caption.

import { describe, expect, it } from 'vitest'
import { appearanceDurFor, autoAppearanceDur } from './appearanceActions'
import { appearanceWindowS } from '../engine/anim/appearance'

/** The fractions the menu offers, in order. Kept in step with clipMenus.ts. */
const RUNGS = [0.12, 0.22, 0.34, 0.46]
/** What a per-word caption actually looks like. */
const WORD_S = 0.32
const TITLE_S = 2.5

/** What the compiler REALLY animates over, clamp included. */
const windowFor = (frac: number, clipS: number) =>
  appearanceWindowS({ durS: appearanceDurFor(frac, clipS) }, clipS)

describe('the animation speed ladder', () => {
  it('THE BUG: the old absolute ladder collapsed to one value on a word', () => {
    // Normal 0.25, Relaxed 0.4, Slow 0.6, Very slow 1.0 on a 0.32s word.
    const old = [0.25, 0.4, 0.6, 1].map((durS) => appearanceWindowS({ durS }, WORD_S))
    expect(new Set(old).size).toBe(1)
    expect(old[0]).toBeCloseTo(WORD_S / 2, 6)
  })

  it('every rung is now a DIFFERENT length on a per-word caption', () => {
    const got = RUNGS.map((f) => windowFor(f, WORD_S))
    expect(new Set(got.map((n) => n.toFixed(4))).size).toBe(RUNGS.length)
  })

  it('and they are in order, each meaningfully slower than the last', () => {
    const got = RUNGS.map((f) => windowFor(f, WORD_S))
    for (let i = 1; i < got.length; i++) {
      expect(got[i]).toBeGreaterThan(got[i - 1])
      // "Meaningfully": at least a 20% step, so he can SEE the difference.
      expect(got[i]).toBeGreaterThan(got[i - 1] * 1.2)
    }
  })

  it('the slowest still cannot run into its own exit', () => {
    for (const clipS of [0.2, 0.32, 1, TITLE_S, 10]) {
      expect(windowFor(0.46, clipS)).toBeLessThanOrEqual(clipS / 2 + 1e-9)
    }
  })

  it('every rung stays distinct on a long title too', () => {
    const got = RUNGS.map((f) => windowFor(f, TITLE_S))
    expect(new Set(got.map((n) => n.toFixed(4))).size).toBe(RUNGS.length)
  })

  it('no rung is absurd at the extremes: never under a frame, never over 0.8s', () => {
    for (const clipS of [0.05, 0.32, 2.5, 30]) {
      for (const f of RUNGS) {
        const d = appearanceDurFor(f, clipS)
        expect(d).toBeGreaterThanOrEqual(1 / 30 - 1e-9)
        expect(d).toBeLessThanOrEqual(0.8 + 1e-9)
        // and the slowest rung is the one that actually reaches the ceiling
        if (f === 0.46 && clipS >= 2) expect(d).toBeCloseTo(0.8, 6)
      }
    }
  })

  it('Auto still sits inside the ladder rather than off the end of it', () => {
    const auto = autoAppearanceDur(WORD_S)
    const slowest = appearanceDurFor(0.46, WORD_S)
    const fastest = appearanceDurFor(0.12, WORD_S)
    expect(auto).toBeGreaterThanOrEqual(fastest)
    expect(auto).toBeLessThanOrEqual(slowest * 3)
  })
})
