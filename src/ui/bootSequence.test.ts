// The bugs these guard are the ones he actually saw on the splash: the bar stuck
// at 88%, two rows running at once with a grey one stranded between them, and a
// row that never finished. All three came from the same place, so all three are
// tested from the same place.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_STEPS,
  HARD_CAP_MS,
  allSettled,
  gateReady,
  progressOf,
  statusOf,
  stepsFor,
  useBootLedger,
  type BootStatuses,
  type BootStepId,
} from './bootProgress'
import {
  ALL_BOOT_STEP_IDS,
  BACKGROUND_STEP_TIMEOUT_MS,
  NO_ANSWER,
  STEP_TIMEOUT_MS,
  bootTasks,
  runBootSequence,
  started,
  type BootTaskRun,
  type BootWork,
} from './bootSequence'

const workOf = (run: (id: BootStepId) => BootTaskRun): BootWork =>
  Object.fromEntries(ALL_BOOT_STEP_IDS.map((id) => [id, run(id)])) as BootWork

/**
 * Every row's work SKIPPED: an empty project, nothing on the timeline to warm,
 * no media, no captions, no network. The rows still have to land.
 */
const skippedWork = (): BootWork => workOf((id) => () => ({ detail: `${id} skipped` }))

beforeEach(() => useBootLedger.getState().reset())

describe('the boot rows advance in the card order', () => {
  it('runs one row at a time and never starts one while a row above it is pending', async () => {
    const order = stepsFor(true).map((s) => s.id)
    const seen: { id: BootStepId; statuses: BootStatuses }[] = []
    // Snapshots rather than assertions inside the work: an assertion that throws
    // in there would be caught by the runner and reported as a failed row, and
    // the test would pass while proving nothing.
    const work = workOf((id) => async () => {
      seen.push({ id, statuses: { ...useBootLedger.getState().statuses } })
      await Promise.resolve()
    })

    await runBootSequence(bootTasks(work, true))

    expect(seen.map((s) => s.id)).toEqual(order)
    seen.forEach(({ id, statuses }, i) => {
      expect(statusOf(statuses, id).state).toBe('active')
      // Exactly one row is ever running, which is the greyed-row-in-the-middle bug.
      expect(order.filter((other) => statusOf(statuses, other).state === 'active')).toEqual([id])
      for (const earlier of order.slice(0, i)) expect(statusOf(statuses, earlier).state).toMatch(/done|failed/)
      for (const later of order.slice(i + 1)) expect(statusOf(statuses, later).state).toBe('pending')
    })
  })

  it('does the first row synchronously, so the theme is stamped before React mounts', async () => {
    let stamped = false
    const run = runBootSequence([
      {
        id: 'settings',
        run: () => {
          stamped = true
        },
        timeoutMs: STEP_TIMEOUT_MS,
      },
    ])
    // Not "after a microtask": the editor's root is rendered on the next line of
    // main.tsx, and a theme applied after that is a flash of the wrong ground.
    expect(stamped).toBe(true)
    await run
  })

  it('pairs every row the card draws with work, so no row can be left undriven', () => {
    // `proxies` used to be reported from inside a chain that could throw before
    // reaching it, and a row nobody drives stays grey for the whole session.
    for (const isElectron of [false, true]) {
      expect(bootTasks(skippedWork(), isElectron).map((t) => t.id)).toEqual(stepsFor(isElectron).map((s) => s.id))
    }
    expect([...ALL_BOOT_STEP_IDS]).toEqual(BOOT_STEPS.map((s) => s.id))
  })

  it('keeps the rows that can honestly run for minutes at the bottom of the card', () => {
    // Anything under them waits behind a 100MB model download on a first-ever
    // boot, which is how the update row would end up grey on the very launch it
    // is there to narrate.
    const ids = stepsFor(true).map((s) => s.id)
    expect(ids.slice(-2)).toEqual(['proxies', 'captions'])
    expect(ids.indexOf('updates')).toBeLessThan(ids.indexOf('proxies'))
  })
})

