import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_STEPS,
  CARD_EXIT_MS,
  HARD_CAP_MS,
  MIN_CARD_MS,
  OPTIONAL_GRACE_MS,
  allSettled,
  bootOverride,
  bootStep,
  gateReady,
  labelOf,
  progressOf,
  statusLine,
  statusOf,
  stepsFor,
  trackBootStep,
  useBootLedger,
  type BootStatuses,
  type BootStepSpec,
} from './bootProgress'

const spec = (id: string, extra: Partial<BootStepSpec> = {}): BootStepSpec =>
  ({ id, active: `Doing ${id}`, done: `Did ${id}`, ...extra }) as BootStepSpec

describe('boot step rows', () => {
  it('hides the update row on the web build, where there is no installer to update', () => {
    expect(stepsFor(false).map((s) => s.id)).not.toContain('updates')
    expect(stepsFor(true).map((s) => s.id)).toContain('updates')
    // Every other row is shared, so the two lists differ by exactly the desktop ones.
    expect(stepsFor(true).length - stepsFor(false).length).toBe(BOOT_STEPS.filter((s) => s.electronOnly).length)
  })

  it('reads an unreported row as pending rather than throwing', () => {
    expect(statusOf({}, 'project')).toEqual({ state: 'pending' })
  })
})

describe('progressOf', () => {
  const specs = [spec('a'), spec('b'), spec('c'), spec('d')]

  it('is zero before anything lands', () => {
    expect(progressOf(specs, {})).toBe(0)
  })

  it('counts a failed row as settled: it is finished, just not well', () => {
    const statuses: BootStatuses = { a: { state: 'done' }, b: { state: 'failed' }, c: { state: 'active' } } as BootStatuses
    expect(progressOf(specs, statuses)).toBe(0.5)
  })

  it('reaches 1 only when every shown row has settled', () => {
    const statuses = { a: { state: 'done' }, b: { state: 'done' }, c: { state: 'done' } } as BootStatuses
    expect(progressOf(specs, statuses)).toBe(0.75)
  })
})

describe('labelOf', () => {
  it('is present tense while running and past tense once done', () => {
    expect(labelOf(spec('a'), { state: 'pending' })).toBe('Doing a')
    expect(labelOf(spec('a'), { state: 'active' })).toBe('Doing a')
    expect(labelOf(spec('a'), { state: 'done' })).toBe('Did a')
  })

  it('appends the row detail, as in "Checked for updates: up to date"', () => {
    const updates = BOOT_STEPS.find((s) => s.id === 'updates')!
    expect(labelOf(updates, { state: 'done', detail: 'up to date' })).toBe('Checked for updates: up to date')
    expect(labelOf(updates, { state: 'active', detail: 'found 0.1.15' })).toBe('Checking for updates: found 0.1.15')
  })

  it('says what failed once, not twice', () => {
    expect(labelOf(spec('a'), { state: 'failed' })).toBe('Doing a: failed')
    expect(labelOf(spec('a'), { state: 'failed', detail: 'offline' })).toBe('Doing a: offline')
  })
})

describe('statusLine', () => {
  const specs = [spec('a'), spec('b'), spec('c')]

  it('names the first row still running', () => {
    const statuses = { a: { state: 'done' }, b: { state: 'active' }, c: { state: 'active' } } as BootStatuses
    expect(statusLine(specs, statuses)).toBe('Doing b')
  })

  it('falls back to the furthest-along finished row, so the line is never blank', () => {
    const statuses = { a: { state: 'done' }, b: { state: 'done' } } as BootStatuses
    expect(statusLine(specs, statuses)).toBe('Did b')
  })

  it('opens on the first row before anything has reported', () => {
    expect(statusLine(specs, {})).toBe('Doing a')
  })
})

describe('the boot gate', () => {
  const specs = [spec('a'), spec('b'), spec('net', { optional: true })]

  it('does not wait on an optional row, because the editor must open on bad wifi', () => {
    const statuses = { a: { state: 'done' }, b: { state: 'done' }, net: { state: 'active' } } as BootStatuses
    expect(gateReady(specs, statuses)).toBe(true)
    expect(allSettled(specs, statuses)).toBe(false)
  })

  it('waits on a gating row that is still running', () => {
    const statuses = { a: { state: 'done' }, b: { state: 'active' }, net: { state: 'done' } } as BootStatuses
    expect(gateReady(specs, statuses)).toBe(false)
  })

  it('opens on a FAILED gating row instead of hanging on it', () => {
    const statuses = { a: { state: 'done' }, b: { state: 'failed' } } as BootStatuses
    expect(gateReady(specs, statuses)).toBe(true)
  })
})

