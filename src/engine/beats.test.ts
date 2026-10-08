import { describe, expect, it } from 'vitest'
import { detectOnsets } from './beats'

const SR = 16000

/** Silence with short sine bursts at the given times. */
function bursts(durS: number, atS: number[], burstS = 0.06, level: (t: number) => number = () => 0.8): Float32Array {
  const pcm = new Float32Array(Math.round(durS * SR))
  for (const t of atS) {
    const start = Math.round(t * SR)
    for (let i = 0; i < burstS * SR && start + i < pcm.length; i++) {
      pcm[start + i] = level(t) * Math.sin((2 * Math.PI * 220 * i) / SR)
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

  // ⛔ AU-6. The cap kept the FIRST beats and stopped: on a steady 60 s bed every
  // punch landed in the first 15 s and the rest of the Short got none.
  const kicks = Array.from({ length: 119 }, (_, i) => 0.5 + i * 0.5)

  it('a capped run covers the whole clip, not just its start', () => {
    const onsets = detectOnsets(bursts(60, kicks), SR, { minGapS: 0.4, maxOnsets: 16 })
    expect(onsets).toHaveLength(16)
    expect(onsets[0]).toBeLessThan(4)
    expect(onsets[15]).toBeGreaterThan(45)
  })

  it('and the beats it keeps are the hardest ones', () => {
    // Every 4th kick is twice as loud: those are the ones a punch belongs on.
    const loud = (t: number) => (Math.round((t - 0.5) / 0.5) % 4 === 0 ? 0.8 : 0.4)
    const onsets = detectOnsets(bursts(60, kicks, 0.06, loud), SR, { minGapS: 0.4, maxOnsets: 16 })
    expect(onsets).toHaveLength(16)
    for (const t of onsets) {
      const nearest = kicks.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
      expect(loud(nearest)).toBe(0.8)
    }
  })
})
