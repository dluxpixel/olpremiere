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
// ⛔ AND ASKS AGAIN AT EVERY START UNTIL MAIN SAYS IT IS WRITTEN. On the wipe
// morning a full drive (his is 97% full) can fail the hold file's write. Main then
// held for that run alone, and the next start, its store no longer empty after
// one edit, had nothing to set the hold again. So the reason waits in the page's
// own storage until main confirms the hold, and each start until then holds too.
//
// No imports on purpose: persistence.ts calls this, and it must not pull the
// cleanup's own imports in with it.

let heldWhy: string | null = null

/** A hold main has not confirmed yet: its reason, kept across starts. */
const PENDING_KEY = 'olpremiere:spareCopyHoldPending'

function pendingHold(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(PENDING_KEY)
  } catch {
    return null
  }
}

function keepPendingHold(why: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (why === null) localStorage.removeItem(PENDING_KEY)
    else localStorage.setItem(PENDING_KEY, why)
  } catch {
    // Private mode or a full disk: it still holds for this start.
  }
}

interface HoldApi {
  mediaSweepHold?: (why: string) => Promise<boolean>
}

/** Stand the cleanup down: for the rest of this start here, and for 30 days in main. */
export function holdSpareCopyCleanup(why: string): void {
  heldWhy ??= why
  const api = (globalThis as { api?: HoldApi }).api
  if (typeof api?.mediaSweepHold !== 'function') return
  // Kept BEFORE asking: a crash or a reload before main answers must not lose it.
  if (pendingHold() === null) keepPendingHold(why)
  const notWritten = (): void => {
    if (pendingHold() === null) keepPendingHold(why)
  }
  void api.mediaSweepHold(why).then(
    (ok) => {
      if (ok === true) {
        keepPendingHold(null)
        return
      }
      notWritten()
      console.warn('OL Premiere: the spare copy cleanup hold could not be written; it holds this start and is asked for again at the next')
    },
    (err: unknown) => {
      notWritten()
      console.warn('OL Premiere: the spare copy cleanup could not be held', err)
    },
  )
}

/**
 * At each start, before anything else: a hold an earlier start could not get
 * written is asked for again, and stands this start down too.
 */
export function resendSpareCopyHold(): void {
  const why = pendingHold()
  if (why) holdSpareCopyCleanup(why)
}

/** Why the cleanup stands down this start, or null. */
export function spareCopyCleanupHeld(): string | null {
  return heldWhy
}
