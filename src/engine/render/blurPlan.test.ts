import { describe, expect, it } from 'vitest'

import { LOOKS } from '../effects/looks'
import { blurPlan, effectiveSigma, MAX_BLUR_PASSES, MAX_BLUR_TAP_RADIUS, passVariance } from './blurPlan'

// What a look draws: its glow radius is a fraction of the frame's SHORT side.
const radiusAt = (fraction: number, shortSide: number): number => fraction * shortSide

describe('blurPlan', () => {
  it('draws any radius up to one pass reach as ONE pass at that radius, as it always was', () => {
    for (const r of [0, 0.4, 1, 12.5, 37.8, 64]) {
      expect(blurPlan(r)).toEqual({ passes: 1, radiusPx: r })
    }
  })

  it('splits a wider radius into rounds that each stay inside one pass reach', () => {
    for (const r of [64.5, 75.6, 100, 151.2, 200, 256, 900]) {
      const plan = blurPlan(r)
      expect(plan.passes).toBeGreaterThan(1)
      expect(plan.passes).toBeLessThanOrEqual(MAX_BLUR_PASSES)
      expect(plan.radiusPx).toBeLessThanOrEqual(MAX_BLUR_TAP_RADIUS)
    }
  })

  it('never returns a negative or non finite radius', () => {
    expect(blurPlan(-5)).toEqual({ passes: 1, radiusPx: 0 })
    expect(blurPlan(Number.NaN)).toEqual({ passes: 1, radiusPx: 0 })
    expect(blurPlan(Number.POSITIVE_INFINITY)).toEqual({ passes: 1, radiusPx: 0 })
  })

  it('does not step the blur width at the 64 px edge', () => {
    const below = effectiveSigma(blurPlan(64))
    const above = effectiveSigma(blurPlan(64.01))
    expect(Math.abs(above - below) / below).toBeLessThan(0.01)
  })
})

describe('effective radius at 4K against 1080', () => {
  // Every glow a look has: halation, bloom, and the clarity blur (CLARITY_RADIUS).
  const glows = LOOKS.flatMap((spec) => [
    ...(spec.halation ? [{ name: `${spec.id} halation`, fraction: spec.halation.radius }] : []),
    ...(spec.bloom ? [{ name: `${spec.id} bloom`, fraction: spec.bloom.radius }] : []),
  ])

  it('finds the glows this test is about', () => {
    expect(glows.length).toBeGreaterThanOrEqual(5)
    // Golden Hour's bloom is the widest one: 76 px at 4K, past the 64 px reach.
    expect(radiusAt(0.035, 2160)).toBeGreaterThan(MAX_BLUR_TAP_RADIUS)
  })

  it.each(glows)('$name is twice as wide at 4K (short side 2160) as at 1080, within 1.5%', ({ fraction }) => {
    const at1080 = effectiveSigma(blurPlan(radiusAt(fraction, 1080)))
    const at4k = effectiveSigma(blurPlan(radiusAt(fraction, 2160)))
    expect(at4k / at1080).toBeGreaterThan(2 * 0.985)
    expect(at4k / at1080).toBeLessThan(2 * 1.015)
  })

  it('stays in proportion at 8K too (short side 4320, four times 1080)', () => {
    const at1080 = effectiveSigma(blurPlan(radiusAt(0.035, 1080)))
    const at8k = effectiveSigma(blurPlan(radiusAt(0.035, 4320)))
    expect(at8k / at1080).toBeGreaterThan(4 * 0.985)
    expect(at8k / at1080).toBeLessThan(4 * 1.015)
  })

  it('shows what the old 64 px ceiling did: Golden Hour bloom 15% too small at 4K', () => {
    const wanted = radiusAt(0.035, 2160)
    expect(MAX_BLUR_TAP_RADIUS / wanted).toBeLessThan(0.85)
    // And the plan now gets the whole radius: its width is a full gaussian of the
    // wanted radius, which is wider than a single pass at the ceiling could be.
    const planned = effectiveSigma(blurPlan(wanted))
    const capped = effectiveSigma({ passes: 1, radiusPx: MAX_BLUR_TAP_RADIUS })
    expect(planned / capped).toBeGreaterThan(1.12)
  })
})

describe('passVariance', () => {
  it('is zero for a pass the shader skips (radius under half a pixel)', () => {
    expect(passVariance(0)).toBe(0)
    expect(passVariance(0.4)).toBe(0)
  })

  it('grows with the square of the radius', () => {
    const ratio = passVariance(48) / passVariance(24)
    expect(ratio).toBeGreaterThan(3.9)
    expect(ratio).toBeLessThan(4.1)
  })
})
