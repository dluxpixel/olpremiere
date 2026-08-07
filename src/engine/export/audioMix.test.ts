import { LIMIT_CEILING, LIMIT_KNEE } from '../audioLimiter'
import { describe, expect, it } from 'vitest'
import {
  applyGainEnvelope,
  downmixToMono,
  equalPowerPan,
  linearResampleChannel,
  mixToStereo,
  sampleLinear,
  softLimit,
  sumAndLimit,
  type MixSourcePcm,
} from './audioMix'
import { defaultTransform, newTrack, type Clip, type Track } from '../types'
import type { GainPoint } from '../audio'

const HALF_POWER = Math.cos(Math.PI / 4) // ~0.70710678

const clip = (patch: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  assetId: 'a1',
  startS: 0,
  inS: 0,
  outS: 1,
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

const track = (patch: Partial<Track> = {}): Track => ({ ...newTrack('audio', 'A1'), ...patch })

/** Constant mono PCM of `frames` samples at `value`. */
const constMono = (frames: number, value: number): Float32Array => new Float32Array(frames).fill(value)

const source = (patch: Partial<MixSourcePcm> & Pick<MixSourcePcm, 'channelData'>): MixSourcePcm => ({
  clip: clip(),
  track: track(),
  sampleRate: 48000,
  ...patch,
})

// ---------------------------------------------------------------------------

describe('sampleLinear', () => {
  it('reads exact integer positions', () => {
    const c = new Float32Array([0, 4, 8])
    expect(sampleLinear(c, 0)).toBe(0)
    expect(sampleLinear(c, 1)).toBe(4)
    expect(sampleLinear(c, 2)).toBe(8)
  })

  it('interpolates linearly between samples', () => {
    const c = new Float32Array([0, 4])
    expect(sampleLinear(c, 0.5)).toBeCloseTo(2, 6)
    expect(sampleLinear(c, 0.25)).toBeCloseTo(1, 6)
  })

  it('reads silence past the end (0)', () => {
    const c = new Float32Array([0, 4])
    expect(sampleLinear(c, 2)).toBe(0)
    expect(sampleLinear(c, 1.5)).toBeCloseTo(2, 6) // 4 interpolated toward 0
  })

  it('reads silence before the start (0)', () => {
    const c = new Float32Array([4, 8])
    expect(sampleLinear(c, -1)).toBe(0)
    expect(sampleLinear(c, -0.5)).toBe(0) // both taps out of / at silence
  })
})

describe('linearResampleChannel', () => {
  it('2x source rate consumes the buffer twice as fast (halves output span)', () => {
    const out = linearResampleChannel(new Float32Array([0, 1, 2, 3]), 2, 1, 2)
    expect(Array.from(out)).toEqual([0, 2])
  })

  it('upsampling interpolates and pads the tail with silence', () => {
    const out = linearResampleChannel(new Float32Array([0, 4]), 1, 2, 4)
    expect(Array.from(out)).toEqual([0, 2, 4, 2])
  })

  it('equal rates pass through', () => {
    const out = linearResampleChannel(new Float32Array([0, 1, 2]), 4, 4, 3)
    expect(Array.from(out)).toEqual([0, 1, 2])
  })

  it('zero output frames yields an empty buffer', () => {
    expect(linearResampleChannel(new Float32Array([1, 2]), 1, 1, 0).length).toBe(0)
  })

  it('non-positive destination rate yields silence, not NaN', () => {
    const out = linearResampleChannel(new Float32Array([1, 2]), 1, 0, 3)
    expect(Array.from(out)).toEqual([0, 0, 0])
  })
})

describe('downmixToMono', () => {
  it('passes a mono channel through by reference', () => {
    const mono = new Float32Array([1, 2, 3])
    expect(downmixToMono([mono])).toBe(mono)
  })

  it('folds stereo to 0.5 * (L + R)', () => {
    const out = downmixToMono([new Float32Array([1, 1]), new Float32Array([3, -1])])
    expect(Array.from(out)).toEqual([2, 0])
  })

  it('averages more than two channels', () => {
    const out = downmixToMono([
      new Float32Array([3]),
      new Float32Array([6]),
      new Float32Array([9]),
    ])
    expect(out[0]).toBeCloseTo(6, 6)
  })

  it('empty input yields an empty buffer', () => {
    expect(downmixToMono([]).length).toBe(0)
  })
})

describe('applyGainEnvelope', () => {
  it('ramps linearly across a fade', () => {
    const buffer = constMono(4, 0.5)
    const points: GainPoint[] = [
      { offsetS: 0, value: 0 },
      { offsetS: 1, value: 1 },
    ]
    const out = applyGainEnvelope(buffer, points, 4) // t = 0, .25, .5, .75
    expect(Array.from(out)).toEqual([0, 0.125, 0.25, 0.375])
  })

  it('holds the first value before it and the last value after it', () => {
    const buffer = constMono(4, 1)
    const points: GainPoint[] = [
      { offsetS: 0.25, value: 0.4 },
      { offsetS: 0.5, value: 0.8 },
    ]
    const out = applyGainEnvelope(buffer, points, 4) // t = 0, .25, .5, .75
    expect(out[0]).toBeCloseTo(0.4, 6) // before first point: held
    expect(out[1]).toBeCloseTo(0.4, 6)
    expect(out[2]).toBeCloseTo(0.8, 6)
    expect(out[3]).toBeCloseTo(0.8, 6) // after last point: held
  })

  it('a flat two-point envelope leaves the buffer scaled by the constant', () => {
    const out = applyGainEnvelope(constMono(3, 0.5), [
      { offsetS: 0, value: 1 },
      { offsetS: 10, value: 1 },
    ], 48000)
    expect(Array.from(out)).toEqual([0.5, 0.5, 0.5])
  })

  it('empty envelope is unity gain', () => {
    const out = applyGainEnvelope(constMono(2, 0.5), [], 48000)
    expect(Array.from(out)).toEqual([0.5, 0.5])
  })

  it('does not mutate the input buffer', () => {
    const buffer = constMono(2, 0.5)
    applyGainEnvelope(buffer, [{ offsetS: 0, value: 0 }], 48000)
    expect(Array.from(buffer)).toEqual([0.5, 0.5])
  })
})

describe('equalPowerPan', () => {
  it('center puts equal half-power on both channels', () => {
    const [l, r] = equalPowerPan(1, 0)
    expect(l).toBeCloseTo(HALF_POWER, 6)
    expect(r).toBeCloseTo(HALF_POWER, 6)
    expect(l).toBeCloseTo(r, 12)
  })

  it('scales the sample: 0.5 at center is ~0.354 per channel', () => {
    const [l, r] = equalPowerPan(0.5, 0)
    expect(l).toBeCloseTo(0.5 * HALF_POWER, 6)
    expect(r).toBeCloseTo(0.5 * HALF_POWER, 6)
  })

  it('hard left sends the whole sample to L', () => {
    const [l, r] = equalPowerPan(1, -1)
    expect(l).toBeCloseTo(1, 6)
    expect(r).toBeCloseTo(0, 6)
  })

  it('hard right sends the whole sample to R', () => {
    const [l, r] = equalPowerPan(1, 1)
    expect(l).toBeCloseTo(0, 6)
    expect(r).toBeCloseTo(1, 6)
  })

  it('clamps out-of-range pan', () => {
    expect(equalPowerPan(1, 5)).toEqual(equalPowerPan(1, 1))
    expect(equalPowerPan(1, -5)).toEqual(equalPowerPan(1, -1))
  })

  it('is constant power: l^2 + r^2 == sample^2 at any pan', () => {
    for (const pan of [-1, -0.5, -0.2, 0, 0.3, 0.7, 1]) {
      const [l, r] = equalPowerPan(0.8, pan)
      expect(l * l + r * r).toBeCloseTo(0.64, 6)
    }
  })
})

describe('softLimit', () => {
  it('is the identity below the knee', () => {
    expect(softLimit(0)).toBe(0)
    expect(softLimit(0.5)).toBe(0.5)
    expect(softLimit(-0.5)).toBe(-0.5)
    expect(softLimit(0.8)).toBe(0.8)
    expect(softLimit(-0.8)).toBe(-0.8)
  })

  it('caps a hot sum below the ceiling without exceeding it', () => {
    const y = softLimit(1.6)
    expect(y).toBeLessThan(LIMIT_CEILING)
    // Still delivered loud, right up against the ceiling, rather than squashed
    // back toward the knee. Said in terms of the ceiling itself: the literal
    // that used to be here (0.95) silently encoded the OLD -0.3 dBFS ceiling and
    // broke the day the delivery headroom moved to -1 dBTP, which is a test
    // failing on the one number it was never about.
    expect(y).toBeGreaterThan(LIMIT_KNEE)
    expect(y).toBeCloseTo(LIMIT_CEILING, 4)
  })

  it('is symmetric', () => {
    expect(softLimit(-1.6)).toBeCloseTo(-softLimit(1.6), 12)
  })

  // The ceiling moved off full scale on 2026-08-06. tanh REACHES 1.0 in float64
  // once the input is about 8 dB over the knee, so the old contract of "never
  // exceeds 1" was satisfied by landing exactly ON it, which is the one value a
  // 16-bit encoder has to round and leaves nothing for inter-sample peaks.
  it('never reaches full scale, however hot the input', () => {
    expect(softLimit(1000)).toBeLessThan(1)
    expect(softLimit(1000)).toBeCloseTo(LIMIT_CEILING, 4)
    expect(softLimit(-1000)).toBeGreaterThan(-1)
    expect(Math.abs(softLimit(1e9))).toBeLessThan(1)
  })

  it('is continuous at the knee (no jump)', () => {
    expect(softLimit(0.8001)).toBeCloseTo(0.8, 3)
  })
})

describe('sumAndLimit', () => {
  it('sums buffers below the knee transparently', () => {
    const out = sumAndLimit([constMono(3, 0.3), constMono(3, 0.3)])
    expect(out[0]).toBeCloseTo(0.6, 6)
  })

  it('two 0.8 buffers sum and limit to just under the ceiling', () => {
    const out = sumAndLimit([constMono(2, 0.8), constMono(2, 0.8)])
    expect(out[0]).toBeLessThan(1)
    expect(out[0]).toBeCloseTo(softLimit(1.6), 6)
  })

  it('a single buffer is limited but otherwise unchanged below the knee', () => {
    const out = sumAndLimit([constMono(2, 0.5)])
    expect(Array.from(out)).toEqual([0.5, 0.5])
  })

  it('no buffers yields an empty result', () => {
    expect(sumAndLimit([]).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('mixToStereo', () => {
  const opts = { startS: 0, endS: 1, sampleRate: 48000, soloActive: false }

  it('produces two channels of length ceil((endS - startS) * sampleRate)', () => {
    const [l, r] = mixToStereo([source({ channelData: [constMono(48000, 0.5)] })], opts)
    expect(l.length).toBe(48000)
    expect(r.length).toBe(48000)
  })

  it('a centered mono clip lands at half-power on both channels', () => {
    const [l, r] = mixToStereo([source({ channelData: [constMono(48000, 0.5)] })], opts)
    const expected = 0.5 * HALF_POWER
    expect(l[100]).toBeCloseTo(expected, 5)
    expect(r[100]).toBeCloseTo(expected, 5)
    expect(l[0]).toBeCloseTo(expected, 5)
  })

  it('track pan hard-right silences L and fills R', () => {
    const [l, r] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], track: track({ pan: 1 }) })],
      opts,
    )
    expect(l[100]).toBeCloseTo(0, 6)
    expect(r[100]).toBeCloseTo(0.5, 5)
  })

  it('applies track volumeDb as a scalar gain', () => {
    const [l] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], track: track({ volumeDb: -6 }) })],
      opts,
    )
    expect(l[100]).toBeCloseTo(0.5 * 0.501187 * HALF_POWER, 4)
  })

  it('applies the auto-level makeup gain (medium = +4 dB)', () => {
    const plain = mixToStereo([source({ channelData: [constMono(48000, 0.2)] })], opts)[0][100]
    const levelled = mixToStereo(
      [source({ channelData: [constMono(48000, 0.2)], track: track({ autoLevel: 'medium' }) })],
      opts,
    )[0][100]
    expect(levelled / plain).toBeCloseTo(10 ** (4 / 20), 4) // makeup gain ratio
  })

  it('honors a fade-in envelope from silence', () => {
    const [l] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], clip: clip({ fadeInS: 0.5 }) })],
      opts,
    )
    expect(l[0]).toBeCloseTo(0, 6) // fade starts at silence
    expect(l[12000]).toBeCloseTo(0.5 * 0.5 * HALF_POWER, 4) // halfway up the fade
    expect(l[24000]).toBeCloseTo(0.5 * HALF_POWER, 4) // full gain reached
  })

  it('sums overlapping clips then soft-limits the master', () => {
    const two = [
      source({ channelData: [constMono(48000, 0.8)], clip: clip({ id: 'a' }) }),
      source({ channelData: [constMono(48000, 0.8)], clip: clip({ id: 'b' }) }),
    ]
    const [l] = mixToStereo(two, opts)
    // 0.8 * 0.7071 per clip -> ~1.131 summed -> soft-limited under 1.0.
    expect(l[100]).toBeLessThanOrEqual(1)
    expect(l[100]).toBeCloseTo(softLimit(2 * 0.8 * HALF_POWER), 5)
  })

  it('excludes non-soloed tracks when solo is active', () => {
    const [l, r] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], track: track({ solo: false }) })],
      { ...opts, soloActive: true },
    )
    expect(l[100]).toBe(0)
    expect(r[100]).toBe(0)
  })

  it('includes a soloed track when solo is active', () => {
    const [l] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], track: track({ solo: true }) })],
      { ...opts, soloActive: true },
    )
    expect(l[100]).toBeCloseTo(0.5 * HALF_POWER, 5)
  })

  it('excludes a muted track when no solo is active', () => {
    const [l] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], track: track({ muted: true }) })],
      opts,
    )
    expect(l[100]).toBe(0)
  })

  it('ignores mute while solo is active (solo wins)', () => {
    const [l] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], track: track({ solo: true, muted: true }) })],
      { ...opts, soloActive: true },
    )
    expect(l[100]).toBeCloseTo(0.5 * HALF_POWER, 5)
  })

  it('a linked video clip emits no audio (its partner carries it)', () => {
    const [l] = mixToStereo(
      [
        source({
          channelData: [constMono(48000, 0.5)],
          track: track({ kind: 'video', name: 'V1' }),
          clip: clip({ linkId: 'grp1' }),
        }),
      ],
      opts,
    )
    expect(l[100]).toBe(0)
  })

  it('an unlinked video clip does emit audio', () => {
    const [l] = mixToStereo(
      [
        source({
          channelData: [constMono(48000, 0.5)],
          track: track({ kind: 'video', name: 'V1' }),
          clip: clip(),
        }),
      ],
      opts,
    )
    expect(l[100]).toBeCloseTo(0.5 * HALF_POWER, 5)
  })

  it('skips a clip whose window ends before the render start', () => {
    const [l, r] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.5)], clip: clip({ startS: 0, outS: 1 }) })],
      { ...opts, startS: 2, endS: 3 },
    )
    expect(l.every((v) => v === 0)).toBe(true)
    expect(r.every((v) => v === 0)).toBe(true)
  })

  it('clamps a clip that overruns the range without writing past the buffer', () => {
    // clip is 10 s but the render range is only 1 s.
    const [l] = mixToStereo(
      [source({ channelData: [constMono(480000, 0.5)], clip: clip({ outS: 10 }) })],
      opts,
    )
    expect(l.length).toBe(48000)
    expect(l[47999]).toBeCloseTo(0.5 * HALF_POWER, 5)
  })

  it('resamples a speed-2 clip by reading every other source sample', () => {
    // src at 4 Hz, output at 4 Hz, speed 2 -> step 2 through the source.
    const mono = new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) // 2 s of source
    const [l] = mixToStereo(
      [
        source({
          channelData: [mono],
          sampleRate: 4,
          clip: clip({ inS: 0, outS: 2, speed: 2 }),
          track: track(),
        }),
      ],
      { startS: 0, endS: 1, sampleRate: 4, soloActive: false },
    )
    // reads source[0,2,4,6] = [0,0.2,0.4,0.6], centered pan.
    expect(l.length).toBe(4)
    expect(l[0]).toBeCloseTo(0, 6)
    expect(l[1]).toBeCloseTo(0.2 * HALF_POWER, 5)
    expect(l[2]).toBeCloseTo(0.4 * HALF_POWER, 5)
    expect(l[3]).toBeCloseTo(0.6 * HALF_POWER, 5)
  })

  it('resamples a half-speed clip by interpolating between source samples', () => {
    // src at 4 Hz, output at 4 Hz, speed 0.5 -> step 0.5, window is stretched 2x.
    const mono = new Float32Array([0, 0.4, 0.8, 0.6]) // 1 s of source
    const [l] = mixToStereo(
      [
        source({
          channelData: [mono],
          sampleRate: 4,
          clip: clip({ inS: 0, outS: 1, speed: 0.5 }),
        }),
      ],
      { startS: 0, endS: 2, sampleRate: 4, soloActive: false },
    )
    // source positions 0,.5,1,1.5,2,2.5,3,3.5 -> interpolated:
    const expected = [0, 0.2, 0.4, 0.6, 0.8, 0.7, 0.6, 0.3]
    expect(l.length).toBe(8)
    expected.forEach((e, i) => expect(l[i]).toBeCloseTo(e * HALF_POWER, 5))
  })

  it('downmixes a stereo source before panning', () => {
    const [l, r] = mixToStereo(
      [source({ channelData: [constMono(48000, 0.6), constMono(48000, 0.2)] })],
      opts,
    )
    // mono = 0.5 * (0.6 + 0.2) = 0.4, centered.
    expect(l[100]).toBeCloseTo(0.4 * HALF_POWER, 5)
    expect(r[100]).toBeCloseTo(0.4 * HALF_POWER, 5)
  })

  it('returns empty channels for a non-positive range', () => {
    const [l, r] = mixToStereo([source({ channelData: [constMono(48000, 0.5)] })], {
      ...opts,
      endS: 0,
    })
    expect(l.length).toBe(0)
    expect(r.length).toBe(0)
  })

  it('is deterministic: identical inputs give byte-identical output', () => {
    const build = () => [
      source({ channelData: [constMono(48000, 0.5)], clip: clip({ id: 'a', fadeInS: 0.3 }) }),
      source({ channelData: [constMono(48000, 0.3)], clip: clip({ id: 'b', startS: 0.5, outS: 1 }) }),
    ]
    const a = mixToStereo(build(), opts)
    const b = mixToStereo(build(), opts)
    expect(a[0]).toEqual(b[0])
    expect(a[1]).toEqual(b[1])
  })

  it('an empty source list is pure silence', () => {
    const [l, r] = mixToStereo([], opts)
    expect(l.every((v) => v === 0)).toBe(true)
    expect(r.every((v) => v === 0)).toBe(true)
  })
})
