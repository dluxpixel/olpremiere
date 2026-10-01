import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  clipEdges,
  AUTO_LEVEL_LATENCY_S,
  clipGainEnvelope,
  createClipGain,
  DECLICK_S,
  FADE_KNOTS,
  onSampleGrid,
  compressorParamsFor,
  trackAlignS,
  trackLateS,
  computeClipSchedule,
  dbToGain,
  effectiveAudioClip,
  pitchPreservedSource,
  type GainPoint,
} from './audio'
import { evalChannel } from './keyframes'
import { splitClip } from './timeline'
import { defaultTransform, type Clip, type Keyframe, type Track } from './types'
import { makeClip, makeSeq, makeTrack } from '../components/timelineTestFixtures'

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

/** The envelope's value at an exact knot time. */
const at = (env: { offsetS: number; value: number }[], t: number): number =>
  env.find((p) => Math.abs(p.offsetS - t) < 1e-9)!.value

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

  // Fades are EQUAL POWER: sin(u * pi/2) of the fade's progress, drawn with
  // FADE_KNOTS linear segments. Two of them overlapping (an audio crossfade)
  // therefore sum to one in power all the way across, where two straight
  // lines left a 3 dB hole in the middle.

  it('fade in only: 0 to g over fadeInS on the equal power curve, then flat', () => {
    const env = clipGainEnvelope(clip({ fadeInS: 1 }), 0)!
    expect(env[0]).toEqual({ offsetS: 0, value: 0 })
    expect(at(env, 0.5)).toBeCloseTo(Math.SQRT1_2, 6) // half way is -3 dB, not -6
    expect(at(env, 1)).toBeCloseTo(1, 9)
    expect(env.at(-1)).toEqual({ offsetS: 4, value: 1 })
    expect(env.filter((p) => p.offsetS > 0 && p.offsetS < 1)).toHaveLength(FADE_KNOTS - 1)
  })

  it('fade out only: g to 0 over fadeOutS on the same curve', () => {
    const env = clipGainEnvelope(clip({ fadeOutS: 1 }), 0)!
    expect(env[0]).toEqual({ offsetS: 0, value: 1 })
    expect(at(env, 3)).toBeCloseTo(1, 9)
    expect(at(env, 3.5)).toBeCloseTo(Math.SQRT1_2, 6)
    expect(env.at(-1)).toEqual({ offsetS: 4, value: 0 })
  })

  it('a crossfade holds its level: the outgoing fade and the incoming fade sum to one in power', () => {
    const out = clipGainEnvelope(clip({ fadeOutS: 1 }), 0)!
    const inn = clipGainEnvelope(clip({ fadeInS: 1 }), 0)!
    for (let s = 0; s <= FADE_KNOTS; s++) {
      const u = s / FADE_KNOTS
      const a = at(out, 3 + u) // progress u through the fade out
      const b = at(inn, u) // progress u through the fade in
      expect(a * a + b * b).toBeCloseTo(1, 6)
    }
  })

  it('both fades: 0 up to g, flat, then down to 0', () => {
    const env = clipGainEnvelope(clip({ fadeInS: 1, fadeOutS: 1 }), 0)!
    expect(env[0]).toEqual({ offsetS: 0, value: 0 })
    expect(at(env, 1)).toBeCloseTo(1, 9)
    expect(at(env, 3)).toBeCloseTo(1, 9)
    expect(env.at(-1)).toEqual({ offsetS: 4, value: 0 })
  })

  it('overlapping fades on a short clip scale down proportionally (no overlap)', () => {
    // window length 2, fades 2+2 scale to 1+1, peak g at the centre
    const env = clipGainEnvelope(clip({ outS: 2, fadeInS: 2, fadeOutS: 2 }), 0)!
    expect(env[0]).toEqual({ offsetS: 0, value: 0 })
    expect(at(env, 1)).toBeCloseTo(1, 9)
    expect(env.at(-1)).toEqual({ offsetS: 2, value: 0 })
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
    // The two fades are drawn with FADE_KNOTS segments each; between them the plateau is the static gain.
    expect(env.map((p) => p.offsetS)).toHaveLength(2 * FADE_KNOTS + 2)
    expect(env[0]).toEqual({ offsetS: 0, value: 0 })
    expect(at(env, 1)).toBeCloseTo(g, 9)
    expect(at(env, 3)).toBeCloseTo(g, 9)
    expect(at(env, 0.5)).toBeCloseTo(g * Math.SQRT1_2, 9)
    expect(env.at(-1)).toEqual({ offsetS: 4, value: 0 })
  })

  it('starting mid fade-in sets the partial level then ramps to g', () => {
    // fromS=1 lands halfway through a 2s fade-in on clip [0,4)
    const env = clipGainEnvelope(clip({ fadeInS: 2 }), 1)!
    expect(env[0].offsetS).toBe(0)
    expect(env[0].value).toBeCloseTo(Math.SQRT1_2, 9) // half way up an equal power fade is -3 dB
    expect(at(env, 1)).toBeCloseTo(1, 9) // reaches g at t=2, offset 1
    expect(env.at(-1)).toEqual({ offsetS: 3, value: 1 })
  })

  it('half-speed clip fades over the STRETCHED timeline window', () => {
    // source [0,2) at speed 0.5 → timeline window [0,4); fade-out 1s ends at t=4
    const env = clipGainEnvelope(clip({ outS: 2, speed: 0.5, fadeOutS: 1 }), 0)!
    expect(env[0]).toEqual({ offsetS: 0, value: 1 })
    expect(at(env, 3)).toBeCloseTo(1, 9)
    expect(at(env, 3.5)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(env.at(-1)).toEqual({ offsetS: 4, value: 0 })
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

// The buffer, rate and window the preview and the offline render both schedule
// with. A speed change must shorten the clip and leave his voice alone; a 1x
// clip must cost nothing at all.
describe('pitchPreservedSource', () => {
  const SR = 48000

  const fakeBuffer = (channels: Float32Array[], sampleRate = SR): AudioBuffer =>
    ({
      numberOfChannels: channels.length,
      length: channels[0].length,
      sampleRate,
      duration: channels[0].length / sampleRate,
      getChannelData: (ch: number) => channels[ch],
    }) as unknown as AudioBuffer

  const fakeCtx = (): BaseAudioContext =>
    ({
      createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => {
        const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
        return {
          numberOfChannels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: (ch: number) => data[ch],
          copyToChannel: (src: Float32Array, ch: number) =>
            data[ch].set(src.subarray(0, Math.min(src.length, length))),
        } as unknown as AudioBuffer
      },
    }) as unknown as BaseAudioContext

  const sine = (freq: number, frames: number): Float32Array => {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) out[i] = Math.sin(2 * Math.PI * freq * (i / SR))
    return out
  }

  const dominantHz = (buf: Float32Array): number => {
    const a = Math.floor(buf.length * 0.2)
    const b = Math.floor(buf.length * 0.8)
    let crossings = 0
    for (let i = a + 1; i < b; i++) if (buf[i - 1] <= 0 && buf[i] > 0) crossings++
    return (crossings * SR) / (b - a)
  }

  it('hands a 1x clip straight back: same buffer, rate 1, window untouched', () => {
    const buf = fakeBuffer([sine(440, SR * 2)])
    const sched = { whenOffsetS: 0, sourceOffsetS: 0.5, durationS: 1 }
    const play = pitchPreservedSource(fakeCtx(), buf, 1, sched)
    expect(play.buffer).toBe(buf)
    expect(play.playbackRate).toBe(1)
    expect(play.offsetS).toBe(0.5)
    expect(play.durationS).toBe(1)
  })

  it('plays a sped-up clip at rate 1, so nothing can resample his voice', () => {
    const buf = fakeBuffer([sine(440, SR * 2)])
    const play = pitchPreservedSource(fakeCtx(), buf, 2, {
      whenOffsetS: 0,
      sourceOffsetS: 0,
      durationS: 2,
    })
    expect(play.playbackRate).toBe(1)
    expect(play.buffer).not.toBe(buf)
    expect(play.offsetS).toBe(0)
  })

  it('is exactly as long as the timeline window, so audio cannot drift off the picture', () => {
    const buf = fakeBuffer([sine(440, SR * 4)])
    for (const speed of [0.5, 1.25, 2, 3]) {
      const durationS = 2
      const play = pitchPreservedSource(fakeCtx(), buf, speed, {
        whenOffsetS: 0,
        sourceOffsetS: 0,
        durationS,
      })
      expect(play.durationS).toBeCloseTo(durationS / speed, 4)
      expect(play.buffer.length).toBe(Math.round((durationS * SR) / speed))
    }
  })

  // ⚠️ This one is only half the proof and cannot stand alone: it reads the
  // buffer's content, and the OLD code handed back a buffer at 440 Hz too. It
  // is the "rate 1" test above that stops that buffer being resampled on the
  // way out. Content at 440 plus rate 1 is what he hears at 440.
  it('keeps 440 Hz at 440 Hz through the buffer the preview actually schedules', () => {
    const buf = fakeBuffer([sine(440, SR * 2)])
    const play = pitchPreservedSource(fakeCtx(), buf, 2, {
      whenOffsetS: 0,
      sourceOffsetS: 0,
      durationS: 2,
    })
    expect(dominantHz(play.buffer.getChannelData(0))).toBeGreaterThan(415)
    expect(dominantHz(play.buffer.getChannelData(0))).toBeLessThan(465)
  })

  it('carries every channel of a stereo clip', () => {
    const buf = fakeBuffer([sine(440, SR), sine(660, SR)])
    const play = pitchPreservedSource(fakeCtx(), buf, 2, {
      whenOffsetS: 0,
      sourceOffsetS: 0,
      durationS: 1,
    })
    expect(play.buffer.numberOfChannels).toBe(2)
    expect(dominantHz(play.buffer.getChannelData(0))).toBeLessThan(500)
    expect(dominantHz(play.buffer.getChannelData(1))).toBeGreaterThan(600)
  })

  it('reads from the right place in the source', () => {
    // First second silent, second second a tone: asking for the second second
    // must give a tone, not silence.
    const data = new Float32Array(SR * 2)
    data.set(sine(440, SR), SR)
    const play = pitchPreservedSource(fakeCtx(), fakeBuffer([data]), 2, {
      whenOffsetS: 0,
      sourceOffsetS: 1,
      durationS: 1,
    })
    let peak = 0
    for (const v of play.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.5)
  })

  it('clamps a clip that runs past the end of its asset instead of inventing audio', () => {
    const buf = fakeBuffer([sine(440, SR)])
    const play = pitchPreservedSource(fakeCtx(), buf, 2, {
      whenOffsetS: 0,
      sourceOffsetS: 0.5,
      // Asks for 3 s of a 1 s asset; only 0.5 s is really there.
      durationS: 3,
    })
    expect(play.buffer.length).toBe(Math.round((0.5 * SR) / 2))
  })
})

// Pressing play must not redo the stretch every time. The clips ahead of the
// playhead are scheduled from their own in point, so their key never moves.
describe('pitchPreservedSource caching', () => {
  const SR = 48000
  const buf = (frames: number): AudioBuffer => {
    const data = new Float32Array(frames)
    for (let i = 0; i < frames; i++) data[i] = Math.sin(2 * Math.PI * 440 * (i / SR))
    return {
      numberOfChannels: 1,
      length: frames,
      sampleRate: SR,
      duration: frames / SR,
      getChannelData: () => data,
    } as unknown as AudioBuffer
  }
  const countingCtx = (): { ctx: BaseAudioContext; made: () => number } => {
    let made = 0
    const ctx = {
      createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => {
        made++
        const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
        return {
          numberOfChannels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: (ch: number) => data[ch],
          copyToChannel: (src: Float32Array, ch: number) => data[ch].set(src),
        } as unknown as AudioBuffer
      },
    } as unknown as BaseAudioContext
    return { ctx, made: () => made }
  }

  it('does the work once for the same clip at the same speed', () => {
    const source = buf(SR * 2)
    const { ctx, made } = countingCtx()
    const sched = { whenOffsetS: 0, sourceOffsetS: 0, durationS: 2 }
    const a = pitchPreservedSource(ctx, source, 2, sched)
    const b = pitchPreservedSource(ctx, source, 2, sched)
    expect(made()).toBe(1)
    expect(b.buffer).toBe(a.buffer)
    expect(b.playbackRate).toBe(1)
    expect(b.offsetS).toBe(0)
    expect(b.durationS).toBeCloseTo(1, 4)
  })

  it('re-stretches when he changes the speed', () => {
    const source = buf(SR * 2)
    const { ctx, made } = countingCtx()
    const sched = { whenOffsetS: 0, sourceOffsetS: 0, durationS: 2 }
    pitchPreservedSource(ctx, source, 2, sched)
    pitchPreservedSource(ctx, source, 1.5, sched)
    expect(made()).toBe(2)
  })

  it('does not grow without limit as he fiddles with the speed', () => {
    const source = buf(SR)
    const { ctx } = countingCtx()
    for (const speed of [1.25, 1.5, 1.75, 2, 2.5, 3]) {
      pitchPreservedSource(ctx, source, speed, {
        whenOffsetS: 0,
        sourceOffsetS: 0,
        durationS: 1,
      })
    }
    // The earliest speeds have been dropped; the most recent are still there.
    const { ctx: probe, made } = countingCtx()
    pitchPreservedSource(probe, source, 3, { whenOffsetS: 0, sourceOffsetS: 0, durationS: 1 })
    expect(made()).toBe(0)
    pitchPreservedSource(probe, source, 1.25, { whenOffsetS: 0, sourceOffsetS: 0, durationS: 1 })
    expect(made()).toBe(1)
  })
})

// ⛔ THE CLOCK IS READ AFTER THE LAST SLOW CALL, AND UNTIL 2026-08-24 IT WAS NOT.
//
// His words: *"sometimes I know it's just popping off. It's not working."* The
// time-stretch is synchronous and can run for hundreds of milliseconds against a
// 50 ms latency budget, so a `baseT` captured above the loop was already in the
// past by the time sources were started: they all fired at once and every fade
// snapped to its target.
//
// This is a SOURCE-ORDER test on purpose. The failure needs a real AudioContext
// and a real several-hundred-millisecond stall to reproduce, which no unit test
// can stage honestly, but the invariant that prevents it is a plain ordering fact
// and that IS checkable. Same shape as `updateCardWiring.test.ts`.
describe('the audio schedule reads its clock last', () => {
  const src = readFileSync(fileURLToPath(new URL('./audio.ts', import.meta.url)), 'utf8')
  const body = src.slice(src.indexOf('export async function scheduleAudio'))

  it('does every time-stretch before it reads ctx.currentTime for baseT', () => {
    // The CALL, not its argument list: the anchor argument was added the same
    // day and a literal match would have gone stale within the hour.
    const stretch = body.indexOf('pitchPreservedSource(ctx, got.buffer, clip.speed, onBuffer')
    const base = body.indexOf('const baseT = ctx.currentTime + SCHEDULE_LATENCY_S')
    expect(stretch).toBeGreaterThan(-1)
    expect(base).toBeGreaterThan(-1)
    expect(stretch).toBeLessThan(base)
  })

  it('calls the stretch exactly once, so the hoist did not leave a second copy', () => {
    const calls = body.match(/pitchPreservedSource\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('starts every source against that one base time, moved earlier by exactly what the graph delays', () => {
    // The transport anchors the picture at baseT. The track alignment and the
    // master limiter delay the sound on its way out, so the sources start that
    // much early and the sound still arrives at baseT.
    expect(body).toContain('const startT = baseT - alignS - masterLatencyS()')
    // a plain track then waits for the Auto-level ones, exactly as in the export
    expect(body).toContain('const trackT = startT + trackLateS(track, alignS)')
    // on the sample grid (onSampleGrid), as the export does
    expect(body).toContain('source.start(onSampleGrid(trackT + sched.whenOffsetS, ctx.sampleRate)')
    // and the duck, which rides after the alignment, moves with the sound
    expect(body).toContain('const when = startT + alignS + pt.offsetS')
  })
})

// AUTO-LEVEL MADE ITS TRACK LATE, 2026-09-29. The DynamicsCompressorNode always
// looks 6 ms ahead (288 samples at 48 kHz, measured in this Electron), so every
// voiceover on an Auto-level track reached the file 6 ms behind the picture and
// behind every other track. It cannot be switched off, so the other tracks wait
// the same 6 ms and whoever plays the mix takes the shared wait back off.
describe('every track waits as long as Auto-level does', () => {
  it('is the compressor\'s own delay, 288 samples at 48 kHz', () => {
    expect(AUTO_LEVEL_LATENCY_S * 48000).toBe(288)
  })

  it('adds no wait at all when no track uses Auto-level, so that mix is the graph it always was', () => {
    expect(trackAlignS([{ autoLevel: undefined }, { autoLevel: 'off' }])).toBe(0)
    expect(trackLateS({ autoLevel: undefined }, 0)).toBe(0)
  })

  it('starts a plain track 6 ms later once any track uses Auto-level, and the Auto-level track on time', () => {
    const alignS = trackAlignS([{ autoLevel: undefined }, { autoLevel: 'medium' }])
    expect(alignS).toBe(AUTO_LEVEL_LATENCY_S)
    expect(trackLateS({ autoLevel: undefined }, alignS)).toBe(AUTO_LEVEL_LATENCY_S)
    expect(trackLateS({ autoLevel: 'off' }, alignS)).toBe(AUTO_LEVEL_LATENCY_S)
    // its compressor already waits the 6 ms
    expect(trackLateS({ autoLevel: 'medium' }, alignS)).toBe(0)
  })
})

// ⛔ THE STRETCH CACHE KEY MUST NOT MOVE WHEN THE PLAYHEAD DOES, 2026-08-24.
//
// The key used to carry `sourceOffsetS`, which comes from the transport's live
// time, so the clip under the playhead was a guaranteed MISS on every reschedule
// and re-ran WSOLA over its whole remainder, synchronously, on the main thread.
// A mute, a fader nudge or a loop wrap cost hundreds of milliseconds of frozen
// UI. Anchoring at the clip's in point makes the key stand still.
describe('a stretched clip is stretched once, not once per reschedule', () => {
  const sr = 48_000
  const makeBuffer = (seconds: number): AudioBuffer => {
    const length = Math.round(seconds * sr)
    const data = [new Float32Array(length), new Float32Array(length)]
    for (let i = 0; i < length; i++) {
      const v = Math.sin((i / sr) * 2 * Math.PI * 220)
      data[0][i] = v
      data[1][i] = v
    }
    return {
      sampleRate: sr,
      length,
      duration: seconds,
      numberOfChannels: 2,
      getChannelData: (ch: number) => data[ch],
      copyToChannel: (src: Float32Array, ch: number) => data[ch].set(src),
    } as unknown as AudioBuffer
  }

  /** A context that counts the buffers it is asked to allocate. */
  const countingCtx = (): { ctx: BaseAudioContext; made: () => number } => {
    let made = 0
    const ctx = {
      sampleRate: sr,
      createBuffer: (channels: number, length: number, rate: number) => {
        made += 1
        const data = Array.from({ length: channels }, () => new Float32Array(length))
        return {
          sampleRate: rate,
          length,
          duration: length / rate,
          numberOfChannels: channels,
          getChannelData: (ch: number) => data[ch],
          copyToChannel: (src: Float32Array, ch: number) => data[ch].set(src),
        } as unknown as AudioBuffer
      },
    } as unknown as BaseAudioContext
    return { ctx, made: () => made }
  }

  it('hits the cache when the playhead moves inside the same clip', () => {
    const buffer = makeBuffer(4)
    const { ctx, made } = countingCtx()
    const OUT = 4
    // Play from the clip's head, then from a second in, then from two: one clip,
    // three transport positions, which is exactly what a reschedule does.
    const first = pitchPreservedSource(ctx, buffer, 2, { whenOffsetS: 0, sourceOffsetS: 0, durationS: OUT }, 0)
    expect(made()).toBe(1)
    const second = pitchPreservedSource(ctx, buffer, 2, { whenOffsetS: 0, sourceOffsetS: 1, durationS: OUT - 1 }, 0)
    const third = pitchPreservedSource(ctx, buffer, 2, { whenOffsetS: 0, sourceOffsetS: 2, durationS: OUT - 2 }, 0)
    // Still one allocation: the two later calls came out of the cache.
    expect(made()).toBe(1)
    expect(second.buffer).toBe(first.buffer)
    expect(third.buffer).toBe(first.buffer)
  })

  it('slices into the cached buffer at the right place, so nothing is replayed', () => {
    const buffer = makeBuffer(4)
    const { ctx } = countingCtx()
    pitchPreservedSource(ctx, buffer, 2, { whenOffsetS: 0, sourceOffsetS: 0, durationS: 4 }, 0)
    const mid = pitchPreservedSource(ctx, buffer, 2, { whenOffsetS: 0, sourceOffsetS: 1, durationS: 3 }, 0)
    // One second of source at 2x is half a second of output.
    expect(mid.offsetS).toBeCloseTo(0.5, 6)
    // And what is left is exactly the rest of the clip's window, so the audible
    // length still matches what computeClipSchedule promised the picture.
    expect(mid.offsetS + mid.durationS).toBeCloseTo(2, 3)
    expect(mid.playbackRate).toBe(1)
  })

  it('leaves a 1x clip completely alone, which is nearly every clip he has', () => {
    const buffer = makeBuffer(2)
    const { ctx, made } = countingCtx()
    const play = pitchPreservedSource(ctx, buffer, 1, { whenOffsetS: 0, sourceOffsetS: 0.5, durationS: 1 }, 0)
    expect(made()).toBe(0)
    expect(play.buffer).toBe(buffer)
    expect(play.offsetS).toBe(0.5)
  })
})

// ⛔ THE THREE GUARDS ON THE DECODE BURST, 2026-08-27. Measured on his own project
// ("Green", 112 clips, backed up the day he said the app was lagging for a
// minute): 17 audible assets, 5.78 GiB of container bytes read into the JS heap
// in ONE pass, 1,114 MB of decoded PCM wanted against a 256 MB budget, and a
// single 674 MB music track that is 2.6x the whole cache on its own.
//
// These are SOURCE-ORDER tests, like the schedule-clock one above, and for the
// same reason: reproducing the real failure needs gigabytes of real media and a
// machine already paging. What can be checked honestly is that the three guards
// are present and that none of them was quietly removed by a later tidy.
describe('the audio decode burst is bounded', () => {
  const src = readFileSync(fileURLToPath(new URL('./audio.ts', import.meta.url)), 'utf8')
  const demuxSrc = readFileSync(fileURLToPath(new URL('./audioDemux.ts', import.meta.url)), 'utf8')

  it('never starts every decode in one tick', () => {
    // Each of these held a whole source file per entry, so a bare Promise.all
    // over them is N whole files resident at once, and no cache budget can bound
    // it: eviction runs as each decode LANDS, while every landed buffer is still
    // pinned by the pending array that asked for it.
    for (const fn of ['export function prewarmAudio', 'export async function warmAudio']) {
      const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 700)
      expect(body).toContain('mapLimit')
      expect(body).not.toMatch(/Promise\.all/)
    }
  })

  it('bounds the schedule own decodes too, which is what Space triggers', () => {
    const body = src.slice(src.indexOf('export async function scheduleAudio'))
    const upToStart = body.slice(0, body.indexOf('const baseT'))
    expect(upToStart).toContain('mapLimit')
    expect(upToStart).not.toMatch(/const buffers = await Promise\.all/)
  })

  it('reads the audio track without pulling the container in, and tries that FIRST', () => {
    // ⛔ THE ORDER IS THE WHOLE POINT SINCE 2026-08-29. The demuxed read works at
    // any size; the whole-file read has a 2 GiB wall. If the size guard ever
    // moves back above the demux, his 2.4 GB recordings go silent again and the
    // guard below would still pass, fencing a branch nothing reaches.
    const decode = src.slice(src.indexOf('async function decodeAssetAudio'))
    const demux = decode.indexOf('demuxAssetAudio(asset, blob)')
    const guard = decode.indexOf('blob.size > MAX_ARRAY_BUFFER_BYTES')
    expect(demux).toBeGreaterThan(-1)
    expect(demux).toBeLessThan(guard)
    // And the demuxed path must not be the one reading whole files.
    // Since 2026-09-28 the read itself lives in audioDemux.ts and runs in a worker.
    const body = src.slice(src.indexOf('async function demuxAssetAudio'), src.indexOf('async function decodeAssetAudio'))
    expect(body).not.toMatch(/arrayBuffer\(\)/)
    expect(body).toContain('decodeAudioOffThread(')
    // Never the whole blob. The one read of raw bytes is an MP3's tag header,
    // 10 bytes and one bounded scan through `blob.slice` (mp3HeadSkip).
    expect(demuxSrc).not.toMatch(/blob\.arrayBuffer\(\)/)
    expect(demuxSrc).toContain('blob.slice(offset, offset + length).arrayBuffer()')
    expect(demuxSrc).toContain('const MP3_SCAN_BYTES = 16_384')
    expect(demuxSrc).toContain('maxCacheSize: DEMUX_CACHE_BYTES')
    expect(demuxSrc).toContain('input.dispose()')
  })

  it('lines the demuxed buffer up with the same axis everything else assumes', () => {
    const body = demuxSrc.slice(demuxSrc.indexOf('export async function demuxAudio'), demuxSrc.indexOf('export type PeaksResult'))
    // Sized from the asset, not from a container walk.
    expect(body).toContain('req.durationS > 0 ? req.durationS')
    // ⛔ EVERY SAMPLE AT ITS OWN TIMESTAMP, NEVER SHIFTED BY THE AAC PRIMING.
    // Subtracting the first timestamp (2026-08-28 to 2026-09-30) made every AAC
    // video's sound 21 to 44 ms late: the priming already sits before zero. The
    // behaviour itself is proven in audioDemux.test.ts.
    expect(body).not.toContain('getFirstTimestamp()')
    // The one shift is an MP3's own encoder and decoder delay (zero for any
    // other file), proven in audioDemux.test.ts with a click at 1.000 s.
    expect(body).toContain('placeSample(sample, planes, length, sampleRate, fromS + skipS)')
    expect(body).toContain('const at = Math.round(sample.timestamp * sampleRate) - skip')
    // copyTo THROWS rather than truncating, and that throw would fall back to a
    // read that cannot work on the files this function exists for.
    expect(body).toContain('length - start')
  })

  it('decodes the whole file fallback at 48 kHz, never at the output device rate', () => {
    // The shared context runs at whatever his output device runs at, so a file
    // read on it came back at 44.1 kHz on one machine and 48 kHz on another, and
    // was then converted again, linearly, by the mixers. Since 2026-10-01 every
    // buffer is 48 kHz: at the track's own rate and then the sinc when the rate
    // is known, straight at 48 kHz when it is not.
    const decode = src.slice(src.indexOf('async function decodeAssetAudio'), src.indexOf('export const DECODE_CONCURRENCY'))
    expect(decode).not.toContain('ensureAudioContext().decodeAudioData')
    expect(decode).toContain('decodeWholeFileAt48k(bytes, undecodableRate.get(asset.id))')
    expect(decode).toContain('new OfflineAudioContext(1, 1, nativeRate).decodeAudioData(bytes)')
    expect(decode).toContain('resamplePlanes(planes, native.sampleRate, out)')
    expect(decode).toContain('return new OfflineAudioContext(1, 1, out).decodeAudioData(bytes)')
  })

  it('refuses a file too big for a single ArrayBuffer instead of throwing into a catch', () => {
    // Two of his three screen recordings were past this limit, so the read threw,
    // the catch returned null, and their sound was simply absent with nothing
    // said. Checked BEFORE the read: the failed attempt is itself expensive on a
    // machine that is paging.
    expect(src).toContain('MAX_ARRAY_BUFFER_BYTES = 2_147_483_647')
    const decode = src.slice(src.indexOf('async function decodeAssetAudio'))
    const guard = decode.indexOf('blob.size > MAX_ARRAY_BUFFER_BYTES')
    const read = decode.indexOf('await blob.arrayBuffer()')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(read)
  })

  it('drops an item larger than the whole cache rather than letting it empty the cache', () => {
    // keepId protection is right and stays; what it must not do is let a 674 MB
    // entry evict sixteen useful ones and then be evicted itself by the next
    // asset, which turned every reschedule into sixteen fresh misses.
    const evict = src.slice(src.indexOf('function evictAudioOverflow'))
    const end = evict.indexOf('\n}\n')
    const body = evict.slice(0, end)
    expect(body).toContain('keepBytes > audioCacheMaxBytes()')
    expect(body).toContain('bufferCache.delete(keepId)')
  })
})

// The export had the same burst and was missed when the preview was capped.
describe('the export decodes on the same leash as the preview', () => {
  const src = readFileSync(fileURLToPath(new URL('./export/audioRender.ts', import.meta.url)), 'utf8')

  it('does not resolve every audible clip at once', () => {
    expect(src).toContain('mapLimit(')
    expect(src).toContain('DECODE_CONCURRENCY')
    expect(src).not.toMatch(/const buffers = await Promise\.all/)
  })
})

// ---------------------------------------------------------------------------
// The two mixers build the same node for every clip, start it at the same
// place and fade its edges the same way. His words, 2026-09-29: *"I want the
// quality to be absolutely the highest, audio and video."*

const liveSrc = readFileSync(fileURLToPath(new URL('./audio.ts', import.meta.url)), 'utf8')
const exportSrc = readFileSync(fileURLToPath(new URL('./export/audioRender.ts', import.meta.url)), 'utf8')
const liveBody = liveSrc.slice(liveSrc.indexOf('export async function scheduleAudio'))
const exportBody = exportSrc.slice(exportSrc.indexOf('const renderSegment = async'))

describe('every clip starts on a whole sample (IP-3)', () => {
  it('moves a start by at most half a sample, onto the grid', () => {
    // Starts from his own projects: GYM's iPhone clip, Voice recording 5 and 14.
    for (const t of [20.3057, 2.859993, 2.87999, 13.5017, 0, 101.00025]) {
      const g = onSampleGrid(t, 48_000)
      expect(Math.abs(g * 48_000 - Math.round(g * 48_000))).toBeLessThan(1e-6)
      expect(Math.abs(g - t)).toBeLessThanOrEqual(0.5 / 48_000 + 1e-12)
    }
    // On a 44.1 kHz device the live context's own grid is used.
    const g = onSampleGrid(2.859993, 44_100)
    expect(Math.abs(g * 44_100 - Math.round(g * 44_100))).toBeLessThan(1e-6)
  })

  it('both mixers start every source on their own context grid', () => {
    expect(liveBody).toContain('source.start(onSampleGrid(trackT + sched.whenOffsetS, ctx.sampleRate)')
    expect(exportBody).toContain('source.start(onSampleGrid(sched.whenOffsetS + late, EXPORT_SAMPLE_RATE)')
    expect(liveBody.match(/source\.start\(/g)).toHaveLength(1)
    expect(exportBody.match(/source\.start\(/g)).toHaveLength(1)
  })
})

describe('a mono file plays L = R at full level, whatever shares its track (EA-6)', () => {
  /** A context that records the clip gain node it builds. */
  const recordingCtx = () => {
    const made: Record<string, unknown>[] = []
    const ctx = {
      createGain: () => {
        const node = { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers', gain: { value: 1 } }
        made.push(node)
        return node
      },
    } as unknown as BaseAudioContext
    return { ctx, made }
  }

  /**
   * The Web Audio spec's own rules, for the one path that decides a clip's level:
   * clip gain node, track gain node ('max'), StereoPannerNode at the centre.
   * Returns [L, R] for a unit mono sample.
   */
  function monoThroughTrack(clipGain: { channelCount: number; channelCountMode: string }, stereoNeighbour: boolean): [number, number] {
    // A node's channels: 'max' takes its widest input, 'explicit' its own count.
    const clipOut = clipGain.channelCountMode === 'explicit' ? clipGain.channelCount : 1
    // Speakers up-mix of mono to stereo copies the sample to both sides at unity.
    const trackChannels = Math.max(clipOut, stereoNeighbour ? 2 : 1)
    if (trackChannels === 2) return [1, 1] // the stereo law at pan 0 passes L and R through
    const x = Math.PI / 4 // the mono law at pan 0: cos and sin of a quarter pi
    return [Math.cos(x), Math.sin(x)]
  }

  it('the clip node is stereo, explicitly, with the speakers up-mix', () => {
    const { ctx, made } = recordingCtx()
    createClipGain(ctx, 0.5)
    expect(made[0]).toMatchObject({ channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  })

  it('holds the envelope first value before the first event, not the default of 1', () => {
    // A start snapped a fraction of a sample early plays one sample before the
    // envelope begins. Measured in Electron 43 with the de-click: at the default
    // that sample was a full scale spike, held at the first value it is silent.
    const { ctx, made } = recordingCtx()
    createClipGain(ctx, 0)
    expect((made[0] as { gain: { value: number } }).gain.value).toBe(0)
  })

  it('alone or next to a stereo clip, the same mono file comes out at the same level', () => {
    const { ctx, made } = recordingCtx()
    createClipGain(ctx, 1)
    const node = made[0] as { channelCount: number; channelCountMode: string }
    const alone = monoThroughTrack(node, false)
    const shared = monoThroughTrack(node, true)
    expect(alone).toEqual(shared)
    expect(alone).toEqual([1, 1])
    // The old node ('max') is what made it -3.01 dB alone and 0.00 dB shared.
    const old = { channelCount: 2, channelCountMode: 'max' }
    expect(20 * Math.log10(monoThroughTrack(old, false)[0])).toBeCloseTo(-3.01, 2)
    expect(monoThroughTrack(old, true)[0]).toBe(1)
  })

  it('both mixers play every clip through that one node', () => {
    for (const body of [liveBody, exportBody]) {
      expect(body).toContain('const gain = createClipGain(ctx, env[0]!.value)')
      expect(body).toContain('source.connect(gain)')
    }
  })
})

describe('a hard audio cut gets a 2 ms de-click, a blade cut none (EA-7)', () => {
  const audioTrack = (clips: Clip[]): Track => makeTrack({ kind: 'audio', clips })

  it('a clip split in two plays on seamlessly: no de-click at the split', () => {
    const c = makeClip({ assetId: 'song', startS: 1, inS: 3, outS: 9 })
    const seq = makeSeq([audioTrack([c])])
    const split = splitClip(seq, c.id, 4.2)
    const track = split.tracks[0]!
    const [left, right] = track.clips as [Clip, Clip]
    expect(clipEdges(track, left)).toEqual({ hardIn: true, hardOut: false })
    expect(clipEdges(track, right)).toEqual({ hardIn: false, hardOut: true })
  })

  it('a split at 2x and a reversed run that continues downward are seamless too', () => {
    const a = makeClip({ assetId: 's', startS: 0, inS: 0, outS: 4, speed: 2 })
    const b = makeClip({ assetId: 's', startS: 2, inS: 4, outS: 6, speed: 2 })
    expect(clipEdges(audioTrack([a, b]), b).hardIn).toBe(false)
    // Reversed, the sound runs from outS down to inS: b carries on below a.
    const ra = makeClip({ assetId: 's', startS: 0, inS: 5, outS: 8, speed: -1 })
    const rb = makeClip({ assetId: 's', startS: 3, inS: 2, outS: 5, speed: -1 })
    expect(clipEdges(audioTrack([ra, rb]), rb).hardIn).toBe(false)
    expect(clipEdges(audioTrack([ra, rb]), ra).hardOut).toBe(false)
  })

  it('everything else is a hard cut: a gap, a jump in the file, another file, another speed, a muted clip', () => {
    const a = makeClip({ assetId: 's', startS: 0, inS: 0, outS: 2 })
    const cases: Clip[] = [
      makeClip({ assetId: 's', startS: 2.5, inS: 2, outS: 3 }), // moved after the split
      makeClip({ assetId: 's', startS: 2, inS: 3, outS: 4 }), // the hard cut the backtest measured
      makeClip({ assetId: 'other', startS: 2, inS: 2, outS: 3 }),
      makeClip({ assetId: 's', startS: 2, inS: 2, outS: 3, speed: 1.5 }),
    ]
    for (const b of cases) expect(clipEdges(audioTrack([a, b]), b).hardIn).toBe(true)
    const off = makeClip({ assetId: 's', startS: 0, inS: 0, outS: 2, enabled: false })
    const b = makeClip({ assetId: 's', startS: 2, inS: 2, outS: 3 })
    expect(clipEdges(audioTrack([off, b]), b).hardIn).toBe(true)
    // A linked video clip makes no sound of its own, so it cannot carry one on.
    const linked = makeClip({ assetId: 's', startS: 0, inS: 0, outS: 2, linkId: 'L' })
    expect(clipEdges(makeTrack({ kind: 'video', clips: [linked, b] }), b).hardIn).toBe(true)
  })

  it('a hard edge with no fade of its own ramps over 2 ms on the equal power curve', () => {
    const env = clipGainEnvelope(clip(), 0, { hardIn: true, hardOut: true })!
    expect(env[0]).toEqual({ offsetS: 0, value: 0 })
    expect(env[env.length - 1]).toEqual({ offsetS: 4, value: 0 })
    // Within the de-click it follows sin(u pi/2); after it, full level.
    for (const u of [0.25, 0.5, 0.75]) expect(rampAt(env, u * DECLICK_S)).toBeCloseTo(Math.sin((u * Math.PI) / 2), 2)
    expect(rampAt(env, DECLICK_S)).toBeCloseTo(1, 9)
    expect(rampAt(env, 2)).toBe(1)
    expect(rampAt(env, 4 - DECLICK_S)).toBeCloseTo(1, 9)
    // The step the backtest measured was 0.431 of full scale in ONE sample; the
    // steepest the de-click allows is under a tenth of that.
    const perSample = Math.max(...env.slice(1).map((p, i) => Math.abs(p.value - env[i]!.value) / Math.max(1e-9, (p.offsetS - env[i]!.offsetS) * 48_000)))
    expect(perSample).toBeLessThan(0.04)
  })

  it('a seamless edge, or one with its own fade, is exactly what it was before', () => {
    expect(clipGainEnvelope(clip(), 0, { hardIn: false, hardOut: false })).toEqual(clipGainEnvelope(clip(), 0))
    const faded = clip({ fadeInS: 0.5, fadeOutS: 0.25 })
    expect(clipGainEnvelope(faded, 0, { hardIn: true, hardOut: true })).toEqual(clipGainEnvelope(faded, 0))
  })

  it('a clip shorter than two de-clicks shares its length between them', () => {
    const env = clipGainEnvelope(clip({ outS: 0.003 }), 0, { hardIn: true, hardOut: true })!
    expect(Math.max(...env.map((p) => p.value))).toBeCloseTo(1, 9)
    expect(env[0]!.value).toBe(0)
    expect(env[env.length - 1]!.value).toBe(0)
  })

  it('both mixers read the edges off the clip as it sits on its track, and hand them to the one envelope', () => {
    for (const [src, body] of [
      [liveSrc, liveBody],
      [exportSrc, exportBody],
    ]) {
      expect(src).toContain('edges: clipEdges(track, clip)')
      expect(body).toContain('clipGainEnvelope(clip, fromS, edges)')
    }
  })
})
