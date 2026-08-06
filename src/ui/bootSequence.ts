// The ORDER the loading card's rows actually run in, and the promise that every
// one of them finishes.
//
// The rows are a claim about what the app is doing right now, and that claim is
// only worth something if the card matches the work. Two ways it stopped
// matching, both fixed here:
//
//  1. The work was kicked off in three places at once (the project chain, the
//     module top of `main.tsx`, and the update feed's IPC callback), so the LAST
//     row could be running while the rows above it had not started. What he saw
//     was two rows going at once with a grey one stranded between them.
//  2. Nothing guaranteed a row would ever settle. One audio decode that never
//     answered left its row 'active' for the life of the session, which parked
//     the bar at 7 of 8 gating rows, 88%, and took the rows after it down with
//     it: `proxies` never even started, so it stayed grey for ever.
//
// So: ONE runner, one row at a time, in the card's declared order, and every row
// either settles or is called unanswered. Work that has nothing to do settles as
// DONE ("nothing to warm"), because a row is not allowed to hang just because the
// project had nothing in it for that row to chew on.
//
// Starting the WORK and reporting the ROW are deliberately separate things. What
// does not depend on the project being open (the media library, the title fonts,
// the speech model) is started the moment the app loads and simply awaited when
// its turn comes, so ordering the card costs no wall-clock time.

import { BOOT_STEPS, bootStep, stepsFor, type BootStepId } from './bootProgress'

/** What a row's work reports back when it lands. */
export interface BootStepResult {
  /** False when the work genuinely did not land. An honest red beats a green lie. */
  ok?: boolean
  /** The short fact appended to the row ("6 ready", "nothing to warm"). */
  detail?: string
}

/** One row's real work. Never called until the row above it has settled. */
export type BootTaskRun = () => BootStepResult | void | Promise<BootStepResult | void>

/**
 * The work behind every row there is. A Record rather than a list on purpose: a
 * row added to the card with nothing driving it would sit pending for ever, and
 * this makes that a compile error instead of a bug he finds on the splash.
 */
export type BootWork = Record<BootStepId, BootTaskRun>

export interface BootTask {
  id: BootStepId
  run: BootTaskRun
  /** How long the row waits for its own work before it is called unanswered. */
  timeoutMs: number
}

/**
 * How long a GATING row waits. Above `warmPreview`'s own 6s poll so a healthy
 * warm-up is never cut short, and below the card's 12s hard cap so a row that
 * never answers goes red on the card rather than parking the bar for the rest of
 * the session.
 */
export const STEP_TIMEOUT_MS = 8000

/**
 * The same backstop for the rows that never gate. Deliberately far past the life
 * of the card: a first-ever caption model is a 75 to 100MB download and a big
 * import is minutes of ffmpeg, and neither of those is a failure. This number
 * exists only so that no row can stay 'active' for the whole session.
 */
export const BACKGROUND_STEP_TIMEOUT_MS = 300_000

/** Told apart from work that answered badly: this one never answered at all. */
export const NO_ANSWER = 'no answer'

/**
 * Start work NOW, report its row LATER.
 *
 * The card's order is a promise about what he is shown, not a reason to queue
 * independent work behind it. The no-op catch is what keeps an early rejection
 * from being reported as unhandled in the seconds before its row picks it up; the
 * original promise still rejects for whoever awaits it.
 */
export function started<T>(work: Promise<T>): Promise<T> {
  void work.catch(() => {})
  return work
}

/** Run one row: begin it, wait on it, and settle it whatever happens. */
async function settleStep(task: BootTask): Promise<void> {
  bootStep.begin(task.id)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // `run` is called HERE, synchronously, which is what lets the first row do
    // its work before React mounts (the theme stamp, see main.tsx).
    const work = started(Promise.resolve(task.run()))
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(NO_ANSWER)), task.timeoutMs)
      }),
    ])
    const { ok, detail } = result ?? {}
    if (ok === false) bootStep.fail(task.id, detail)
    else bootStep.finish(task.id, detail)
  } catch (err) {
    const unanswered = err instanceof Error && err.message === NO_ANSWER
    console.warn(`OL Premiere boot: ${task.id} ${unanswered ? 'never answered' : 'failed'}`, err)
    bootStep.fail(task.id, unanswered ? NO_ANSWER : undefined)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Walk the rows in order. Never rejects: a broken startup must still open the
 * editor, so a row that throws is reported and the sequence carries on to the
 * next one. That is the bug the old single `.catch()` had, where one thrown error
 * skipped every row it had not listed.
 *
 * The first task's work runs SYNCHRONOUSLY, before this returns.
 */
export async function runBootSequence(tasks: readonly BootTask[]): Promise<void> {
  for (const task of tasks) await settleStep(task)
}

/**
 * The card's rows, in the card's order, each paired with the work that proves it.
 *
 * Built from `stepsFor`, so the list the card draws and the list the runner walks
 * are the same list and cannot drift apart.
 */
export function bootTasks(work: BootWork, isElectron: boolean): BootTask[] {
  return stepsFor(isElectron).map((spec) => ({
    id: spec.id,
    run: work[spec.id],
    // The optional rows are exactly the ones that can honestly run for minutes.
    timeoutMs: spec.optional ? BACKGROUND_STEP_TIMEOUT_MS : STEP_TIMEOUT_MS,
  }))
}

/** Every row there is, in display order. Handy for tests and for exhaustive maps. */
export const ALL_BOOT_STEP_IDS: readonly BootStepId[] = BOOT_STEPS.map((s) => s.id)
