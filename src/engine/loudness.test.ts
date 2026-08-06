// The one thing this has to get right: a shout and a quiet sentence that share
// a PEAK must not be reported as equally loud. That is the exact failure he hit
// with the old peak-based normalize.

import { describe, expect, it } from 'vitest'
import { balanceGains, gainForTarget, measureLoudness, PEAK_CEILING_DB, TARGET_LUFS } from './loudness'

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
  const at = (lufs: number, peak = 0.1) => ({
    lufs,
    peak,
    bodyPeak: peak,
    noiseFloorLufs: -60,
    blocks: 30,
  })

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
    // Body already at -0.9 dBFS: there is essentially no headroom left.
    const g = gainForTarget(
      { lufs: -30, peak: 0.9, bodyPeak: 0.9, noiseFloorLufs: -60, blocks: 30 },
      TARGET_LUFS,
      { peakCeilingDb: -1 },
    )!
    expect(g).toBeLessThanOrEqual(0.1)
  })

  it('says nothing rather than something wrong for silence', () => {
    expect(
      gainForTarget({ lufs: null, peak: 0, bodyPeak: 0, noiseFloorLufs: null, blocks: 0 }, TARGET_LUFS),
    ).toBeNull()
  })

  // HIS BUG, 2026-08-06. A distant-mic clip with one desk bump was allowed only
  // +1.5 dB because the bump owned the whole headroom budget, and landed 17 dB
  // under every clip beside it.
  it('a lone transient does not veto the gain the voice needs', () => {
    const bumped = { lufs: -34.8, peak: 0.75, bodyPeak: 0.06, noiseFloorLufs: -58, blocks: 60 }
    expect(gainForTarget(bumped, TARGET_LUFS)!).toBeGreaterThan(15)
  })

  it('a clip that is loud ALL THE WAY THROUGH is still held back', () => {
    const loudBody = { lufs: -34.8, peak: 0.9, bodyPeak: 0.9, noiseFloorLufs: -58, blocks: 60 }
    expect(gainForTarget(loudBody, TARGET_LUFS)!).toBeLessThanOrEqual(0.1)
  })
})

describe('balanceGains', () => {
  const clip = (id: string, lufs: number, bodyPeak: number) => ({
    id,
    measured: { lufs, peak: bodyPeak, bodyPeak, noiseFloorLufs: -60, blocks: 60 },
  })

  it('leaves every clip at the SAME loudness as every other', () => {
    const gains = balanceGains(
      [clip('a', -20, 0.3), clip('b', -35, 0.05), clip('c', -14, 0.6)],
      TARGET_LUFS,
    )
    const landed = gains.map((g) => {
      const src = { a: -20, b: -35, c: -14 }[g.id]!
      return src + g.db
    })
    expect(Math.max(...landed) - Math.min(...landed)).toBeLessThanOrEqual(0.2)
  })

  it('takes the SHARED offset off everyone rather than clamping one clip', () => {
    // 'b' would need +21 dB and its body is already at -6 dBFS, so the whole
    // set moves down together instead of b stopping short and drifting away.
    const gains = balanceGains([clip('a', -20, 0.02), clip('b', -35, 0.5)], TARGET_LUFS)
    const byId = Object.fromEntries(gains.map((g) => [g.id, g.db]))
    expect(byId.a).toBeLessThan(4)
    expect(-20 + byId.a!).toBeCloseTo(-35 + byId.b!, 1)
  })

  it('nothing clips: the loudest body lands at or under the ceiling', () => {
    const gains = balanceGains([clip('a', -20, 0.3), clip('b', -35, 0.5)], TARGET_LUFS)
    const peaks = { a: 0.3, b: 0.5 }
    for (const g of gains) {
      const after = 20 * Math.log10(peaks[g.id as 'a' | 'b']) + g.db
      expect(after).toBeLessThanOrEqual(PEAK_CEILING_DB + 0.05)
    }
  })

  // COVERAGE GAP, found by review 2026-08-06: every fixture above sets
  // `peak: bodyPeak`, so nothing here ever constructed the case the whole
  // bodyPeak idea exists for, and nothing asserted what the TRUE peak does.
  // The answer is deliberate: the body is bounded, the lone transient is NOT,
  // and the master limiter (engine/audioLimiter.ts) is what catches it. That is
  // the trade. Levelling against the true peak instead is what left his
  // distant-mic clip 17 dB under everything beside it.
  it('a lone transient rides above the ceiling and is left to the limiter', () => {
    const bumped = {
      id: 'bump',
      measured: { lufs: -35, peak: 0.75, bodyPeak: 0.05, noiseFloorLufs: -58, blocks: 60 },
    }
    const [g] = balanceGains([bumped], TARGET_LUFS)
    // The voice gets the gain it needs (the target is reached, so the ceiling
    // never even binds here)...
    expect(g.db).toBeGreaterThan(15)
    expect(-35 + g.db).toBeCloseTo(TARGET_LUFS, 1)
    // ...the BODY stays at or under the ceiling...
    expect(20 * Math.log10(0.05) + g.db).toBeLessThanOrEqual(PEAK_CEILING_DB)
    // ...and the bump is knowingly over, for the limiter to shape.
    expect(20 * Math.log10(0.75) + g.db).toBeGreaterThan(0)
  })

  it('skips what it cannot measure instead of guessing', () => {
    const gains = balanceGains(
      [clip('a', -20, 0.3), { id: 'silent', measured: { lufs: null, peak: 0, bodyPeak: 0, noiseFloorLufs: null, blocks: 0 } }],
      TARGET_LUFS,
    )
    expect(gains.map((g) => g.id)).toEqual(['a'])
  })
})
