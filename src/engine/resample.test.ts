import { describe, expect, it } from 'vitest'

import { resamplePlane, resamplePlanes, StreamResampler } from './resample'

// One resampler for the whole app. It turns every 44.1 kHz source (his mp3 music
// and sound effects, his YouTube downloads) into the 48 kHz the mix runs at, once,
// at the read; and it takes a 44.1 kHz voice take through RNNoise, a 48 kHz
// model, and back, to be crossfaded against its own dry samples (MIC-6). Both
// need the same two things, no delay and no colour, so those are pinned here in
// numbers. His words, 2026-09-29: *"I want the quality to be absolutely the
// highest, audio and video."*

const tone = (f: number, rate: number, n: number, amp = 0.5) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate))

/** RMS of a - b over [from, to), in dB relative to the RMS of b. */
function errorDb(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let e = 0
  let s = 0
  for (let i = from; i < to; i++) {
    e += (a[i]! - b[i]!) ** 2
    s += b[i]! ** 2
  }
  return 10 * Math.log10(e / s)
}

/** Amplitude of frequency f in x (a single-bin DFT with a Hann window). */
function amplitudeAt(x: Float32Array, f: number, rate: number, from: number, n: number): number {
  let re = 0
  let im = 0
  let w = 0
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    re += x[from + i]! * h * Math.cos((2 * Math.PI * f * i) / rate)
    im -= x[from + i]! * h * Math.sin((2 * Math.PI * f * i) / rate)
    w += h
  }
  return (2 * Math.hypot(re, im)) / w
}

const db = (x: number): number => 20 * Math.log10(x)

/** Where two planes first differ, or -1: equal means EQUAL here, every bit. */
function firstDifference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i
  return -1
}

describe('resamplePlane', () => {
  it('equal rates hand back a plain copy', () => {
    const x = Float32Array.from([0.1, -0.2, 0.3])
    const y = resamplePlane(x, 48_000, 48_000)
    expect(Array.from(y)).toEqual(Array.from(x))
    expect(y).not.toBe(x)
  })

  it('keeps the length at the new rate, or exactly the length it is asked for', () => {
    expect(resamplePlane(new Float32Array(44_100), 44_100, 48_000).length).toBe(48_000)
    expect(resamplePlane(new Float32Array(48_000), 48_000, 44_100, 44_101).length).toBe(44_101)
  })

  it('passes DC at unity: a level never moves', () => {
    const y = resamplePlane(new Float32Array(4410).fill(0.5), 44_100, 48_000)
    for (let i = 200; i < y.length - 200; i++) expect(y[i]).toBeCloseTo(0.5, 5)
  })

  it('44.1 to 48 kHz lands on the true 48 kHz waveform: no delay, no colour', () => {
    // Compared against the SAME tone generated at 48 kHz, so any delay or level
    // change would show as error. Interior only: the ends have no neighbours.
    for (const f of [100, 1000, 5000, 15_000]) {
      const y = resamplePlane(tone(f, 44_100, 44_100), 44_100, 48_000)
      const truth = tone(f, 48_000, 48_000)
      expect(errorDb(y, truth, 2000, 46_000)).toBeLessThan(-70)
    }
  })

  it('a round trip 44.1 to 48 to 44.1 kHz is the input again, sample for sample', () => {
    // A voice band mix of tones, like the take RNNoise would see.
    const x = new Float32Array(44_100)
    for (const [f, a] of [
      [140, 0.3],
      [700, 0.2],
      [2500, 0.1],
      [9000, 0.03],
    ] as const) {
      const t = tone(f, 44_100, 44_100, a)
      for (let i = 0; i < x.length; i++) x[i]! += t[i]!
    }
    const back = resamplePlane(resamplePlane(x, 44_100, 48_000), 48_000, 44_100, x.length)
    expect(back.length).toBe(x.length)
    expect(errorDb(back, x, 2000, 42_000)).toBeLessThan(-70)
  })

  it('is flat to 15 kHz, where linear interpolation (the Web Audio way) lost 3.4 dB', () => {
    const y = resamplePlane(tone(15_000, 44_100, 44_100), 44_100, 48_000)
    const level = db(amplitudeAt(y, 15_000, 48_000, 8000, 16_384) / 0.5)
    expect(Math.abs(level)).toBeLessThan(0.05)
  })

  it('going down, what the lower rate cannot hold is removed, not folded back in', () => {
    // 23 kHz is legal at 48 kHz and impossible at 44.1 kHz. Left in, it would
    // alias to 21.1 kHz.
    const y = resamplePlane(tone(23_000, 48_000, 48_000), 48_000, 44_100)
    let s = 0
    for (let i = 2000; i < y.length - 2000; i++) s += y[i]! ** 2
    const rmsDb = 10 * Math.log10(s / (y.length - 4000)) - 10 * Math.log10(0.125)
    expect(rmsDb).toBeLessThan(-80)
  })
})

