// The limiter became load-bearing when clip levelling stopped refusing gain.
// Two things must hold: it is INVISIBLE below the knee (so no existing export
// moves), and nothing that goes through it can reach full scale.

import { describe, expect, it } from 'vitest'
import { LIMIT_CEILING, LIMIT_KNEE, softLimit, softLimitCurve } from './audioLimiter'

describe('softLimit', () => {
  it('is exactly identity below the knee, so a normal mix is untouched', () => {
    for (const x of [0, 0.1, -0.25, 0.5, -0.79, LIMIT_KNEE, -LIMIT_KNEE]) {
      expect(softLimit(x)).toBe(x)
    }
  })

  it('never reaches full scale, however hot the input', () => {
    for (const x of [1, 2, 4, 100, 1e6, 1e12]) {
      expect(Math.abs(softLimit(x))).toBeLessThan(1)
      expect(Math.abs(softLimit(-x))).toBeLessThan(1)
    }
  })

  it('asymptotes to the ceiling, which is below full scale', () => {
    expect(softLimit(1e6)).toBeCloseTo(LIMIT_CEILING, 6)
    expect(LIMIT_CEILING).toBeLessThan(1)
  })

  it('holds the -1 dBTP delivery headroom, not just "under full scale"', () => {
    // A lossy re-encode reconstructs a waveform that overshoots its own samples,
    // so a file peaking at -0.3 dBFS goes over 0 dBTP once YouTube re-encodes it.
    // -1 dB is the delivery standard, and this is the number every path reads.
    expect(20 * Math.log10(LIMIT_CEILING)).toBeCloseTo(-1, 3)
  })

  it('is monotonic: a louder sample never comes out quieter', () => {
    let prev = -Infinity
    for (let x = 0; x <= 6; x += 0.01) {
      const y = softLimit(x)
      expect(y).toBeGreaterThanOrEqual(prev)
      prev = y
    }
  })

  it('has no corner at the knee (slope 1 on both sides)', () => {
    const h = 1e-6
    const below = (softLimit(LIMIT_KNEE) - softLimit(LIMIT_KNEE - h)) / h
    const above = (softLimit(LIMIT_KNEE + h) - softLimit(LIMIT_KNEE)) / h
    expect(below).toBeCloseTo(1, 4)
    expect(above).toBeCloseTo(1, 4)
  })

  it('is symmetric', () => {
    for (const x of [0.9, 1.5, 3, 50]) expect(softLimit(-x)).toBeCloseTo(-softLimit(x), 12)
  })
})

describe('softLimitCurve', () => {
  const curve = softLimitCurve()
  const SHAPER_RANGE = 4

  it('reproduces softLimit across the whole shaper window', () => {
    // A WaveShaper reads the curve with linear interpolation, so check the
    // interpolated value, not just the knots.
    for (let x = -SHAPER_RANGE; x <= SHAPER_RANGE; x += 0.013) {
      const t = (x / SHAPER_RANGE + 1) / 2 // 0..1
      const pos = t * (curve.length - 1)
      const i = Math.min(curve.length - 2, Math.floor(pos))
      const frac = pos - i
      const interpolated = curve[i] * (1 - frac) + curve[i + 1] * frac
      expect(interpolated).toBeCloseTo(softLimit(x), 5)
    }
  })

  it('never contains a value at or past full scale', () => {
    for (const v of curve) expect(Math.abs(v)).toBeLessThan(1)
  })

  it('tops out at the SAME ceiling as the pure path, so preview cannot drift from export', () => {
    // The preview graph and the OfflineAudioContext export render both go through
    // this curve, while the worker mixer calls softLimit directly. One ceiling for
    // all three is the whole point of this module: what he hears is what ships.
    let peak = 0
    for (const v of curve) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeCloseTo(LIMIT_CEILING, 6)
    expect(20 * Math.log10(peak)).toBeCloseTo(-1, 3)
  })

  it('passes small signals through untouched, which is what keeps old exports identical', () => {
    for (const x of [0, 0.2, -0.4, 0.6]) {
      const t = (x / SHAPER_RANGE + 1) / 2
      const pos = t * (curve.length - 1)
      const i = Math.min(curve.length - 2, Math.floor(pos))
      const frac = pos - i
      expect(curve[i] * (1 - frac) + curve[i + 1] * frac).toBeCloseTo(x, 5)
    }
  })
})
