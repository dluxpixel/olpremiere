import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  clipGainEnvelope,
  compressorParamsFor,
  computeClipSchedule,
  dbToGain,
  effectiveAudioClip,
  pitchPreservedSource,
  type GainPoint,
} from './audio'
import { evalChannel } from './keyframes'
import { defaultTransform, type Clip, type Keyframe } from './types'

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
    const stretch = body.indexOf('pitchPreservedSource(ctx, buffer, clip.speed, sched')
    const base = body.indexOf('const baseT = ctx.currentTime + SCHEDULE_LATENCY_S')
    expect(stretch).toBeGreaterThan(-1)
    expect(base).toBeGreaterThan(-1)
    expect(stretch).toBeLessThan(base)
  })

  it('calls the stretch exactly once, so the hoist did not leave a second copy', () => {
    const calls = body.match(/pitchPreservedSource\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('starts every source against that one base time', () => {
    expect(body).toContain('source.start(baseT + sched.whenOffsetS')
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
