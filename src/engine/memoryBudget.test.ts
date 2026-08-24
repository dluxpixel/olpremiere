// ⛔ THE ONE RULE THIS FILE EXISTS FOR: the caches can never ask for MORE than
// they used to. Every other case is about asking for less on a machine that
// cannot spare it. A budget change that made the app hungrier would be the exact
// bug it was written to fix, wearing a different hat.

import { describe, expect, it } from 'vitest'
import { cacheBudgets, CEILING_BYTES } from './memoryBudget'

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

describe('cacheBudgets', () => {
  it('never exceeds what the app took before, however much RAM is free', () => {
    for (const free of [3 * GB, 16 * GB, 64 * GB, 1024 * GB]) {
      expect(cacheBudgets(free).total).toBeLessThanOrEqual(CEILING_BYTES)
    }
  })

  it('keeps the old numbers exactly on a machine with room', () => {
    // A third of 3 GB is already past the ceiling, so anything roomy is unchanged.
    const b = cacheBudgets(8 * GB)
    expect(b.total).toBe(CEILING_BYTES)
    expect(Math.round(b.frames / MB)).toBe(512)
    expect(Math.round(b.audio / MB)).toBe(256)
    expect(Math.round(b.denoise / MB)).toBe(192)
  })

  it('shrinks on the machine he actually had, which is the whole point', () => {
    // Measured 2026-08-24 with the app closed: 7.6 GB available on a 31.7 GB
    // machine whose commit charge was already 47 GB. deviceMemory would have said
    // "8 GB, plenty". A third of what is really spare is about 2.5 GB, still over
    // the ceiling, so the ceiling holds here...
    expect(cacheBudgets(7.6 * GB).total).toBe(CEILING_BYTES)
    // ...and it is the genuinely tight case that gives ground.
    const tight = cacheBudgets(2 * GB)
    expect(tight.total).toBeLessThan(CEILING_BYTES)
    expect(Math.round(tight.total / MB)).toBe(683)
  })

  it('holds the split the three caches were tuned against each other with', () => {
    const b = cacheBudgets(1.5 * GB)
    expect(b.frames + b.audio + b.denoise).toBeLessThanOrEqual(b.total)
    // 512 : 256 : 192 is 8 : 4 : 3.
    expect(b.frames / b.denoise).toBeCloseTo(8 / 3, 2)
    expect(b.audio / b.denoise).toBeCloseTo(4 / 3, 2)
  })

  it('stops taking from a machine that has nothing left, but never reaches zero', () => {
    const desperate = cacheBudgets(64 * MB)
    expect(Math.round(desperate.total / MB)).toBe(96)
    // A zero budget would evict every entry the moment it was written, so the app
    // would re-decode every frame forever: slower than no cache at all.
    expect(desperate.frames).toBeGreaterThan(0)
    expect(desperate.audio).toBeGreaterThan(0)
    expect(desperate.denoise).toBeGreaterThan(0)
  })

  it('falls back to the old constants when it is told nothing usable', () => {
    // A number nobody can stand behind must never make the app worse than it was.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(cacheBudgets(bad).total).toBe(CEILING_BYTES)
    }
  })
})
