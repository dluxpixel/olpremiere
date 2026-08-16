import { describe, expect, it } from 'vitest'

import { SILENCE_DEFAULTS, cutTotalS, silentRanges, type SpokenWord } from './silence'

const w = (startS: number, endS: number): SpokenWord => ({ startS, endS })
const round = (r: { startS: number; endS: number }) => [
  Math.round(r.startS * 1000) / 1000,
  Math.round(r.endS * 1000) / 1000,
]

// No pad and no minimum, so the geometry can be read without arithmetic in the
// way. The padded behaviour gets its own block below.
const RAW = { minGapS: 0, padS: 0 }

describe('silentRanges', () => {
  it('finds the run before the first word and after the last', () => {
    // The two longest gaps in almost every take, and the two a "between words"
    // rule misses entirely.
    const out = silentRanges([w(2, 3)], 6, RAW)
    expect(out.map(round)).toEqual([
      [0, 2],
      [3, 6],
    ])
  })

  it('finds the gaps between words', () => {
    const out = silentRanges([w(0, 1), w(3, 4)], 4, RAW)
    expect(out.map(round)).toEqual([[1, 3]])
  })

  it('leaves breath alone', () => {
    // 0.2s between words is rhythm, not dead air.
    const out = silentRanges([w(0, 1), w(1.2, 2)], 2, SILENCE_DEFAULTS)
    expect(out).toEqual([])
  })

  it('says nothing when there is no transcript', () => {
    // An empty word list is not "cut the whole clip". That is a decision about
    // the clip and it belongs to the caller.
    expect(silentRanges([], 10, RAW)).toEqual([])
  })

  it('merges words that overlap instead of inventing a negative gap', () => {
    // Transcribers do overlap words. Un-merged, 1.0 -> 0.9 reads as a cut.
    const out = silentRanges([w(0, 1), w(0.9, 2), w(4, 5)], 5, RAW)
    expect(out.map(round)).toEqual([[2, 4]])
  })

  it('never runs past the clip', () => {
    const out = silentRanges([w(0, 1)], 3, RAW)
    for (const r of out) {
      expect(r.startS).toBeGreaterThanOrEqual(0)
      expect(r.endS).toBeLessThanOrEqual(3)
    }
  })
})

describe('the pad', () => {
  it('keeps air on the speech side of every cut', () => {
    // ⛔ A cut on the exact word edge eats the consonant and sounds like a bad
    // phone call. The gap is 1..3; the cut has to sit inside it.
    const out = silentRanges([w(0, 1), w(3, 4)], 4, { minGapS: 0.3, padS: 0.1 })
    expect(out.map(round)).toEqual([[1.1, 2.9]])
  })

  it('does not pad the outside of the head and tail', () => {
    // There is no word before the first one to protect, so the cut starts at 0.
    const out = silentRanges([w(2, 3)], 6, { minGapS: 0.3, padS: 0.1 })
    expect(out.map(round)).toEqual([
      [0, 1.9],
      [3.1, 6],
    ])
  })

  it('drops a gap the pad swallowed rather than emitting a backwards one', () => {
    // A 0.4s gap with 0.25s of pad each side has nothing left to cut.
    const out = silentRanges([w(0, 1), w(1.4, 2)], 2, { minGapS: 0.3, padS: 0.25 })
    expect(out).toEqual([])
  })
})

describe('cutTotalS', () => {
  it('adds up what would go, which is what the toast reports', () => {
    expect(cutTotalS(silentRanges([w(2, 3)], 6, RAW))).toBeCloseTo(5, 6)
    expect(cutTotalS([])).toBe(0)
  })
})
