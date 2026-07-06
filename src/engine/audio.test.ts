import { describe, expect, it } from 'vitest'
import { clipGainEnvelope, computeClipSchedule, dbToGain } from './audio'
import { defaultTransform, type Clip } from './types'

const clip = (patch: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  assetId: 'a1',
  startS: 0,
  inS: 0,
  outS: 4,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...patch,
})

describe('dbToGain', () => {
  it('0 dB is unity', () => {
    expect(dbToGain(0)).toBe(1)
  })
  it('-6 dB is ~0.501', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
  })
  it('+6 dB is ~1.995', () => {
    expect(dbToGain(6)).toBeCloseTo(1.995, 3)
  })
  it('-20 dB is exactly 0.1', () => {
    expect(dbToGain(-20)).toBeCloseTo(0.1, 10)
  })
  it('-Infinity dB is silence', () => {
    expect(dbToGain(-Infinity)).toBe(0)
  })
})

describe('computeClipSchedule', () => {
  it('clip fully ahead of fromS: positive whenOffset, source starts at inS', () => {
    const c = clip({ startS: 3, inS: 0.5, outS: 2.5 })
    expect(computeClipSchedule(c, 1)).toEqual({
      whenOffsetS: 2,
      sourceOffsetS: 0.5,
      durationS: 2,
    })
  })

  it('fromS exactly at clip start plays the whole trim immediately', () => {
    const c = clip({ startS: 3, inS: 1, outS: 5 })
    expect(computeClipSchedule(c, 3)).toEqual({
      whenOffsetS: 0,
      sourceOffsetS: 1,
      durationS: 4,
    })
  })

  it('fromS mid-clip: whenOffset 0, source offset advanced', () => {
    const c = clip({ startS: 2, inS: 1, outS: 5 })
    expect(computeClipSchedule(c, 3)).toEqual({
      whenOffsetS: 0,
      sourceOffsetS: 2,
      durationS: 3,
    })
  })

  it('clip ending exactly at fromS is null', () => {
    const c = clip({ startS: 0, inS: 0, outS: 2 })
    expect(computeClipSchedule(c, 2)).toBeNull()
  })

  it('clip ended before fromS is null', () => {
    const c = clip({ startS: 0, inS: 0, outS: 2 })
    expect(computeClipSchedule(c, 5)).toBeNull()
  })

  it('disabled clip is null', () => {
    const c = clip({ enabled: false })
    expect(computeClipSchedule(c, 0)).toBeNull()
  })

  it('reverse speed is null (reverse audio is Phase 7)', () => {
    const c = clip({ speed: -1 })
    expect(computeClipSchedule(c, 0)).toBeNull()
  })

  it('speed 0 is null (never advances)', () => {
    const c = clip({ speed: 0 })
    expect(computeClipSchedule(c, 0)).toBeNull()
  })

  it('zero-length trim is null', () => {
    const c = clip({ inS: 1, outS: 1 })
    expect(computeClipSchedule(c, 0)).toBeNull()
  })

  describe('speed 2 (timeline window is half the source length)', () => {
    // startS 1, source [0,4) at speed 2 → timeline window [1,3)
    const fast = () => clip({ startS: 1, inS: 0, outS: 4, speed: 2 })

    it('from before the clip: full source duration', () => {
      expect(computeClipSchedule(fast(), 0)).toEqual({
        whenOffsetS: 1,
        sourceOffsetS: 0,
        durationS: 4,
      })
    })

    it('1s into the clip consumes 2 source seconds', () => {
      const s = computeClipSchedule(fast(), 2)
      expect(s).toEqual({ whenOffsetS: 0, sourceOffsetS: 2, durationS: 2 })
      // durationS is SOURCE seconds: audible length = 2 / 2 = 1s,
      // exactly the remaining timeline window (3 - 2).
      expect((s?.durationS ?? 0) / 2).toBeCloseTo(3 - 2)
    })

    it('ends at startS + sourceLen/speed, not + sourceLen', () => {
      expect(computeClipSchedule(fast(), 3)).toBeNull()
      expect(computeClipSchedule(fast(), 2.999)).not.toBeNull()
    })
  })

  describe('speed 0.5 (timeline window is double the source length)', () => {
    // startS 2, source [1,3) at speed 0.5 → timeline window [2,6)
    const slow = () => clip({ startS: 2, inS: 1, outS: 3, speed: 0.5 })

    it('from before the clip: full source duration', () => {
      expect(computeClipSchedule(slow(), 0)).toEqual({
        whenOffsetS: 2,
        sourceOffsetS: 1,
        durationS: 2,
      })
    })

    it('2s into the clip consumes 1 source second', () => {
      const s = computeClipSchedule(slow(), 4)
      expect(s).toEqual({ whenOffsetS: 0, sourceOffsetS: 2, durationS: 1 })
      // Audible length = 1 / 0.5 = 2s = remaining timeline window (6 - 4).
      expect((s?.durationS ?? 0) / 0.5).toBeCloseTo(6 - 4)
    })

    it('still audible until the stretched end', () => {
      expect(computeClipSchedule(slow(), 5.9)).not.toBeNull()
      expect(computeClipSchedule(slow(), 6)).toBeNull()
    })
  })
})

