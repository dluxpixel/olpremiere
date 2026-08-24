import { describe, expect, it } from 'vitest'

import { denoiseChannel, denoiseEvictionPlan, mixDryWet, type DenoiseEngine } from './denoise'

// A deterministic stand-in for the wasm: halves every sample in place. Lets
// the chunking/scaling logic be pinned without loading RNNoise in node.
const halver = (frameSize: number): DenoiseEngine => ({
  frameSize,
  createDenoiseState: () => ({
    processFrame(frame: Float32Array) {
      for (let i = 0; i < frame.length; i++) frame[i] = frame[i]! / 2
      return 0
    },
    destroy() {},
  }),
})

describe('mixDryWet', () => {
  const raw = Float32Array.from([0.5, -0.25, 1, 0])
  const wet = Float32Array.from([0.1, 0.1, 0.1, 0.1])

  it('strength 0 is numerically identical to raw (the A/B guarantee)', () => {
    expect(Array.from(mixDryWet(raw, wet, 0))).toEqual(Array.from(raw))
  })

  it('strength 1 is the wet signal; 0.5 is the exact average', () => {
    expect(Array.from(mixDryWet(raw, wet, 1))).toEqual(Array.from(wet))
    const half = mixDryWet(raw, wet, 0.5)
    // float32 storage: compare to 6 places, not exact decimal literals
    for (const [i, v] of [0.3, -0.075, 0.55, 0.05].entries()) expect(half[i]).toBeCloseTo(v, 6)
  })

  it('clamps out-of-range strengths instead of extrapolating', () => {
    expect(Array.from(mixDryWet(raw, wet, 2))).toEqual(Array.from(wet))
    expect(Array.from(mixDryWet(raw, wet, -1))).toEqual(Array.from(raw))
  })

  it('returns a NEW array and never mutates the cached raw PCM', () => {
    const out = mixDryWet(raw, wet, 1)
    expect(out).not.toBe(wet)
    expect(raw[0]).toBe(0.5)
  })
})

describe('denoiseChannel (chunking + 16-bit scaling)', () => {
  it('processes whole frames and preserves length', () => {
    const input = Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 10)
    const out = denoiseChannel(halver(4), input)
    expect(out.length).toBe(8)
    for (let i = 0; i < 8; i++) expect(out[i]).toBeCloseTo(input[i]! / 2, 6)
  })

  it('zero-pads the tail frame and truncates back (no length drift)', () => {
    const input = Float32Array.from([0.2, 0.4, 0.6, 0.8, 1, 0.5]) // 6 samples, frame 4
    const out = denoiseChannel(halver(4), input)
    expect(out.length).toBe(6)
    expect(out[5]).toBeCloseTo(0.25, 6)
  })

  it('does not mutate its input', () => {
    const input = Float32Array.from([0.5, 0.5, 0.5, 0.5])
    denoiseChannel(halver(4), input)
    expect(Array.from(input)).toEqual([0.5, 0.5, 0.5, 0.5])
  })

  // The REAL wasm is browser-only (emscripten env check), so determinism +
  // "actually reduces noise" against real RNNoise live in e2e/denoise.spec.ts.
})

// ⛔ THE DENOISE CACHES HAVE A CEILING NOW.
//
// They held the full decoded audio of every clip he had ever denoised, twice
// over, and nothing ever dropped them but deleting the asset. Roughly 230 MB per
// ten minute stereo clip, beside a frame cache capped at 512 MB and an audio
// cache capped at 256 MB. His words, 2026-08-24: *"it also somehow takes 99% of
// my fucking RAM"*, then *"the lag sucks tho"*. The app was measured holding
// 3.9 GB with 4 GB free of 32 while he said it.
describe('the denoise caches cannot grow without end', () => {
  const MB = 1024 * 1024
  const sizes: Record<string, number> = { a: 100 * MB, b: 100 * MB, c: 100 * MB, d: 100 * MB }
  const bytesOf = (id: string): number => sizes[id] ?? 0

  it('drops nothing while it is inside the budget', () => {
    expect(denoiseEvictionPlan(['a', 'b'], bytesOf, 200 * MB, 400 * MB, 'b')).toEqual([])
  })

  it('drops the oldest first, and only as many as it takes', () => {
    // 400 MB held against a 250 MB budget: dropping 'a' and 'b' is enough.
    expect(denoiseEvictionPlan(['a', 'b', 'c', 'd'], bytesOf, 400 * MB, 250 * MB, 'd')).toEqual(['a', 'b'])
  })

  it('never evicts the clip it was just asked to keep', () => {
    // 'a' is both the oldest and the one just computed, so 'b' goes instead.
    const plan = denoiseEvictionPlan(['a', 'b', 'c'], bytesOf, 300 * MB, 150 * MB, 'a')
    expect(plan).not.toContain('a')
    expect(plan).toEqual(['b', 'c'])
  })

  it('would empty everything else rather than sit over the budget', () => {
    expect(denoiseEvictionPlan(['a', 'b', 'c'], bytesOf, 300 * MB, 0, 'c')).toEqual(['a', 'b'])
  })
})
