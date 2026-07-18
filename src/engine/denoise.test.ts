import { describe, expect, it } from 'vitest'

import { denoiseChannel, mixDryWet, type DenoiseEngine } from './denoise'

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

  it('returns a NEW array — never mutates the cached raw PCM', () => {
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
