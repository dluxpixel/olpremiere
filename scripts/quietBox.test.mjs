// The quiet box check (e2e/quietBox.ts) decides when a timing spec may start measuring, and
// what it waits on is this maths. It sits in scripts/ because Playwright takes every
// *.test.ts under e2e/ for one of its own specs.
//
// ⛔ 2026-10-08: "below half of all CPU time busy" called fifteen pegged cores on a 32
// thread box quiet (47%). The mean was never the question; a free core was.

import { describe, expect, it } from 'vitest'
import { BUSY_LIMIT, isBusy, MIN_PEGGED, peggedLimit, readingBetween } from '../e2e/boxLoad.ts'

const ZERO = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }

/** Two snapshots of `n` cores one window apart: core i spent `busy(i)` of 1000 ticks working. */
function windowOf(n, busy) {
  const before = Array.from({ length: n }, () => ({ ...ZERO }))
  const after = Array.from({ length: n }, (_, i) => ({ ...ZERO, user: busy(i), idle: 1000 - busy(i) }))
  return [before, after]
}

describe('readingBetween', () => {
  it('THE CASE: fifteen of 32 cores pegged is busy, though the mean is under half', () => {
    const [a, b] = windowOf(32, (i) => (i < 15 ? 1000 : 0))
    const r = readingBetween(a, b)
    expect(r.share).toBeLessThan(BUSY_LIMIT)
    expect(r.share).toBeCloseTo(15 / 32, 5)
    expect(r.pegged).toBe(15)
    expect(r.cores).toBe(32)
    expect(r.busy).toBe(true)
  })

  it('a quiet 32 thread box is quiet', () => {
    const [a, b] = windowOf(32, () => 50)
    const r = readingBetween(a, b)
    expect(r.pegged).toBe(0)
    expect(r.busy).toBe(false)
  })

  it('seven pegged of 32 is still quiet, eight is busy', () => {
    expect(peggedLimit(32)).toBe(8)
    expect(readingBetween(...windowOf(32, (i) => (i < 7 ? 1000 : 0))).busy).toBe(false)
    expect(readingBetween(...windowOf(32, (i) => (i < 8 ? 1000 : 0))).busy).toBe(true)
  })

  it('one pegged core on a small box is not a busy box, two are', () => {
    expect(peggedLimit(4)).toBe(MIN_PEGGED)
    expect(readingBetween(...windowOf(4, (i) => (i < 1 ? 1000 : 0))).busy).toBe(false)
    expect(readingBetween(...windowOf(4, (i) => (i < 2 ? 1000 : 0))).busy).toBe(true)
  })

  it('a mean above half is busy with no core pegged', () => {
    const r = readingBetween(...windowOf(8, () => 600))
    expect(r.pegged).toBe(0)
    expect(r.share).toBeCloseTo(0.6, 5)
    expect(r.busy).toBe(true)
  })

  it('a core is pegged from 90% busy, and not at 89%', () => {
    expect(readingBetween(...windowOf(32, (i) => (i < 8 ? 890 : 0))).pegged).toBe(0)
    expect(readingBetween(...windowOf(32, (i) => (i < 8 ? 900 : 0))).pegged).toBe(8)
  })

  it('counts only the cores both snapshots have, and an empty window as quiet', () => {
    const [a, b] = windowOf(4, () => 1000)
    expect(readingBetween(a.slice(0, 2), b).cores).toBe(2)
    expect(readingBetween([], []).busy).toBe(false)
    expect(readingBetween(a, a)).toEqual({ share: 0, pegged: 0, cores: 4, busy: false })
  })
})

describe('isBusy', () => {
  it('is the mean OR the cores taken', () => {
    expect(isBusy(0.49, 0, 32)).toBe(false)
    expect(isBusy(0.5, 0, 32)).toBe(true)
    expect(isBusy(0.1, 8, 32)).toBe(true)
    expect(isBusy(0.1, 7, 32)).toBe(false)
  })
})