describe('the 44.1 to 48 kHz conversion every mp3 goes through', () => {
  // The backtest's numbers for the linear interpolation this replaces: 10 kHz
  // -1.49 dB, 15 kHz -3.44 dB, 19 kHz -5.67 dB; a 5 kHz tone threw an alias at
  // 8.9 kHz only 35.8 dB down, a 15 kHz tone one at 18.9 kHz only 11.6 dB down.
  const ys = new Map<number, Float32Array>()
  const at48 = (f: number): Float32Array => {
    let y = ys.get(f)
    if (!y) ys.set(f, (y = resamplePlane(tone(f, 44_100, 44_100), 44_100, 48_000)))
    return y
  }
  const TONES = [1000, 5000, 10_000, 15_000, 17_000, 19_000]

  it('is flat to 19 kHz within 0.001 dB, and within 0.1 dB at 20 kHz', () => {
    for (const f of TONES) expect(Math.abs(db(amplitudeAt(at48(f), f, 48_000, 12_000, 16_384) / 0.5))).toBeLessThan(0.001)
    expect(Math.abs(db(amplitudeAt(at48(20_000), 20_000, 48_000, 12_000, 16_384) / 0.5))).toBeLessThan(0.1)
  })

  it('every image of the tone stays at or below -108 dBc', () => {
    // A tone f at 44.1 kHz has images at 44.1 kHz - f and 44.1 kHz + f, and at
    // 48 kHz those fold to where the backtest heard them (5 kHz made 8.9 kHz).
    const fold = (hz: number): number => {
      const m = ((hz % 48_000) + 48_000) % 48_000
      return m > 24_000 ? 48_000 - m : m
    }
    for (const f of [...TONES, 20_000]) {
      const y = at48(f)
      const fund = amplitudeAt(y, f, 48_000, 12_000, 16_384)
      for (const image of [fold(44_100 - f), fold(44_100 + f), fold(88_200 - f)]) {
        if (Math.abs(image - f) < 50) continue
        expect(db(amplitudeAt(y, image, 48_000, 12_000, 16_384) / fund)).toBeLessThan(-108)
      }
    }
  })

  it('an odd rate, drawn from an interpolated table, is as clean', () => {
    // No file really carries 44.056 kHz, but a device can. 6000 phases are
    // interpolated from 1024, and the result is still flat and alias free.
    for (const f of [1000, 10_000, 19_000]) {
      const y = resamplePlane(tone(f, 44_056, 44_056), 44_056, 48_000)
      const truth = tone(f, 48_000, 48_000)
      expect(errorDb(y, truth, 2000, 46_000)).toBeLessThan(-95)
    }
  })
})

