// The loading card's ledger of what the app is doing before it opens.
//
// Every row is driven by REAL work landing (a resolved promise, an IPC answer),
// never by a timer pretending to be progress. That is the whole point of it:
// *"it says the progress of what it is loading ... so we 100% know it did the
// stuff it needed to do."* A bar that just animates to 100% would prove nothing,
// so there isn't one; if a row says "Project opened", the project is open.
//
// The pure functions here (progress, labels, the gate) are unit-tested; the store
// is a thin imperative shell so `main.tsx`, which runs before React mounts, can
// report steps without importing React.

import { create } from 'zustand'

export type BootStepId = 'settings' | 'project' | 'media' | 'fonts' | 'integrity' | 'backups' | 'updates'

export type BootStepState = 'pending' | 'active' | 'done' | 'failed'

export interface BootStepSpec {
  id: BootStepId
  /** Present tense, shown while the work runs. */
  active: string
  /** Past tense, shown once it landed: a glance proves it happened. */
  done: string
  /** Desktop shell only: the browser build has no installer to update. */
  electronOnly?: boolean
  /**
   * Never gates the boot. The update check is a network call, and an editor that
   * will not open on bad wifi is a far worse failure than one that opens before
   * it knows, so the card shows the check and moves on without it.
   */
  optional?: boolean
}

/** In display order. This order is also the order the work is kicked off in `main.tsx`. */
export const BOOT_STEPS: readonly BootStepSpec[] = [
  { id: 'settings', active: 'Loading your settings', done: 'Settings loaded' },
  { id: 'project', active: 'Opening your last project', done: 'Project opened' },
  { id: 'media', active: 'Finding your media', done: 'Media ready' },
  { id: 'fonts', active: 'Loading fonts', done: 'Fonts loaded' },
  { id: 'integrity', active: 'Checking your files', done: 'Files checked' },
  { id: 'backups', active: 'Arming auto-backup', done: 'Auto-backup on' },
  { id: 'updates', active: 'Checking for updates', done: 'Checked for updates', electronOnly: true, optional: true },
]

export interface BootStepStatus {
  state: BootStepState
  /** A short extra fact for this row ("up to date", "42%"), appended to its label. */
  detail?: string
}

export type BootStatuses = Partial<Record<BootStepId, BootStepStatus>>

/**
 * How long the card stays up at minimum. His call, 2026-07-27: *"make the loading
 * time longer, just for the effect, like five seconds, cuz I barely see it."* The
 * real work lands in well under a second, so most of this is a brand moment rather
 * than a wait for anything.
 *
 * What it must never become is fake progress. The rows still tick only when real
 * work lands, and once everything has, the line reads "Ready" rather than
 * dribbling out invented steps to fill the time.
 */
export const MIN_CARD_MS = 4000
/** A row that never answers can never trap him on the card. Above the 8s ceiling. */
export const HARD_CAP_MS = 12_000
/**
 * Extra grace for the optional (network) rows once the local work is done. Small,
 * because the floor above already gives the update check five seconds to answer.
 */
export const OPTIONAL_GRACE_MS = 1000
/** The card's exit, before the melon takes over. Must match LoadingCard.module.css. */
export const CARD_EXIT_MS = 300

/** The rows this build actually shows. */
export function stepsFor(isElectron: boolean): BootStepSpec[] {
  return BOOT_STEPS.filter((s) => isElectron || !s.electronOnly)
}

/**
 * The `?boot=` verification override: `hold` freezes the loading card for a
 * screenshot, `melon` jumps to the screen it opens into, `show` runs the real
 * sequence end to end. Each one also switches off the automation skip, which is
 * the only way a driven browser can see the boot screen at all. Pure, so the
 * parsing is unit-tested rather than assumed.
 */
export type BootOverride = 'hold' | 'melon' | 'show' | null

export function bootOverride(search: string): BootOverride {
  const v = new URLSearchParams(search).get('boot')
  return v === 'hold' || v === 'melon' || v === 'show' ? v : null
}

export function statusOf(statuses: BootStatuses, id: BootStepId): BootStepStatus {
  return statuses[id] ?? { state: 'pending' }
}

const isSettled = (s: BootStepState): boolean => s === 'done' || s === 'failed'

/** 0..1 over the shown rows. A failed row counts as settled: it is finished, just not well. */
export function progressOf(specs: readonly BootStepSpec[], statuses: BootStatuses): number {
  if (specs.length === 0) return 1
  const settled = specs.filter((s) => isSettled(statusOf(statuses, s.id).state)).length
  return settled / specs.length
}

/** One row's own text: past tense once it landed, with any detail appended. */
export function labelOf(spec: BootStepSpec, status: BootStepStatus): string {
  if (status.state === 'failed') return `${spec.active}: ${status.detail ?? 'failed'}`
  const base = status.state === 'done' ? spec.done : spec.active
  return status.detail ? `${base}: ${status.detail}` : base
}

