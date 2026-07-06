import { describe, expect, it } from 'vitest'
import {
  channelBase,
  ease,
  evalChannel,
  isChannelAnimated,
  removeKeyframeNear,
  resolveChannel,
  upsertKeyframe,
} from './keyframes'
import { defaultTransform, type Clip, type Keyframe } from './types'

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

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c',
  assetId: 'a',
  startS: 5,
  inS: 0,
  outS: 4,
  speed: 1,
  enabled: true,
  transform: { ...defaultTransform(), x: 100, scale: 2, rotationDeg: 45 },
  opacity: 0.8,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  filters: { brightness: 0.3, blur: 4 },
  ...over,
})

describe('channelBase', () => {
  it('reads static transform / opacity / filter fields', () => {
    const c = clip()
    expect(channelBase(c, 'posX')).toBe(100)
    expect(channelBase(c, 'scale')).toBe(2)
    expect(channelBase(c, 'rotation')).toBe(45)
    expect(channelBase(c, 'opacity')).toBe(0.8)
    expect(channelBase(c, 'brightness')).toBe(0.3)
    expect(channelBase(c, 'blur')).toBe(4)
  })
  it('defaults absent filters to neutral 0', () => {
    const c = clip({ filters: undefined })
    expect(channelBase(c, 'brightness')).toBe(0)
    expect(channelBase(c, 'saturation')).toBe(0)
  })
})

describe('resolveChannel', () => {
  it('falls back to the static base when unanimated', () => {
    expect(resolveChannel(clip(), 'scale', 1)).toBe(2)
  })
  it('uses keyframes (LOCAL time) when animated', () => {
    // Keyframe times are relative to clip start; localT already subtracted by caller.
    const c = clip({ keyframes: { scale: [kf(0, 1), kf(2, 3)] } })
    expect(resolveChannel(c, 'scale', 0)).toBe(1)
    expect(resolveChannel(c, 'scale', 1)).toBeCloseTo(2)
    expect(resolveChannel(c, 'scale', 2)).toBe(3)
  })
  it('isChannelAnimated reflects presence of keyframes', () => {
    expect(isChannelAnimated(clip(), 'scale')).toBe(false)
    expect(isChannelAnimated(clip({ keyframes: { scale: [kf(0, 1)] } }), 'scale')).toBe(true)
    expect(isChannelAnimated(clip({ keyframes: { scale: [] } }), 'scale')).toBe(false)
  })
  it('leaves an unrelated animated channel on the base for others', () => {
    const c = clip({ keyframes: { posX: [kf(0, 0), kf(1, 50)] } })
    expect(resolveChannel(c, 'posX', 0.5)).toBeCloseTo(25)
    expect(resolveChannel(c, 'scale', 0.5)).toBe(2) // still static
  })
})

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
