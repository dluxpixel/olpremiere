// What he hears is what ships: the preview's master limiter is an AudioWorklet,
// and it must be the export's TruePeakLimiter, sample for sample, not a second
// limiter that agrees most of the time. The worklet scope is stood in for, the
// processor is run the way the audio thread runs it (128 frames at a time), and
// its output is compared with the export's limiter fed the same signal.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { LIMITER_PROCESSOR, TruePeakLimiter } from './audioLimiter'

type Processor = { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
let registered: { name: string; ctor: new () => Processor } | null = null

beforeAll(async () => {
  vi.stubGlobal('sampleRate', 48000)
  vi.stubGlobal('AudioWorkletProcessor', class {})
  vi.stubGlobal('registerProcessor', (name: string, ctor: new () => Processor) => {
    registered = { name, ctor }
  })
  await import('./limiterWorklet')
})

describe('the preview limiter worklet', () => {
  it('registers under the name the preview asks for', () => {
    expect(registered?.name).toBe(LIMITER_PROCESSOR)
  })

  it('is the export limiter, sample for sample, on loud material', () => {
    const n = 48000
    const l = Float32Array.from({ length: n }, (_, i) => 1.4 * Math.sin((2 * Math.PI * 220 * i) / 48000))
    const r = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 3000 * i) / 48000))

    const proc = new registered!.ctor()
    const live = [new Float32Array(n), new Float32Array(n)]
    for (let a = 0; a < n; a += 128) {
      const out = [new Float32Array(128), new Float32Array(128)]
      proc.process([[l.subarray(a, a + 128), r.subarray(a, a + 128)]], [out])
      live[0].set(out[0], a)
      live[1].set(out[1], a)
    }

    const exp = new TruePeakLimiter(2, 48000)
    const offline = [new Float32Array(n), new Float32Array(n)]
    exp.process([l, r], offline, n)

    expect(Array.from(live[0])).toEqual(Array.from(offline[0]))
    expect(Array.from(live[1])).toEqual(Array.from(offline[1]))
  })

  it('keeps running on silence when nothing is connected', () => {
    const proc = new registered!.ctor()
    const out = [new Float32Array(128), new Float32Array(128)]
    expect(proc.process([[]], [out])).toBe(true)
    expect(out[0].every((v) => v === 0)).toBe(true)
  })
})
