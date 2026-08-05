// The one thing this has to get right: a shout and a quiet sentence that share
// a PEAK must not be reported as equally loud. That is the exact failure he hit
// with the old peak-based normalize.

import { describe, expect, it } from 'vitest'
import { gainForTarget, measureLoudness, TARGET_LUFS } from './loudness'

const SR = 48000

/** A steady tone at `amp`, `seconds` long. Sustained energy, so a fair loudness subject. */
function tone(amp: number, seconds: number, freq = 1000, sr = SR): Float32Array {
  const n = Math.floor(seconds * sr)
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return a
}

describe('measureLoudness', () => {
  it('reports a louder signal as louder, in the right direction', () => {
    const quiet = measureLoudness([tone(0.05, 3)], SR)
    const loud = measureLoudness([tone(0.5, 3)], SR)
    expect(quiet.lufs).not.toBeNull()
    expect(loud.lufs).not.toBeNull()
    expect(loud.lufs!).toBeGreaterThan(quiet.lufs!)
  })

  it('tracks a 20 dB amplitude change as about 20 LU', () => {
    const a = measureLoudness([tone(0.05, 3)], SR)
    const b = measureLoudness([tone(0.5, 3)], SR)
    expect(b.lufs! - a.lufs!).toBeGreaterThan(19)
    expect(b.lufs! - a.lufs!).toBeLessThan(21)
  })

  it('THE POINT: two clips with the SAME peak but different energy are not equally loud', () => {
    // A "shout": loud nearly all the way through.
    const shout = tone(0.9, 3)
    // A "quiet sentence" that happens to contain one full-scale click, so peak
    // normalisation sees the two as identical and leaves the shout roaring.
    const soft = tone(0.06, 3)
    soft[1000] = 0.9

    // Looped, not Math.max(...spread): three seconds at 48 kHz is 144,000
    // arguments and the spread overflows the call stack.
    const peakOf = (a: Float32Array): number => {
      let p = 0
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > p) p = Math.abs(a[i])
      return p
    }
    const shoutPeak = peakOf(shout)
    const softPeak = peakOf(soft)
    expect(Math.abs(shoutPeak - softPeak)).toBeLessThan(1e-6) // same peak

    const ls = measureLoudness([shout], SR).lufs!
    const lq = measureLoudness([soft], SR).lufs!
    expect(ls - lq).toBeGreaterThan(15) // wildly different loudness
  })

  it('ignores silence between words instead of being dragged down by it', () => {
    // Speech, then a long pause. The pause must not make this measure quiet and
    // earn a boost that turns the speech into shouting.
    const speech = tone(0.3, 2)
    const withPause = new Float32Array(speech.length + SR * 4)
    withPause.set(speech, 0)

    const plain = measureLoudness([speech], SR).lufs!
    const gappy = measureLoudness([withPause], SR).lufs!
    expect(Math.abs(plain - gappy)).toBeLessThan(1.5)
  })

  it('returns null for digital silence rather than inventing a level', () => {
    expect(measureLoudness([new Float32Array(SR * 2)], SR).lufs).toBeNull()
  })

  it('measures only the requested range', () => {
    const buf = new Float32Array(SR * 6)
    buf.set(tone(0.5, 3), 0)
    buf.set(tone(0.02, 3), SR * 3)
    const first = measureLoudness([buf], SR, 0, 3).lufs!
    const second = measureLoudness([buf], SR, 3, 6).lufs!
    expect(first).toBeGreaterThan(second + 15)
  })

  it('is not thrown by an empty or zero-length range', () => {
    expect(measureLoudness([], SR).lufs).toBeNull()
    expect(measureLoudness([tone(0.5, 1)], SR, 2, 1).lufs).toBeNull()
  })
})

describe('gainForTarget', () => {
  const at = (lufs: number, peak = 0.1) => ({ lufs, peak, blocks: 30 })

  it('moves a quiet clip up and a loud clip down, toward the same target', () => {
    expect(gainForTarget(at(-26), TARGET_LUFS)!).toBeGreaterThan(0)
    expect(gainForTarget(at(-6, 0.5), TARGET_LUFS)!).toBeLessThan(0)
  })

  it('lands the clip ON the target when nothing clamps', () => {
    expect(gainForTarget(at(-20), -16)).toBeCloseTo(4, 1)
  })

  it('refuses to boost a nearly silent take into its own room noise', () => {
    expect(gainForTarget(at(-60), TARGET_LUFS, { maxBoostDb: 12 })).toBe(12)
  })

  it('never boosts a clip into clipping, however quiet it measures', () => {
    // Peak already at -0.9 dBFS: there is essentially no headroom left.
    const g = gainForTarget({ lufs: -30, peak: 0.9, blocks: 30 }, TARGET_LUFS, { peakCeilingDb: -1 })!
    expect(g).toBeLessThanOrEqual(0.1)
  })

  it('says nothing rather than something wrong for silence', () => {
    expect(gainForTarget({ lufs: null, peak: 0, blocks: 0 }, TARGET_LUFS)).toBeNull()
  })
})
