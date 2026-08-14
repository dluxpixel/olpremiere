// The whole point of this module is a negative: speeding a clip up must NOT
// raise his voice. So the pitch tests below assert the frequency stayed put AND
// that it is nowhere near where a plain resample would have put it. Swap
// timeStretchChannels for a resample and every one of them goes red.

import { describe, expect, it } from 'vitest'
import { timeStretchChannels } from './timeStretch'

const SR = 48000

function sine(freq: number, frames: number, phase = 0): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = Math.sin(2 * Math.PI * freq * (i / SR) + phase)
  return out
}

/**
 * Dominant frequency by counting rising zero crossings over the steady middle
 * of the signal, away from both edges. Good to a few Hz on a clean tone, which
 * is far tighter than the octave these tests are separating.
 */
function dominantHz(buf: Float32Array): number {
  const a = Math.floor(buf.length * 0.2)
  const b = Math.floor(buf.length * 0.8)
  let crossings = 0
  for (let i = a + 1; i < b; i++) {
    if (buf[i - 1] <= 0 && buf[i] > 0) crossings++
  }
  return (crossings * SR) / (b - a)
}

/** Biggest jump between neighbouring samples: a bad join shows up here. */
function maxStep(buf: Float32Array): number {
  let m = 0
  for (let i = 1; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] - buf[i - 1]))
  return m
}

describe('timeStretchChannels', () => {
  it('gives back exactly the number of frames asked for, at any speed', () => {
    const input = [sine(440, SR)]
    for (const outFrames of [SR / 4, SR / 2, 12345, SR - 1, SR + 1, SR * 2, 999]) {
      const [out] = timeStretchChannels(input, outFrames, SR)
      expect(out.length).toBe(Math.round(outFrames))
    }
  })

  it('hands the input straight back when nothing has to change', () => {
    const input = [sine(440, SR), sine(440, SR)]
    const out = timeStretchChannels(input, SR, SR)
    expect(out[0]).toBe(input[0])
    expect(out[1]).toBe(input[1])
  })

  it('keeps his voice where it was at double speed, instead of an octave up', () => {
    const [out] = timeStretchChannels([sine(440, SR)], SR / 2, SR)
    // A resample to half the length is what playbackRate = 2 does, and it
    // lands on 880. This must not.
    expect(dominantHz(out)).toBeGreaterThan(415)
    expect(dominantHz(out)).toBeLessThan(465)
    expect(dominantHz(out)).toBeLessThan(700)
  })

  it('keeps the pitch when a clip is SLOWED down too', () => {
    const [out] = timeStretchChannels([sine(440, SR)], SR * 2, SR)
    // A resample to twice the length drops it to 220.
    expect(dominantHz(out)).toBeGreaterThan(415)
    expect(dominantHz(out)).toBeLessThan(465)
  })

  it('holds the pitch across the speeds he actually uses', () => {
    for (const speed of [0.5, 0.75, 1.5, 2, 3, 4]) {
      const [out] = timeStretchChannels([sine(300, SR)], Math.round(SR / speed), SR)
      const hz = dominantHz(out)
      expect(Math.abs(hz - 300)).toBeLessThan(30)
    }
  })

  it('joins without clicking: no jump a clean tone could not make on its own', () => {
    const input = sine(220, SR)
    const [out] = timeStretchChannels([input], SR / 2, SR)
    // A blind overlap-add that ignores waveform similarity lands joins at
    // random phase and leaves steps close to the full peak-to-peak 2.0.
    expect(maxStep(out)).toBeLessThan(4 * maxStep(input))
  })

  it('reads every channel from the SAME place, so a stereo image cannot smear', () => {
    // Both channels carry their own source index in the open. Left is a ramp,
    // so a sample says outright which input frame it came from. Right is a
    // sawtooth of period P, so it says the same thing modulo P. If the two
    // channels ever hunted for their joins separately they would land on
    // different input frames and the two readings would stop agreeing.
    const P = 97
    const left = new Float32Array(SR)
    const right = new Float32Array(SR)
    for (let i = 0; i < SR; i++) {
      left[i] = i / SR
      right[i] = (i % P) / P
    }

    const [outL, outR] = timeStretchChannels([left, right], SR / 2, SR)

    // Only the flat middle of each block can be read: a join cross-fades two
    // positions together and the blend is not a sample of either.
    // The tolerance is a tenth of a step, not a millionth: these are 32-bit
    // samples and the ramp's own rounding is bigger than that.
    const stepIfFlat = 1 / SR
    let checked = 0
    for (let n = 1; n < outL.length - 1; n++) {
      const flat =
        Math.abs(outL[n] - outL[n - 1] - stepIfFlat) < stepIfFlat * 0.1 &&
        Math.abs(outL[n + 1] - outL[n] - stepIfFlat) < stepIfFlat * 0.1
      if (!flat) continue
      const srcIndex = Math.round(outL[n] * SR)
      expect(outR[n]).toBeCloseTo((srcIndex % P) / P, 5)
      checked++
    }
    // The reading itself has to be worth something.
    expect(checked).toBeGreaterThan(SR / 4)
  })

  it('survives silence, one sample, and an empty clip without throwing', () => {
    expect(timeStretchChannels([], 100, SR)).toEqual([])
    expect(timeStretchChannels([new Float32Array(0)], 100, SR)[0].length).toBe(100)
    expect(timeStretchChannels([new Float32Array(1)], 100, SR)[0].length).toBe(100)
    const [quiet] = timeStretchChannels([new Float32Array(SR)], SR / 2, SR)
    expect(quiet.every((v) => v === 0)).toBe(true)
  })

  it('does not blow up the level: a stretched tone stays inside its own peak', () => {
    const [out] = timeStretchChannels([sine(440, SR)], Math.round(SR / 1.5), SR)
    let peak = 0
    for (const v of out) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(1.02)
  })
})

