import { describe, expect, it } from 'vitest'
import { bootDurationMs, maskStatuses, revealSchedule } from './bootReveal'
import { HARD_CAP_MS, type BootStatuses, type BootStepSpec } from './bootProgress'

const spec = (id: string): BootStepSpec => ({ id, active: `Doing ${id}`, done: `Did ${id}` }) as BootStepSpec

// His ask, 2026-07-28: 4 to 8 seconds, randomised, with the ticks scattered
// ("one after 1 second, one after 1.5, one after 4, one after 4.5").
describe('bootDurationMs', () => {
  it('always lands between four and eight seconds', () => {
    for (const r of [0, 0.001, 0.5, 0.999, 1]) {
      const ms = bootDurationMs(() => r)
      expect(ms).toBeGreaterThanOrEqual(4000)
      expect(ms).toBeLessThanOrEqual(8000)
    }
  })

  it('stays under the cap that rescues a hung boot', () => {
    expect(bootDurationMs(() => 1)).toBeLessThan(HARD_CAP_MS)
  })
})

describe('revealSchedule', () => {
  it('is sorted, so a later row can never tick before an earlier one', () => {
    for (let seed = 0; seed < 50; seed++) {
      const times = revealSchedule(7, 6000, () => ((seed * 9301 + 49297) % 233280) / 233280)
      expect([...times].sort((a, b) => a - b)).toEqual(times)
    }
  })

  it('fits inside the run, with a beat at each end', () => {
    const times = revealSchedule(7, 6000)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(6000 * 0.12)
    expect(Math.max(...times)).toBeLessThanOrEqual(6000 * 0.88)
  })

  it('scatters rather than spacing them evenly', () => {
    // Two runs with different randomness must not produce the same gaps, or the
    // ticks would march in step, which is the metronome look he did not want.
    const a = revealSchedule(7, 6000, () => 0.1)
    const b = revealSchedule(7, 6000, () => 0.9)
    expect(a).not.toEqual(b)
  })

  it('handles a project with no rows', () => {
    expect(revealSchedule(0, 6000)).toEqual([])
  })
})

describe('maskStatuses', () => {
  const specs = [spec('a'), spec('b'), spec('c')]
  const real = { a: { state: 'done' }, b: { state: 'done' }, c: { state: 'failed' } } as BootStatuses

  it('hides the rows whose moment has not come', () => {
    expect(maskStatuses(specs, real, 1)).toEqual({
      a: { state: 'done' },
      b: { state: 'pending' },
      c: { state: 'pending' },
    })
  })

  // The pacing is theatre; the ticks are not. A revealed row shows what the work
  // really did, including a failure.
  it('never invents a tick for work that has not landed', () => {
    const halfDone = { a: { state: 'active' } } as BootStatuses
    expect(maskStatuses(specs, halfDone, 3)).toEqual({
      a: { state: 'active' },
      b: { state: 'pending' },
      c: { state: 'pending' },
    })
  })

  it('shows everything once every slot has passed', () => {
    expect(maskStatuses(specs, real, 3)).toEqual(real)
  })
})
