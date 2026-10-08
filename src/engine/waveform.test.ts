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

  // Fewer columns than peaks used to read ONE peak per column and skip the rest.
  it('draws the loudest of the peaks each column covers', () => {
    const p = new Float32Array([0.1, 0.9, 0.2, 0.3])
    expect(Array.from(slicePeaks(p, 4, 0, 4, 2)).map((v) => Math.round(v * 10) / 10)).toEqual([0.9, 0.3])
  })

  it('never reaches past the trimmed window for a louder peak', () => {
    const p = new Float32Array([1, 0, 0, 0, 0, 0, 0, 1])
    expect(Array.from(slicePeaks(p, 8, 1, 7, 2))).toEqual([0, 0])
  })

  // The review's case: a 3 minute song at the default 60 px/s is 10,800 peaks
  // drawn into 4,096 columns (ClipWaveform's MAX_COLS). A kick that lives in a
  // single peak had about a 60 percent chance of not being drawn.
  it('shows a single loud peak wherever it falls in a 3 minute song at 4096 columns', () => {
    const song = new Float32Array(10_800).fill(0.05)
    const missed: number[] = []
    for (let k = 0; k < 600; k++) {
      song[k] = 1
      if (!slicePeaks(song, 180, 0, 180, 4096).includes(1)) missed.push(k)
      song[k] = 0.05
    }
    expect(missed).toEqual([])
  })

  // ⛔ AU-7. One bucket per column skipped most buckets zoomed out, so a gunshot
  // or a kick vanished from the waveform he cuts against.
  it('never loses a short loud hit, at any zoom', () => {
    const tenSeconds = new Float32Array(600) // 60 buckets a second
    tenSeconds[301] = 1 // one 17 ms clap at 5.01 s
    for (const cols of [600, 300, 100, 30, 7]) {
      expect(Math.max(...slicePeaks(tenSeconds, 10, 0, 10, cols))).toBe(1)
    }
  })

  it('draws a spoken word at its loud buckets, not its quiet ones', () => {
    const word = Float32Array.from({ length: 600 }, (_, i) => (i % 2 === 0 ? 0.1 : 0.8))
    const cols = slicePeaks(word, 10, 0, 10, 100)
    expect(Math.min(...cols)).toBeCloseTo(0.8)
  })
})