// Speeding a clip up has to throw half of it away, and the version that shipped
// as v0.1.76 threw away half his GUNSHOTS with it: measured 52% surviving at 2x
// where the old pitch-moving code kept every one. These pin the repair.
describe('timeStretchChannels keeps the hits', () => {
  /** A noise bed with impacts on top: the shape of gameplay audio. */
  const gameplay = (frames: number, perSec: number, seed0: number): Float32Array => {
    const out = new Float32Array(frames)
    let seed = seed0
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
    for (let i = 0; i < frames; i++) out[i] = 0.08 * rnd()
    const period = Math.round(SR / perSec)
    for (let k = 0; k * period < frames; k++) {
      // Jittered off the grid, so no result can come from rhyming with the hop.
      const at = Math.round(k * period + (rnd() * period) / 6)
      for (let i = 0; i < 800 && at + i < frames; i++) {
        if (at + i >= 0) out[at + i] += Math.exp(-i / 120) * 0.9 * Math.sin(2 * Math.PI * 180 * (i / SR))
      }
    }
    return out
  }

  /** Count impacts: one per event, re-arming only after a real gap of quiet. */
  const countHits = (buf: Float32Array, threshold: number): number => {
    let n = 0
    let quiet = Infinity
    for (let i = 0; i < buf.length; i++) {
      if (Math.abs(buf[i]) > threshold) {
        if (quiet > SR / 60) n++
        quiet = 0
      } else quiet++
    }
    return n
  }

  /** Mean survival over several signals: one clip's worth of hits is noise. */
  const survival = (speed: number, level = 1): number => {
    let total = 0
    let cases = 0
    for (const seed of [12345, 777, 90210]) {
      for (const rate of [2, 4, 8]) {
        const input = gameplay(SR * 4, rate, seed)
        if (level !== 1) for (let i = 0; i < input.length; i++) input[i] *= level
        const before = countHits(input, 0.25 * level)
        const [out] = timeStretchChannels([input], Math.round((SR * 4) / speed), SR)
        total += countHits(out, 0.25 * level) / before
        cases++
      }
    }
    return total / cases
  }

  it('keeps nearly every impact when he speeds gameplay up', () => {
    // Without the onset step these measure 0.65, 0.52 and 0.39.
    expect(survival(1.5)).toBeGreaterThan(0.9)
    expect(survival(2)).toBeGreaterThan(0.9)
    expect(survival(3)).toBeGreaterThan(0.9)
  })

  it('keeps them on a QUIET recording too, which an absolute threshold would not', () => {
    // The first detector used a fixed energy floor and silently did nothing
    // here, handing back the unfixed 0.52 while looking healthy.
    expect(survival(2, 0.05)).toBeGreaterThan(0.9)
  })

  it('never invents impacts that were not there', () => {
    for (const speed of [1.5, 2, 3]) expect(survival(speed)).toBeLessThan(1.1)
  })
})
