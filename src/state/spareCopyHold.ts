// Standing the 7 day spare copy cleanup down, the morning the store lost something.
//
// ⛔ A LOST STATE IS NOT A CLEAN ONE. On 2026-07-26 the media were in the store and
// the project record was never written: no file, no backup. The first edit saves
// the blank project, the next start sweeps the store's orphaned bytes, and the
// spare copies on disk are the last trace of that footage. That is how the
// 2026-08-23 recovery by hand worked. Without a hold the cleanup would start a 7
// day clock on them while the app said "Nothing was deleted".
//
// So a start that shows any sign of a loss asks main to stand the cleanup down for
// 30 days (electron/mediaSweep.ts holdSweep): the store opening with no projects,
// projects put back from their files, a project recovered from the backups.
//
// No imports on purpose: persistence.ts calls this, and it must not pull the
// cleanup's own imports in with it.

let heldWhy: string | null = null

interface HoldApi {
  mediaSweepHold?: (why: string) => Promise<boolean>
}

/** Stand the cleanup down: for the rest of this start here, and for 30 days in main. */
export function holdSpareCopyCleanup(why: string): void {
  heldWhy ??= why
  const api = (globalThis as { api?: HoldApi }).api
  if (typeof api?.mediaSweepHold !== 'function') return
  void api.mediaSweepHold(why).then(
    (ok) => {
      if (!ok) console.warn('OL Premiere: the spare copy cleanup hold could not be written; it holds for this start')
    },
    (err: unknown) => console.warn('OL Premiere: the spare copy cleanup could not be held', err),
  )
}

/** Why the cleanup stands down this start, or null. */
export function spareCopyCleanupHeld(): string | null {
  return heldWhy
}