describe('the ledger', () => {
  beforeEach(() => useBootLedger.getState().reset())

  it('records begin → note → finish for one row', () => {
    bootStep.begin('updates')
    expect(useBootLedger.getState().statuses.updates).toEqual({ state: 'active', detail: undefined })
    bootStep.note('updates', 'downloading 0.1.15, 40%')
    expect(useBootLedger.getState().statuses.updates).toEqual({ state: 'active', detail: 'downloading 0.1.15, 40%' })
    bootStep.finish('updates', 'up to date')
    expect(useBootLedger.getState().statuses.updates).toEqual({ state: 'done', detail: 'up to date' })
  })

  it('never un-finishes real work when a later error arrives', () => {
    bootStep.finish('project')
    bootStep.failUnfinished('project')
    expect(useBootLedger.getState().statuses.project).toEqual({ state: 'done', detail: undefined })
  })

  it('fails a row that never landed', () => {
    bootStep.begin('media')
    bootStep.failUnfinished('media', 'gave up')
    expect(useBootLedger.getState().statuses.media).toEqual({ state: 'failed', detail: 'gave up' })
  })
})

describe('the ?boot= override', () => {
  it('recognises only the three verification values', () => {
    expect(bootOverride('?boot=hold')).toBe('hold')
    expect(bootOverride('?boot=melon')).toBe('melon')
    expect(bootOverride('?boot=show')).toBe('show')
    expect(bootOverride('?boot=hold&theme=dark')).toBe('hold')
  })

  it('is null for a normal launch, so nothing he runs can trip it', () => {
    expect(bootOverride('')).toBeNull()
    expect(bootOverride('?boot=')).toBeNull()
    expect(bootOverride('?boot=yes')).toBeNull()
    expect(bootOverride('?theme=claude')).toBeNull()
  })
})

describe('the timings he actually feels', () => {
  it('shows the card long enough to read, and never long enough to trap him', () => {
    expect(MIN_CARD_MS).toBeGreaterThanOrEqual(600)
    expect(MIN_CARD_MS).toBeLessThan(HARD_CAP_MS)
    // The network grace must still fit inside the cap, or the cap would be what
    // ends every offline boot instead of the grace.
    expect(MIN_CARD_MS + OPTIONAL_GRACE_MS).toBeLessThan(HARD_CAP_MS)
    expect(HARD_CAP_MS).toBeLessThanOrEqual(10_000)
  })

  // The card's exit and the melon's entrance are timed in JS but animated in CSS.
  // Nothing else would ever catch the two drifting apart.
  it('keeps the card exit in step with its stylesheet', () => {
    const css = readFileSync(new URL('./LoadingCard.module.css', import.meta.url), 'utf8')
    expect(css).toContain(`cardOut ${CARD_EXIT_MS}ms`)
  })

  it('keeps the splash exit in step with its stylesheet', () => {
    const css = readFileSync(new URL('./BootSplash.module.css', import.meta.url), 'utf8')
    const tsx = readFileSync(new URL('./BootSplash.tsx', import.meta.url), 'utf8')
    const exitMs = /const EXIT_MS = (\d+)/.exec(tsx)?.[1]
    expect(exitMs).toBeTruthy()
    expect(css).toContain(`bootOut ${exitMs}ms`)
    expect(css).toContain(`melonPop ${exitMs}ms`)
  })
})

describe('trackBootStep', () => {
  beforeEach(() => useBootLedger.getState().reset())

  it('marks the row done when the real work resolves', async () => {
    await trackBootStep('media', Promise.resolve('ok'))
    expect(useBootLedger.getState().statuses.media?.state).toBe('done')
  })

  it('reports a failure instead of throwing, because the boot screen must not become the error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(trackBootStep('fonts', Promise.reject(new Error('no font')))).resolves.toBeNull()
    expect(useBootLedger.getState().statuses.fonts?.state).toBe('failed')
    warn.mockRestore()
  })
})
