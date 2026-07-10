import { describe, expect, it } from 'vitest'
import { ease, evalChannel, removeKeyframeNear, upsertKeyframe } from './keyframes'
import { type Keyframe } from './types'

const kf = (t: number, value: number, e: Keyframe['ease'] = 'linear'): Keyframe => ({ t, value, ease: e })

describe('ease', () => {
  it('linear/hold are identity on progress', () => {
    expect(ease('linear', 0.3)).toBeCloseTo(0.3)
    expect(ease('hold', 0.3)).toBeCloseTo(0.3)
  })
  it('easeIn/easeOut are quadratic mirrors', () => {
    expect(ease('easeIn', 0.5)).toBeCloseTo(0.25)
    expect(ease('easeOut', 0.5)).toBeCloseTo(0.75)
  })
  it('easeInOut is symmetric around 0.5', () => {
    expect(ease('easeInOut', 0)).toBeCloseTo(0)
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5)
    expect(ease('easeInOut', 1)).toBeCloseTo(1)
    expect(ease('easeInOut', 0.25) + ease('easeInOut', 0.75)).toBeCloseTo(1)
  })
  it('clamps out-of-range progress', () => {
    expect(ease('linear', -1)).toBe(0)
    expect(ease('linear', 2)).toBe(1)
  })
})

describe('evalChannel', () => {
  it('returns fallback for empty channels', () => {
    expect(evalChannel(undefined, 1, 42)).toBe(42)
    expect(evalChannel([], 1, 42)).toBe(42)
  })
  it('single keyframe holds everywhere', () => {
    expect(evalChannel([kf(2, 7)], 0, 0)).toBe(7)
    expect(evalChannel([kf(2, 7)], 5, 0)).toBe(7)
  })
  it('clamps before first and after last', () => {
    const ch = [kf(1, 10), kf(3, 30)]
    expect(evalChannel(ch, 0, 0)).toBe(10)
    expect(evalChannel(ch, 9, 0)).toBe(30)
  })
  it('linear-interpolates between keyframes', () => {
    const ch = [kf(1, 10), kf(3, 30)]
    expect(evalChannel(ch, 2, 0)).toBeCloseTo(20)
    expect(evalChannel(ch, 1.5, 0)).toBeCloseTo(15)
  })
  it('applies the LEFT keyframe easing to the segment', () => {
    const ch = [kf(0, 0, 'easeIn'), kf(2, 100)]
    expect(evalChannel(ch, 1, 0)).toBeCloseTo(25) // easeIn(0.5)=0.25
  })
  it('hold easing steps at the left value across the whole segment', () => {
    const ch = [kf(0, 10, 'hold'), kf(2, 20)]
    expect(evalChannel(ch, 0.1, 0)).toBe(10)
    expect(evalChannel(ch, 1.99, 0)).toBe(10)
    expect(evalChannel(ch, 2, 0)).toBe(20)
  })
  it('handles many keyframes via the segment search', () => {
    const ch = [kf(0, 0), kf(1, 10), kf(2, 5), kf(3, 25)]
    expect(evalChannel(ch, 0.5, 0)).toBeCloseTo(5)
    expect(evalChannel(ch, 1.5, 0)).toBeCloseTo(7.5)
    expect(evalChannel(ch, 2.5, 0)).toBeCloseTo(15)
  })
})

// Channel resolution moved to effects/channels.ts (it needs the registry); its
// tests live in effects/channels.test.ts. This module is pure math now.

describe('upsertKeyframe / removeKeyframeNear', () => {
  it('inserts sorted', () => {
    let ch = upsertKeyframe(undefined, kf(2, 20))
    ch = upsertKeyframe(ch, kf(0, 0))
    ch = upsertKeyframe(ch, kf(1, 10))
    expect(ch.map((k) => k.t)).toEqual([0, 1, 2])
  })
  it('replaces at an existing (near-exact) time', () => {
    const ch = upsertKeyframe([kf(1, 10)], kf(1, 99))
    expect(ch).toHaveLength(1)
    expect(ch[0].value).toBe(99)
  })
  it('removes the nearest within tolerance, else no-op', () => {
    const ch = [kf(0, 0), kf(1, 10), kf(2, 20)]
    expect(removeKeyframeNear(ch, 1.0001, 0.01).map((k) => k.t)).toEqual([0, 2])
    expect(removeKeyframeNear(ch, 5, 0.01)).toBe(ch)
  })
})
