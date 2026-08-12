import { describe, expect, it } from 'vitest'
import {
  clipEmitsAudioOn,
  clipGainEnvelope,
  clipShowsOwnWaveform,
  compressorParamsFor,
  computeClipSchedule,
  dbToGain,
  effectiveAudioClip,
  type GainPoint,
} from './audio'
import { evalChannel } from './keyframes'
import { defaultTransform, type Clip, type Keyframe, type MediaAsset } from './types'

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

/**
 * Read a gain envelope the way every consumer plays it back: hold the first
 * value, then ramp LINEARLY IN AMPLITUDE knot to knot. This is what the
 * subdivision count is really being judged against.
 */
const rampAt = (env: GainPoint[], x: number): number => {
  let prev = env[0]
  for (const p of env) {
    if (p.offsetS >= x) {
      const span = p.offsetS - prev.offsetS
      const f = span <= 0 ? 0 : (x - prev.offsetS) / span
      return prev.value + (p.value - prev.value) * f
    }
    prev = p
  }
  return env[env.length - 1].value
}

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

  it('volume keyframes bake into the envelope as dB sampled at each knot', () => {
    // 0 dB at t=0 → −12 dB at t=2 → −12 dB flat to the end.
    const env = clipGainEnvelope(
      clip({
        keyframes: {
          volume: [
            { t: 0, value: 0, ease: 'linear' },
            { t: 2, value: -12, ease: 'linear' },
          ],
        },
      }),
      0,
    )!
    expect(env[0]).toEqual({ offsetS: 0, value: 1 })
    const at2 = env.find((p) => p.offsetS === 2)!
    expect(at2.value).toBeCloseTo(10 ** (-12 / 20), 6)
    // Past the last keyframe the channel clamps at its final value.
    expect(env.at(-1)!.offsetS).toBe(4)
    expect(env.at(-1)!.value).toBeCloseTo(10 ** (-12 / 20), 6)
  })

  it('volume keyframes compose with fades (fade multiplies the keyframed gain)', () => {
    const env = clipGainEnvelope(
      clip({
        fadeInS: 1,
        keyframes: { volume: [{ t: 0, value: -6, ease: 'linear' }] },
      }),
      0,
    )!
    const g = 10 ** (-6 / 20)
    expect(env[0]).toEqual({ offsetS: 0, value: 0 }) // fade wins at the head
    expect(env.find((p) => p.offsetS === 1)!.value).toBeCloseTo(g, 6)
    expect(env.at(-1)!.value).toBeCloseTo(g, 6)
  })

  it("'hold' ease freezes then SNAPS: no interior ramp, one <=1ms step knot", () => {
    const env = clipGainEnvelope(
      clip({
        keyframes: {
          volume: [
            { t: 0, value: 0, ease: 'hold' },
            { t: 2, value: -12, ease: 'linear' },
          ],
        },
      }),
      0,
    )!
    const low = 10 ** (-12 / 20)
    // Every knot strictly before the step point holds full level.
    for (const p of env.filter((p) => p.offsetS < 2 - 0.001 - 1e-9)) {
      expect(p.value, `offset ${p.offsetS}`).toBeCloseTo(1, 9)
    }
    // The step knot sits within 1ms of the next keyframe, still at the held value.
    const step = env.find((p) => Math.abs(p.offsetS - (2 - 0.001)) < 1e-9)!
    expect(step.value).toBeCloseTo(1, 9)
    expect(env.find((p) => p.offsetS === 2)!.value).toBeCloseTo(low, 9)
  })

  it('a curved segment subdivides into 16 knots and tracks evalChannel within tolerance', () => {
    // snapIn: fast off the mark, long settle. Sixteen straight lines have to
    // stand in for it closely enough that the picture and the mix agree.
    const volume: Keyframe[] = [
      { t: 0, value: 0, ease: 'linear', curve: [0.16, 1, 0.3, 1] },
      { t: 4, value: -12, ease: 'linear' },
    ]
    const env = clipGainEnvelope(clip({ keyframes: { volume } }), 0)!
    // 16 equal subdivisions of the one segment = 17 knots counting both ends.
    expect(env.map((p) => p.offsetS)).toEqual(Array.from({ length: 17 }, (_, i) => (4 * i) / 16))
    for (const p of env) {
      const g = dbToGain(evalChannel(volume, p.offsetS, 0))
      expect(p.value, `knot ${p.offsetS}`).toBeCloseTo(g, 9)
    }

    // Between the knots every consumer ramps in a straight line, so read the
    // envelope the way they play it and compare against the real curve. The
    // tolerance is in dB because that is the unit the error is audible in.
    // Half the knots is the same curve sampled 8 times, which is what a named
    // ease gets and what this segment would have got before the change.
    const coarse = env.filter((_, i) => i % 2 === 0)
    let worstDb = 0
    let worstCoarseDb = 0
    for (let i = 0; i <= 256; i++) {
      const x = (4 * i) / 256
      const meant = evalChannel(volume, x, 0)
      worstDb = Math.max(worstDb, Math.abs(20 * Math.log10(rampAt(env, x)) - meant))
      worstCoarseDb = Math.max(worstCoarseDb, Math.abs(20 * Math.log10(rampAt(coarse, x)) - meant))
    }
    expect(worstDb).toBeLessThan(0.5)
    // And the extra knots earn their place: the same curve at 8 drifts past a dB.
    expect(worstCoarseDb).toBeGreaterThan(1)
  })

  it('a named-ease segment still subdivides into 8 knots', () => {
    const env = clipGainEnvelope(
      clip({
        keyframes: {
          volume: [
            { t: 0, value: 0, ease: 'easeOut' },
            { t: 4, value: -12, ease: 'linear' },
          ],
        },
      }),
      0,
    )!
    expect(env.map((p) => p.offsetS)).toEqual(Array.from({ length: 9 }, (_, i) => (4 * i) / 8))
  })

  it('a clip WITHOUT volume keyframes produces the exact pre-keyframe envelope', () => {
    // Byte-determinism guard: the volume-aware path must collapse to the old
    // constant-gain math when no keyframes exist.
    const env = clipGainEnvelope(clip({ audioGainDb: -6, fadeInS: 1, fadeOutS: 1 }), 0)!
    const g = 10 ** (-6 / 20)
    expect(env.map((p) => p.offsetS)).toEqual([0, 1, 3, 4])
    expect(env[0].value).toBe(0)
    expect(env[1].value).toBeCloseTo(g, 9)
    expect(env[2].value).toBeCloseTo(g, 9)
    expect(env[3].value).toBe(0)
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

describe('effectiveAudioClip (reverse)', () => {
  it('forward clips pass through unchanged (same reference)', () => {
    const c = clip({ speed: 1 })
    expect(effectiveAudioClip(c, 10)).toBe(c)
  })

  it('mirrors the in/out window about the source duration for reverse', () => {
    const c = clip({ speed: -1, inS: 2, outS: 6 })
    const eff = effectiveAudioClip(c, 10)
    expect(eff.speed).toBe(1)
    expect(eff.inS).toBe(4) // 10 - 6
    expect(eff.outS).toBe(8) // 10 - 2
    expect(eff.outS - eff.inS).toBe(6 - 2) // same content length
  })

  it('the effective clip schedules where the raw reverse clip cannot', () => {
    const c = clip({ speed: -2, inS: 0, outS: 4, startS: 0 })
    expect(computeClipSchedule(c, 0)).toBeNull() // reverse rejected directly
    expect(computeClipSchedule(effectiveAudioClip(c, 8), 0)).not.toBeNull()
  })
})

describe('compressorParamsFor (loudness equalization)', () => {
  it('off / undefined bypasses (null)', () => {
    expect(compressorParamsFor('off')).toBeNull()
    expect(compressorParamsFor(undefined)).toBeNull()
  })

  it('higher degree = lower threshold, higher ratio, more makeup', () => {
    const lo = compressorParamsFor('low')!
    const mid = compressorParamsFor('medium')!
    const hi = compressorParamsFor('high')!
    expect(lo.threshold).toBeGreaterThan(mid.threshold)
    expect(mid.threshold).toBeGreaterThan(hi.threshold)
    expect(lo.ratio).toBeLessThan(mid.ratio)
    expect(mid.ratio).toBeLessThan(hi.ratio)
    expect(lo.makeupDb).toBeLessThan(hi.makeupDb)
  })

  it('params stay in Web Audio DynamicsCompressor valid ranges', () => {
    for (const lvl of ['low', 'medium', 'high'] as const) {
      const p = compressorParamsFor(lvl)!
      expect(p.threshold).toBeGreaterThanOrEqual(-100)
      expect(p.threshold).toBeLessThanOrEqual(0)
      expect(p.ratio).toBeGreaterThanOrEqual(1)
      expect(p.ratio).toBeLessThanOrEqual(20)
      expect(p.knee).toBeGreaterThanOrEqual(0)
      expect(p.knee).toBeLessThanOrEqual(40)
      expect(p.attack).toBeGreaterThanOrEqual(0)
      expect(p.release).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('clipShowsOwnWaveform (the timeline draws a video clip its own waveform)', () => {
  const asset = (patch: Partial<MediaAsset> = {}): MediaAsset => ({
    id: 'a1',
    name: 'a.webm',
    kind: 'video',
    blobKey: 'b1',
    durationS: 10,
    hasAudio: true,
    hasVideo: true,
    ...patch,
  })

  it('draws it for a standalone video clip that carries its own sound', () => {
    expect(clipShowsOwnWaveform('video', clip(), asset())).toBe(true)
  })

  it('does NOT draw it on an audio track, which already has the full-height one', () => {
    expect(clipShowsOwnWaveform('audio', clip(), asset({ kind: 'audio', hasVideo: false }))).toBe(false)
  })

  it('does NOT draw it for a LINKED video clip, whose sound is on its partner', () => {
    expect(clipShowsOwnWaveform('video', clip({ linkId: 'l1' }), asset())).toBe(false)
  })

  // The band is a dark strip over a canvas that can never paint: getAssetPeaks
  // returns null when the asset has no audio, so it would eat a third of the
  // clip's height to say nothing at all.
  it('does NOT draw it for a SILENT video, which has no peaks to show', () => {
    expect(clipShowsOwnWaveform('video', clip(), asset({ hasAudio: false }))).toBe(false)
  })

  it('does NOT draw it for a title or an adjustment clip, which reference no media', () => {
    expect(clipShowsOwnWaveform('video', clip({ title: { text: 'hi' } as never }), asset())).toBe(false)
    expect(clipShowsOwnWaveform('video', clip({ adjustment: true }), asset())).toBe(false)
  })

  it('does NOT draw it when the media is missing entirely', () => {
    expect(clipShowsOwnWaveform('video', clip(), undefined)).toBe(false)
  })

  // Audibility is NOT restated in the gate: it defers to clipEmitsAudioOn, so a
  // change to what he hears can never leave the timeline showing the old rule.
  it('agrees with what the mixer and the export decide is audible', () => {
    const standalone = clip()
    const linked = clip({ linkId: 'l1' })
    expect(clipShowsOwnWaveform('video', standalone, asset())).toBe(clipEmitsAudioOn('video', standalone))
    expect(clipShowsOwnWaveform('video', linked, asset())).toBe(clipEmitsAudioOn('video', linked))
  })
})