describe('every row terminates', () => {
  it('settles all of them when there is nothing for any of them to do', async () => {
    const specs = stepsFor(true)
    await runBootSequence(bootTasks(skippedWork(), true))

    const { statuses } = useBootLedger.getState()
    for (const spec of specs) {
      expect(statusOf(statuses, spec.id)).toEqual({ state: 'done', detail: `${spec.id} skipped` })
    }
    expect(allSettled(specs, statuses)).toBe(true)
  })

  it('reaches 100% with an empty project, on the web build and the desktop one', async () => {
    for (const isElectron of [false, true]) {
      useBootLedger.getState().reset()
      await runBootSequence(bootTasks(skippedWork(), isElectron))
      const specs = stepsFor(isElectron)
      const { statuses } = useBootLedger.getState()
      expect(progressOf(specs, statuses)).toBe(1)
      expect(gateReady(specs, statuses)).toBe(true)
    }
  })

  it('reaches 100% with a loaded project, where the warm-up rows report what they warmed', async () => {
    const specs = stepsFor(true)
    const work = workOf((id) => async () => {
      if (id === 'warmVideo' || id === 'warmAudio') return { detail: '6 ready' }
      if (id === 'proxies') return { detail: '3 clips ready' }
      return {}
    })
    await runBootSequence(bootTasks(work, true))

    const { statuses } = useBootLedger.getState()
    expect(statusOf(statuses, 'warmAudio')).toEqual({ state: 'done', detail: '6 ready' })
    expect(progressOf(specs, statuses)).toBe(1)
  })

  it('calls a row that never answers unanswered, instead of leaving it running for ever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runBootSequence([
      { id: 'warmAudio', run: () => new Promise<void>(() => {}), timeoutMs: 5 },
      { id: 'proxies', run: () => ({ detail: 'nothing to prepare' }), timeoutMs: 5 },
    ])

    const { statuses } = useBootLedger.getState()
    // 88%: one hung decode used to hold 1 of the 8 gating rows open all session.
    expect(statuses.warmAudio).toEqual({ state: 'failed', detail: NO_ANSWER })
    // And the row under it still ran. The hang used to take everything below down.
    expect(statuses.proxies).toEqual({ state: 'done', detail: 'nothing to prepare' })
    warn.mockRestore()
  })

  it('carries on after a row that throws, so one failure cannot strand the rows below', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const specs = stepsFor(true)
    const work = workOf((id) => () => {
      if (id === 'project') throw new Error('IndexedDB is gone')
      return {}
    })
    await runBootSequence(bootTasks(work, true))

    const { statuses } = useBootLedger.getState()
    expect(statusOf(statuses, 'project').state).toBe('failed')
    expect(allSettled(specs, statuses)).toBe(true)
    // A broken startup still opens the editor: a failed row is settled, not stuck.
    expect(gateReady(specs, statuses)).toBe(true)
    expect(progressOf(specs, statuses)).toBe(1)
    warn.mockRestore()
  })

  it('reddens a row whose work answered but did not land, rather than ticking it', async () => {
    await runBootSequence([{ id: 'captions', run: () => ({ ok: false, detail: 'not ready' }), timeoutMs: 50 }])
    expect(useBootLedger.getState().statuses.captions).toEqual({ state: 'failed', detail: 'not ready' })
  })
})

describe('the backstops', () => {
  it('gives a gating row less patience than the card hard cap', () => {
    // Or the cap would be what ends every broken boot, with the bar short of 100
    // and no row saying which one never answered.
    expect(STEP_TIMEOUT_MS).toBeLessThan(HARD_CAP_MS)
    // And more than warmPreview's own 6s poll, or a healthy warm-up would be cut
    // short and called a failure.
    expect(STEP_TIMEOUT_MS).toBeGreaterThan(6000)
  })

  it('lets the rows that never gate run far past the life of the card', () => {
    // A 75 to 100MB model download and a multi-gigabyte transcode are slow, not
    // broken. The backstop is there so nothing can hang for the whole session.
    expect(BACKGROUND_STEP_TIMEOUT_MS).toBeGreaterThan(HARD_CAP_MS * 10)
    for (const task of bootTasks(skippedWork(), true)) {
      const spec = BOOT_STEPS.find((s) => s.id === task.id)!
      expect(task.timeoutMs).toBe(spec.optional ? BACKGROUND_STEP_TIMEOUT_MS : STEP_TIMEOUT_MS)
    }
  })

  it('started() only silences the gap, it still hands the rejection on', async () => {
    // Work is kicked off seconds before its row picks it up. Without the silencer
    // an early failure is an unhandled rejection; with it swallowing the error the
    // row would tick green over work that failed.
    await expect(started(Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })
})
