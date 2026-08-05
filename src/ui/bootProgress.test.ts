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
  trackBootStepWith,
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

  // The card is held for five seconds on his say-so, so it spends most of that
  // with every row already ticked. Repeating the last step would read as a stall,
  // and inventing more steps would be the fake progress this whole file refuses.
  it('says Ready once everything has landed', () => {
    const done = { a: { state: 'done' }, b: { state: 'done' }, c: { state: 'done' } } as BootStatuses
    expect(statusLine(specs, done)).toBe('Ready')
  })

  it('keeps a failure on the line instead of calling it Ready', () => {
    const oneFailed = {
      a: { state: 'done' },
      b: { state: 'failed', detail: 'one file is missing' },
      c: { state: 'done' },
    } as BootStatuses
    expect(statusLine(specs, oneFailed)).toBe('Doing b: one file is missing')
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
    // The cap has to clear the longest run he asked for (8s, randomised) with
    // room to spare, or the rescue would fire on a healthy boot.
    expect(HARD_CAP_MS).toBeGreaterThan(8000)
    expect(HARD_CAP_MS).toBeLessThanOrEqual(14_000)
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

describe('the warm-up rows', () => {
  const all = stepsFor(true)
  const ids = all.map((s) => s.id)

  it('warms video and audio, and gets captions ready', () => {
    expect(ids).toContain('warmVideo')
    expect(ids).toContain('warmAudio')
    expect(ids).toContain('captions')
  })

  it('runs the warm-up AFTER the project is open, because it warms what is in it', () => {
    expect(ids.indexOf('warmVideo')).toBeGreaterThan(ids.indexOf('project'))
    expect(ids.indexOf('warmAudio')).toBeGreaterThan(ids.indexOf('project'))
  })

  it('GATES on video and audio: they are the point of the wait', () => {
    const statuses: BootStatuses = {}
    for (const s of all) if (s.id !== 'warmVideo' && s.id !== 'warmAudio') statuses[s.id] = { state: 'done' }
    expect(gateReady(all, statuses)).toBe(false)
    statuses.warmVideo = { state: 'done' }
    expect(gateReady(all, statuses)).toBe(false)
    statuses.warmAudio = { state: 'done' }
    expect(gateReady(all, statuses)).toBe(true)
  })

  it('NEVER gates on captions, so a 100MB model download cannot lock him out', () => {
    // The whole reason that row is marked optional. If this ever goes red, a
    // first-ever boot on slow wifi would sit on the splash waiting for Whisper.
    const statuses: BootStatuses = {}
    for (const s of all) if (s.id !== 'captions') statuses[s.id] = { state: 'done' }
    expect(gateReady(all, statuses)).toBe(true)
  })

  it('a warm-up that FAILS still opens the app', () => {
    // A file that will not decode must not be able to hold the editor shut.
    const statuses: BootStatuses = {}
    for (const s of all) statuses[s.id] = { state: 'done' }
    statuses.warmVideo = { state: 'failed' }
    statuses.warmAudio = { state: 'failed' }
    expect(gateReady(all, statuses)).toBe(true)
  })
})

describe('trackBootStepWith', () => {
  it('states what it actually warmed, instead of a fixed string', async () => {
    useBootLedger.getState().reset()
    await trackBootStepWith('warmAudio', Promise.resolve(6), (n) => `${n} ready`)
    expect(statusOf(useBootLedger.getState().statuses, 'warmAudio')).toEqual({ state: 'done', detail: '6 ready' })
  })

  it('reports a failure as failed and resolves null, never throwing at boot', async () => {
    useBootLedger.getState().reset()
    const out = await trackBootStepWith('warmVideo', Promise.reject(new Error('no')), () => 'unused')
    expect(out).toBeNull()
    expect(statusOf(useBootLedger.getState().statuses, 'warmVideo').state).toBe('failed')
  })
})

describe('progressOf answers "how close am I to being let in"', () => {
  it('ignores optional rows, so a slow model download cannot park the bar', () => {
    // THE BUG this guards. When the caption row was added, the bar counted it,
    // so a healthy boot sat at 89% for as long as a 100MB download took while
    // the app was in fact ready. A bar that cannot reach 100 is worse than none.
    const specs = [spec('a'), spec('b'), spec('slow', { optional: true })]
    const statuses = {
      a: { state: 'done' },
      b: { state: 'done' },
      slow: { state: 'active' },
    } as unknown as BootStatuses
    expect(progressOf(specs, statuses)).toBe(1)
    // and it agrees with the gate, which is the thing it is describing
    expect(gateReady(specs, statuses)).toBe(true)
  })

  it('still counts a gating row that has not landed', () => {
    const specs = [spec('a'), spec('b'), spec('slow', { optional: true })]
    expect(progressOf(specs, { a: { state: 'done' } } as unknown as BootStatuses)).toBe(0.5)
  })
})
