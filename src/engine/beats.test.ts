import { describe, expect, it } from 'vitest'
import { detectOnsets } from './beats'

const SR = 16000

/** Silence with short sine bursts at the given times. */
function bursts(durS: number, atS: number[], burstS = 0.06): Float32Array {
  const pcm = new Float32Array(Math.round(durS * SR))
  for (const t of atS) {
    const start = Math.round(t * SR)
    for (let i = 0; i < burstS * SR && start + i < pcm.length; i++) {
      pcm[start + i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR)
    }
  }
  return pcm
}

describe('detectOnsets', () => {
  it('finds each burst near its true time', () => {
    const onsets = detectOnsets(bursts(4, [1, 2.5]), SR)
    expect(onsets).toHaveLength(2)
    expect(Math.abs(onsets[0] - 1)).toBeLessThan(0.04)
    expect(Math.abs(onsets[1] - 2.5)).toBeLessThan(0.04)
  })

  it('merges hits closer than the minimum gap', () => {
    const onsets = detectOnsets(bursts(3, [1, 1.1, 2]), SR, { minGapS: 0.35 })
    expect(onsets).toHaveLength(2) // 1.1 folds into 1.0
  })

  it('caps the onset count', () => {
    const times = Array.from({ length: 12 }, (_, i) => 0.5 + i * 0.5)
    expect(detectOnsets(bursts(8, times), SR, { maxOnsets: 5 })).toHaveLength(5)
  })

  it('stays silent on silence and steady tone', () => {
    expect(detectOnsets(new Float32Array(SR * 2), SR)).toEqual([])
    const tone = new Float32Array(SR * 2)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
    // the single attack at t=0 may register; a steady tone must not spray onsets
    expect(detectOnsets(tone, SR).length).toBeLessThanOrEqual(1)
  })

  it('is deterministic', () => {
    const pcm = bursts(4, [1, 2.5])
    expect(detectOnsets(pcm, SR)).toEqual(detectOnsets(pcm, SR))
  })
})