describe('clipGainEnvelope', () => {
  // clip [0,4) at unity gain unless overridden.
  it('no fades → flat at the static gain across the window', () => {
    const env = clipGainEnvelope(clip(), 0)
    expect(env).toEqual([
      { offsetS: 0, value: 1 },
      { offsetS: 4, value: 1 },
    ])
  })

  it('respects audioGainDb as the plateau level', () => {
    const env = clipGainEnvelope(clip({ audioGainDb: -6 }), 0)!
    expect(env[0].value).toBeCloseTo(0.501, 3)
    expect(env.at(-1)!.value).toBeCloseTo(0.501, 3)
  })

  it('fade in only: 0 → g over fadeInS', () => {
    const env = clipGainEnvelope(clip({ fadeInS: 1 }), 0)
    expect(env).toEqual([
      { offsetS: 0, value: 0 },
      { offsetS: 1, value: 1 },
      { offsetS: 4, value: 1 },
    ])
  })

  it('fade out only: g → 0 over fadeOutS', () => {
    const env = clipGainEnvelope(clip({ fadeOutS: 1 }), 0)
    expect(env).toEqual([
      { offsetS: 0, value: 1 },
      { offsetS: 3, value: 1 },
      { offsetS: 4, value: 0 },
    ])
  })

  it('both fades: trapezoid 0 → g → g → 0', () => {
    const env = clipGainEnvelope(clip({ fadeInS: 1, fadeOutS: 1 }), 0)
    expect(env).toEqual([
      { offsetS: 0, value: 0 },
      { offsetS: 1, value: 1 },
      { offsetS: 3, value: 1 },
      { offsetS: 4, value: 0 },
    ])
  })

  it('overlapping fades on a short clip scale down proportionally (no overlap)', () => {
    // window length 2, fades 2+2 → scaled to 1+1, peak g at the center
    const env = clipGainEnvelope(clip({ outS: 2, fadeInS: 2, fadeOutS: 2 }), 0)
    expect(env).toEqual([
      { offsetS: 0, value: 0 },
      { offsetS: 1, value: 1 },
      { offsetS: 2, value: 0 },
    ])
  })

  it('starting mid fade-in sets the partial level then ramps to g', () => {
    // fromS=1 lands halfway through a 2s fade-in on clip [0,4)
    const env = clipGainEnvelope(clip({ fadeInS: 2 }), 1)!
    expect(env[0]).toEqual({ offsetS: 0, value: 0.5 })
    expect(env[1]).toEqual({ offsetS: 1, value: 1 }) // reaches g at t=2 → offset 1
    expect(env.at(-1)).toEqual({ offsetS: 3, value: 1 })
  })

  it('half-speed clip fades over the STRETCHED timeline window', () => {
    // source [0,2) at speed 0.5 → timeline window [0,4); fade-out 1s ends at t=4
    const env = clipGainEnvelope(clip({ outS: 2, speed: 0.5, fadeOutS: 1 }), 0)
    expect(env).toEqual([
      { offsetS: 0, value: 1 },
      { offsetS: 3, value: 1 },
      { offsetS: 4, value: 0 },
    ])
  })

  it('returns null when the clip contributes no audio', () => {
    expect(clipGainEnvelope(clip({ enabled: false }), 0)).toBeNull()
    expect(clipGainEnvelope(clip({ speed: -1 }), 0)).toBeNull()
    expect(clipGainEnvelope(clip(), 5)).toBeNull()
  })
})
