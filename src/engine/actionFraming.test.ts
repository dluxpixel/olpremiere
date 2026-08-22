// The arithmetic that decides which part of his gameplay survives a vertical cut.
//
// The one rule that must never break: passing 0.5 has to give exactly the centre
// crop the app does today, or turning this on would silently reframe every clip
// he has already finished.

import { describe, expect, it } from 'vitest'
import { centreOfAction, cropToAspect, framingRange, NO_CROP } from './actionFraming'

const NINE_SIXTEEN = 9 / 16
const SIXTEEN_NINE = 16 / 9

describe('cropToAspect', () => {
  it('at 0.5 takes exactly as much off each side, which is what the app does today', () => {
    const c = cropToAspect(1920, 1080, NINE_SIXTEEN, 0.5)
    expect(c.l).toBeCloseTo(c.r, 10)
    expect(c.t).toBe(0)
    expect(c.b).toBe(0)
    // 16:9 into 9:16 keeps 9/16 divided by 16/9, which is 0.3164 of the width.
    expect(1 - c.l - c.r).toBeCloseTo((NINE_SIXTEEN / SIXTEEN_NINE), 6)
  })

  it('slides the window towards the action without changing how much it keeps', () => {
    const mid = cropToAspect(1920, 1080, NINE_SIXTEEN, 0.5)
    const left = cropToAspect(1920, 1080, NINE_SIXTEEN, 0.3)
    expect(1 - left.l - left.r).toBeCloseTo(1 - mid.l - mid.r, 10)
    expect(left.l).toBeLessThan(mid.l)
    expect(left.r).toBeGreaterThan(mid.r)
  })

  it('centres the window ON the point when the point is not near an edge', () => {
    const keep = NINE_SIXTEEN / SIXTEEN_NINE
    const c = cropToAspect(1920, 1080, NINE_SIXTEEN, 0.4)
    expect(c.l + keep / 2).toBeCloseTo(0.4, 10)
  })

  // ⛔ Running off the edge would put a black bar INSIDE his footage.
  it('stops at the edge rather than running off it, at either end', () => {
    const keep = NINE_SIXTEEN / SIXTEEN_NINE
    const hardLeft = cropToAspect(1920, 1080, NINE_SIXTEEN, 0)
    expect(hardLeft.l).toBe(0)
    expect(hardLeft.r).toBeCloseTo(1 - keep, 10)
    const hardRight = cropToAspect(1920, 1080, NINE_SIXTEEN, 1)
    expect(hardRight.r).toBeCloseTo(0, 10)
    expect(hardRight.l).toBeCloseTo(1 - keep, 10)
  })

  it('crops top and bottom instead when the source is the taller one', () => {
    const c = cropToAspect(1080, 1920, SIXTEEN_NINE, 0.5)
    expect(c.l).toBe(0)
    expect(c.r).toBe(0)
    expect(c.t).toBeCloseTo(c.b, 10)
    expect(c.t).toBeGreaterThan(0)
  })

  it('crops nothing when the shapes already agree, so a 9:16 clip in a Short is untouched', () => {
    expect(cropToAspect(1080, 1920, NINE_SIXTEEN, 0.2)).toEqual(NO_CROP)
  })

  it('crops nothing rather than throwing on a size it cannot use', () => {
    expect(cropToAspect(0, 1080, NINE_SIXTEEN, 0.5)).toEqual(NO_CROP)
    expect(cropToAspect(1920, Number.NaN, NINE_SIXTEEN, 0.5)).toEqual(NO_CROP)
    expect(cropToAspect(1920, 1080, 0, 0.5)).toEqual(NO_CROP)
  })

  it('treats a nonsense centre as the middle rather than skewing the picture', () => {
    expect(cropToAspect(1920, 1080, NINE_SIXTEEN, Number.NaN)).toEqual(cropToAspect(1920, 1080, NINE_SIXTEEN, 0.5))
    expect(cropToAspect(1920, 1080, NINE_SIXTEEN, -5)).toEqual(cropToAspect(1920, 1080, NINE_SIXTEEN, 0))
    expect(cropToAspect(1920, 1080, NINE_SIXTEEN, 9)).toEqual(cropToAspect(1920, 1080, NINE_SIXTEEN, 1))
  })
})

describe('framingRange', () => {
  it('says how far the window can travel, so a clip with no choice can say so', () => {
    expect(framingRange(1920, 1080, NINE_SIXTEEN)).toBeCloseTo(1 - NINE_SIXTEEN / SIXTEEN_NINE, 10)
    expect(framingRange(1080, 1920, NINE_SIXTEEN)).toBe(0)
  })
})

describe('centreOfAction', () => {
  // ⛔ His measured worst single jump was 0.82 of the width. One muzzle flash at
  // the edge must not decide the framing of the whole clip.
  it('is not dragged across the picture by one violent frame', () => {
    const calm = [0.40, 0.41, 0.42, 0.40, 0.41]
    expect(centreOfAction(calm)).toBeCloseTo(0.41, 10)
    expect(centreOfAction([...calm, 0.99])).toBeLessThan(0.45)
    const mean = [...calm, 0.99].reduce((a, b) => a + b, 0) / 6
    expect(mean).toBeGreaterThan(0.5) // the mean IS dragged, which is why it is not used
  })

  it('averages the middle pair on an even run, so it does not favour one side', () => {
    expect(centreOfAction([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5, 10)
  })

  it('answers the middle for a still clip rather than guessing', () => {
    expect(centreOfAction([])).toBe(0.5)
    expect(centreOfAction([Number.NaN, Number.POSITIVE_INFINITY])).toBe(0.5)
  })

  it('keeps every sample inside the picture', () => {
    expect(centreOfAction([-3, -2, -1])).toBe(0)
    expect(centreOfAction([4, 5, 6])).toBe(1)
  })
})
