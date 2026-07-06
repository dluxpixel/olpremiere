import { describe, expect, it } from 'vitest'
import { computePeaks, slicePeaks } from './waveform'

describe('computePeaks', () => {
  it('returns a single zero bucket for empty input', () => {
    expect(Array.from(computePeaks(new Float32Array([]), 4))).toEqual([0, 0, 0, 0])
  })

  it('takes the abs peak within each bucket', () => {
    // 8 samples → 2 buckets of 4; peaks are the max |x| of each half.
    // (Float32 storage rounds 0.9, so compare with tolerance.)
    const s = new Float32Array([0.1, -0.5, 0.2, 0, /* | */ -0.9, 0.3, 0.4, -0.2])
    const p = computePeaks(s, 2)
    expect(p[0]).toBeCloseTo(0.5, 6)
    expect(p[1]).toBeCloseTo(0.9, 6)
  })

  it('clamps peaks above 1', () => {
    const s = new Float32Array([2, -3])
    expect(Array.from(computePeaks(s, 1))).toEqual([1])
  })

  it('the last bucket absorbs the remainder (no dropped samples)', () => {
    // 5 samples into 2 buckets: bucket 0 = [0,1], bucket 1 = [2,3,4]
    const s = new Float32Array([0.2, 0.4, 0.1, 0.1, 0.95])
    const p = computePeaks(s, 2)
    expect(p[0]).toBeCloseTo(0.4)
    expect(p[1]).toBeCloseTo(0.95) // would miss index 4 if the remainder were dropped
  })

  it('coerces a fractional/zero bucket count to at least 1', () => {
    expect(computePeaks(new Float32Array([0.5]), 0)).toHaveLength(1)
  })
})

describe('slicePeaks', () => {
  const peaks = new Float32Array([0, 0.25, 0.5, 0.75, 1]) // covers [0,5s) at 1/s

  it('maps a trimmed window to the right sub-range', () => {
    // window [2,4)s over a 5s source → fracs 0.4..0.8 → indices 2,3
    const out = slicePeaks(peaks, 5, 2, 4, 2)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(0.75)
  })

  it('full window spans the whole array', () => {
    const out = slicePeaks(peaks, 5, 0, 5, 5)
    expect(Array.from(out)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('is safe with a zero-duration source', () => {
    expect(Array.from(slicePeaks(peaks, 0, 0, 1, 3))).toEqual([0, 0, 0])
  })
})
