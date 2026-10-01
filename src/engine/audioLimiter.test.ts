// The master limiter, the last thing between his mix and the file.
//
// The backtest of 2026-09-29 measured the old one, a tanh soft clipper on a
// WaveShaperNode, in the real export: 2.6% distortion on a 1 kHz tone at
// -0.5 dBFS, 25% at +5.5 dBFS, a sample peak 0.08 dB over its own ceiling, and a
// 128 sample (2.67 ms) delay on the whole mix from its oversampling. Each test
// below pins one of those shut, and the first pins what must never change: below
// the ceiling, his mix comes out bit for bit.

import { describe, expect, it } from 'vitest'
import {
  DELIVERY_CEILING_DBTP,
  LIMIT_CEILING,
  LIMIT_CEILING_DBTP,
  limiterLatencyFrames,
  TruePeakLimiter,
} from './audioLimiter'

const SR = 48000

/** Run whole signals through, dropping the latency, the way the export does. */
function limit(chs: Float32Array[], block = 128): Float32Array[] {
  const lim = new TruePeakLimiter(chs.length, SR)
  const n = chs[0].length
  const total = n + lim.latency
  const out = chs.map(() => new Float32Array(total))
  for (let a = 0; a < total; a += block) {
    const len = Math.min(block, total - a)
    const inp = chs.map((c) => {
      const piece = new Float32Array(len)
      if (a < n) piece.set(c.subarray(a, Math.min(n, a + len)))
      return piece
    })
    lim.process(
      inp,
      out.map((o) => o.subarray(a, a + len)),
      len,
    )
  }
  return out.map((o) => o.subarray(lim.latency, lim.latency + n))
}

const tone = (amp: number, hz: number, seconds: number, phase = 0): Float32Array =>
  Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR + phase))

/** Amplitude of one frequency, exactly (a correlation, not an FFT bin). */
function amplitudeAt(x: Float32Array, hz: number, from: number, len: number): number {
  let re = 0
  let im = 0
  let ws = 0
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1))
    const ph = (2 * Math.PI * hz * i) / SR
    re += x[from + i] * w * Math.cos(ph)
    im -= x[from + i] * w * Math.sin(ph)
    ws += w
  }
  return (2 * Math.hypot(re, im)) / ws
}

/** True peak by a long ideal interpolation at 16 points per sample: stricter than any 4x meter. */
const TP_H = 48
const TP_KERNELS = Array.from({ length: 15 }, (_, i) => {
  const frac = (i + 1) / 16
  return Float64Array.from({ length: 2 * TP_H }, (_, k) => {
    const t = k - TP_H + 1 - frac
    return (Math.sin(Math.PI * t) / (Math.PI * t)) * (0.5 + 0.5 * Math.cos((Math.PI * t) / TP_H))
  })
})
function truePeak(x: Float32Array, from: number, to: number): number {
  let peak = 0
  for (let n = from; n < to; n++) {
    peak = Math.max(peak, Math.abs(x[n]))
    for (const kernel of TP_KERNELS) {
      let acc = 0
      for (let k = 0; k < kernel.length; k++) acc += (x[n - TP_H + 1 + k] ?? 0) * kernel[k]
      peak = Math.max(peak, Math.abs(acc))
    }
  }
  return peak
}

const dB = (v: number): number => 20 * Math.log10(v)