describe('StreamResampler: a piece at a time, on the whole file axis', () => {
  const N = 44_100 * 3
  const input = [tone(440, 44_100, N), tone(9000, 44_100, N, 0.3)]
  for (let i = 0; i < N; i += 997) input[0]![i] = 0.9 // clicks, so a misplaced piece shows
  const copier = (start: number) => (ch: number, dest: Float32Array, off: number, count: number) =>
    dest.set(input[ch]!.subarray(start + off, start + off + count))

  it('fed in odd sized pieces it gives exactly what it gives fed whole', () => {
    const whole = resamplePlanes(input, 44_100, 48_000)
    const rs = new StreamResampler(44_100, 48_000, 2, { inEnd: N, outStart: 0, outEnd: 144_000 })
    for (let at = 0, k = 0; at < N; k++) {
      const n = [1152, 1024, 37, 4096, 50_000, 960][k % 6]!
      rs.write(at, Math.min(n, N - at), copier(at))
      at += n
    }
    const pieces = rs.finish()
    for (let ch = 0; ch < 2; ch++) expect(firstDifference(pieces[ch]!, whole[ch]!)).toBe(-1)
  })

  it('a range is the whole read cut shorter, not an approximation of it', () => {
    const whole = resamplePlanes(input, 44_100, 48_000)
    const outStart = 70_001
    const outEnd = 100_000
    const rs = new StreamResampler(44_100, 48_000, 2, { inEnd: N, outStart, outEnd })
    // It asks for exactly the input its outputs read, and stops when it has it.
    const from = rs.inStart
    expect(rs.write(from, rs.inStop - from + 5000, copier(from))).toBe(false)
    const range = rs.finish()
    for (let ch = 0; ch < 2; ch++) expect(firstDifference(range[ch]!, whole[ch]!.subarray(outStart, outEnd))).toBe(-1)
  })

  it('a gap in the input is silence, and nothing before input 0 is ever read', () => {
    const rs = new StreamResampler(44_100, 48_000, 1, { inEnd: 44_100, outStart: 0, outEnd: 48_000 })
    // A packet that starts before zero, like an AAC track's priming: its first
    // 100 frames must vanish.
    rs.write(-100, 200, (_ch, dest, off, count) => dest.fill(off < 100 ? 1 : 0, 0, count))
    // Then nothing until frame 22050, a tone burst there.
    rs.write(22_050, 100, (_ch, dest, _off, count) => dest.fill(0.5, 0, count))
    const y = rs.finish()[0]!
    expect(Math.max(...y.subarray(0, 23_000).map(Math.abs))).toBeLessThan(1e-6)
    expect(y[24_050]).toBeCloseTo(0.5, 2)
  })

  it('the WebAssembly sums and the plain JS sums agree', () => {
    // The fast path runs four lanes in float32; where WebAssembly SIMD is
    // missing the JS path runs in doubles. They differ by rounding, nothing else.
    const run = (simd: boolean) => {
      const rs = new StreamResampler(44_100, 48_000, 2, { inEnd: N, outStart: 0, outEnd: 144_000 }, { simd })
      rs.write(0, N, copier(0))
      return rs.finish()
    }
    const a = run(true)
    const b = run(false)
    let worst = 0
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < a[ch]!.length; i++) worst = Math.max(worst, Math.abs(a[ch]![i]! - b[ch]![i]!))
    expect(worst).toBeLessThan(2e-6)
  })

  it('a mono and a five channel file come through too', () => {
    const one = resamplePlanes([input[0]!], 44_100, 48_000)
    const five = resamplePlanes([input[0]!, input[1]!, input[0]!, input[1]!, input[0]!], 44_100, 48_000)
    const two = resamplePlanes(input, 44_100, 48_000)
    expect(firstDifference(one[0]!, two[0]!)).toBe(-1)
    for (const ch of [0, 2, 4]) expect(firstDifference(five[ch]!, two[0]!)).toBe(-1)
    for (const ch of [1, 3]) expect(firstDifference(five[ch]!, two[1]!)).toBe(-1)
  })
})