/**
 * The single line in the card's footer, Vegas-style: what is happening right
 * now, or (when nothing is in flight) the furthest-along row that has settled,
 * so the line is never blank and never claims work that isn't happening.
 */
export function statusLine(specs: readonly BootStepSpec[], statuses: BootStatuses): string {
  const active = specs.find((s) => statusOf(statuses, s.id).state === 'active')
  if (active) return labelOf(active, statusOf(statuses, active.id))
  // Everything landed, and the card is still up because the floor has not passed.
  // "Ready" is the truth and reads better than repeating the last step, BUT only
  // when there is nothing wrong: a failure stays on the line, because the whole
  // point of this screen is that it does not paper over what did not work.
  if (specs.length > 0 && allSettled(specs, statuses)) {
    const failed = specs.find((s) => statusOf(statuses, s.id).state === 'failed')
    return failed ? labelOf(failed, statusOf(statuses, failed.id)) : 'Ready'
  }
  const settled = specs.filter((s) => isSettled(statusOf(statuses, s.id).state))
  const last = settled.at(-1)
  if (last) return labelOf(last, statusOf(statuses, last.id))
  return specs[0] ? specs[0].active : 'Starting up'
}

/** True when every GATING row has settled. The optional ones are not waited on. */
export function gateReady(specs: readonly BootStepSpec[], statuses: BootStatuses): boolean {
  return specs.filter((s) => !s.optional).every((s) => isSettled(statusOf(statuses, s.id).state))
}

/** True when everything, optional rows included, has settled. */
export function allSettled(specs: readonly BootStepSpec[], statuses: BootStatuses): boolean {
  return specs.every((s) => isSettled(statusOf(statuses, s.id).state))
}

interface BootLedger {
  statuses: BootStatuses
  begin(id: BootStepId, detail?: string): void
  note(id: BootStepId, detail: string): void
  finish(id: BootStepId, detail?: string): void
  fail(id: BootStepId, detail?: string): void
  /** Fail a row ONLY if it hasn't already landed: a late error can't un-finish real work. */
  failUnfinished(id: BootStepId, detail?: string): void
  reset(): void
}

const set1 = (statuses: BootStatuses, id: BootStepId, next: BootStepStatus): BootStatuses => ({
  ...statuses,
  [id]: next,
})

export const useBootLedger = create<BootLedger>((set) => ({
  statuses: {},
  begin: (id, detail) => set((s) => ({ statuses: set1(s.statuses, id, { state: 'active', detail }) })),
  // Keeps the row running but updates its fact (a download percentage, say).
  note: (id, detail) =>
    set((s) => ({ statuses: set1(s.statuses, id, { state: statusOf(s.statuses, id).state, detail }) })),
  finish: (id, detail) => set((s) => ({ statuses: set1(s.statuses, id, { state: 'done', detail }) })),
  fail: (id, detail) => set((s) => ({ statuses: set1(s.statuses, id, { state: 'failed', detail }) })),
  failUnfinished: (id, detail) =>
    set((s) =>
      isSettled(statusOf(s.statuses, id).state) ? s : { statuses: set1(s.statuses, id, { state: 'failed', detail }) },
    ),
  reset: () => set({ statuses: {} }),
}))

/**
 * Imperative handle for `main.tsx`, which runs before React exists. Deliberately
 * total: a step that is never reported simply stays pending, and the hard cap
 * still opens the app.
 */
export const bootStep = {
  begin: (id: BootStepId, detail?: string): void => useBootLedger.getState().begin(id, detail),
  note: (id: BootStepId, detail: string): void => useBootLedger.getState().note(id, detail),
  finish: (id: BootStepId, detail?: string): void => useBootLedger.getState().finish(id, detail),
  fail: (id: BootStepId, detail?: string): void => useBootLedger.getState().fail(id, detail),
  failUnfinished: (id: BootStepId, detail?: string): void => useBootLedger.getState().failUnfinished(id, detail),
}

// Dev-only handle so the screenshot script can walk the rows through their states
// and verify the styling of each one. Never present in a build he runs.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__bootLedger = bootStep
}

/**
 * Wrap a real startup promise in its row. Failure is reported, never thrown on:
 * the boot screen's job is to open the editor, not to become the error.
 */
export function trackBootStep<T>(id: BootStepId, work: Promise<T>, doneDetail?: string): Promise<T | null> {
  bootStep.begin(id)
  return work.then(
    (v) => {
      bootStep.finish(id, doneDetail)
      return v
    },
    (err: unknown) => {
      console.warn(`OL Premiere boot: ${id} failed`, err)
      bootStep.fail(id)
      return null
    },
  )
}