describe('TruePeakLimiter', () => {
  it('leaves a mix below the ceiling exactly alone, bit for bit', () => {
    // The promise "Off keeps your mix as it is" rests on this. Busy material
    // peaking 2.6 dB under the ceiling, through block sizes that do not divide it.
    const x = tone(0.5, 440, 1)
    for (let i = 0; i < x.length; i++) x[i] += 0.12 * Math.sin(i * 0.37) * Math.sin(i * 0.0011)
    for (const block of [128, 500, 4800]) {
      const [y] = limit([x], block)
      let changed = 0
      for (let i = 0; i < x.length; i++) if (y[i] !== x[i]) changed++
      expect(changed, `block ${block}`).toBe(0)
    }
  })

  it('reports a delay of a few hundred microseconds, and the export takes all of it back', () => {
    // 2.67 ms of the iPhone tester's 46.67 was the old clipper's oversampling.
    // This limiter's look-ahead is a real delay too, but a KNOWN one, and the
    // callers remove it, so what matters is that the number is honest.
    const lim = new TruePeakLimiter(2, SR)
    expect(lim.latency).toBe(limiterLatencyFrames(SR))
    const click = new Float32Array(SR / 10)
    click[2000] = 0.5
    const [y] = limit([click])
    expect(y[2000]).toBe(0.5)
    expect(y.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)).toBe(1)
  })

  it('adds no distortion to an over-driven tone, where the old clipper added up to 25%', () => {
    for (const overDb of [-0.5, 0, 3.5, 5.5, 12]) {
      const x = tone(10 ** (overDb / 20), 1000, 1)
      const [y] = limit([x, x])
      const from = 12000
      const len = 16384
      const fund = amplitudeAt(y, 1000, from, len)
      let harmonics = 0
      for (let k = 2; k <= 15; k++) harmonics += amplitudeAt(y, 1000 * k, from, len) ** 2
      const thd = Math.sqrt(harmonics) / fund
      expect(thd, `${overDb} dBFS in`).toBeLessThan(1e-4) // 0.01%, against 2.6 to 25% before
      // and the tone is simply quieter, sitting on the ceiling
      expect(dB(fund), `${overDb} dBFS in`).toBeCloseTo(LIMIT_CEILING_DBTP, 1)
    }
  })

  it('holds the TRUE peak, between the samples, under the ceiling', () => {
    // A 4x meter (BS.1770) reads between samples; so do the platforms. High
    // tones are where a sample peak lies most about the waveform.
    for (const hz of [100, 1000, 5000, 10000, 15000, 18000]) {
      for (const phase of [0, 0.7, 1.3]) {
        const x = tone(1.6, hz, 0.25, phase)
        const [y] = limit([x, x])
        expect(dB(truePeak(y, 2000, 6000)), `${hz} Hz`).toBeLessThanOrEqual(LIMIT_CEILING_DBTP + 0.02)
      }
    }
  })

  it('stays under the delivery ceiling on bursts that arrive with no warning', () => {
    // A tone switched on mid-cycle every 100 ms over a quiet bed: the hardest
    // thing for a limiter that must already be down when the peak lands.
    const x = new Float32Array(SR / 2)
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 3000 * i) / SR) * (i % 4800 < 400 ? 1.4 : 0.2)
    const [y] = limit([x, x])
    expect(dB(truePeak(y, 1000, 20000))).toBeLessThanOrEqual(DELIVERY_CEILING_DBTP)
  })

  it('limits both channels together, so the stereo image does not move', () => {
    // A peak on the left must turn the right down by the same amount, or a loud
    // hit would swing the whole mix sideways for an instant.
    const left = tone(1.5, 500, 0.5)
    const right = tone(0.3, 700, 0.5)
    const [, r] = limit([left, right])
    const ratio = amplitudeAt(r, 700, 6000, 8192) / 0.3
    expect(dB(ratio)).toBeCloseTo(LIMIT_CEILING_DBTP - dB(1.5), 1)
  })

  it('gives the gain back after the peak, smoothly, and then exactly', () => {
    // One loud hit, then quiet speech-level material: the gain recovers on the
    // release and lands exactly on 1 again, so the rest of the mix is untouched.
    const x = tone(0.3, 300, 2)
    for (let i = 4800; i < 5200; i++) x[i] = 1.5 * Math.sin((2 * Math.PI * 300 * i) / SR)
    const [y] = limit([x])
    // a second later the gain is fully back
    let changed = 0
    for (let i = 1.2 * SR; i < 2 * SR; i++) if (y[i] !== x[i]) changed++
    expect(changed).toBe(0)
    // and the recovery has no step: no sample-to-sample gain jump over 0.5 dB
    let worst = 0
    for (let i = 5300; i < 20000; i++) {
      if (Math.abs(x[i]) < 0.05 || Math.abs(x[i - 1]) < 0.05) continue
      worst = Math.max(worst, Math.abs(dB(Math.abs(y[i] / x[i])) - dB(Math.abs(y[i - 1] / x[i - 1]))))
    }
    expect(worst).toBeLessThan(0.05)
  })

  it('reads a missing channel as silence instead of throwing', () => {
    const lim = new TruePeakLimiter(2, SR)
    const out = [new Float32Array(256), new Float32Array(256)]
    expect(() => lim.process([], out, 256)).not.toThrow()
    expect(out[0].every((v) => v === 0)).toBe(true)
  })

  it('aims under -1 dBTP by the measured AAC overshoot, so the FILE meets it', () => {
    // His mixes limited at exactly -1.0 came back from the encoder at -0.9.
    expect(DELIVERY_CEILING_DBTP).toBe(-1)
    expect(LIMIT_CEILING_DBTP).toBeLessThan(DELIVERY_CEILING_DBTP)
    expect(LIMIT_CEILING).toBeCloseTo(10 ** (LIMIT_CEILING_DBTP / 20), 12)
  })
})
