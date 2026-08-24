// A beforeunload guard for work the browser would silently destroy on close.
//
// Scoped to CRITICAL, non-recoverable operations like an in-flight export, whose
// minutes of compute and unsaved output vanish on a tab close. Ordinary edits
// are NOT guarded: autosave persists them within a debounce, so prompting on
// every close during that window would only annoy.
//
// A counter, not a boolean: two exports (or a future proxy build) can overlap,
// and the guard must stay armed until the last one finishes.
//
// There is a SECOND counter beside it, and the difference matters. Blocking the
// window from closing is a heavy thing to do: nothing asks him, the window
// simply refuses, so it is only right for work measured in minutes that he
// started and is watching. A voice take is just as destructible but it is not
// that: he may well want to close with an unkept take on screen, and an app that
// would not shut would be a worse bug than the one being fixed. So a HOLD says
// "do not restart under this" without saying "do not close".

let criticalCount = 0
let holdCount = 0
let installed = false

const onBeforeUnload = (e: BeforeUnloadEvent): void => {
  if (criticalCount <= 0) return
  // The modern + legacy incantation; browsers show their own generic text.
  e.preventDefault()
  e.returnValue = ''
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return
  window.addEventListener('beforeunload', onBeforeUnload)
  installed = true
}

/** Mark a critical operation in flight. Returns a disposer to call when it ends. */
export function beginCriticalWork(): () => void {
  ensureInstalled()
  criticalCount += 1
  publish()
  let done = false
  return () => {
    if (done) return
    done = true
    criticalCount = Math.max(0, criticalCount - 1)
    publish()
  }
}

/**
 * Mark work a restart would destroy, WITHOUT blocking the window from closing.
 *
 * ⛔ AN UPDATE USED TO RESTART THE APP IN THE MIDDLE OF A VOICE TAKE.
 * Updates apply themselves once the machine has gone quiet for five minutes,
 * and quiet is measured as no mouse and no keyboard. Talking into a microphone
 * is exactly that: he sits still and speaks, and five minutes in, the app saved
 * itself and relaunched, and the take was gone. The recording was never counted
 * as work, because the only thing that counted was an export.
 *
 * A held take counts too. It lives in memory until he keeps it, so a restart
 * while it sits there waiting for a yes or no loses it the same way.
 */
export function beginRestartHold(): () => void {
  holdCount += 1
  publish()
  let done = false
  return () => {
    if (done) return
    done = true
    holdCount = Math.max(0, holdCount - 1)
    publish()
  }
}

/** Test/inspection helper: is the unload guard currently armed? */
export const isCriticalWorkInFlight = (): boolean => criticalCount > 0

/** Would relaunching the app right now destroy something he cannot get back? */
export const isRestartUnsafe = (): boolean => criticalCount > 0 || holdCount > 0

/**
 * CRITICAL work only, which today means an export in flight.
 *
 * ⛔ NOT `isRestartUnsafe`, AND THE DIFFERENCE IS THE WHOLE POINT. That one also
 * counts HOLDS, and a hold is an unkept voice take: he is sitting looking at the
 * picture while it is up, so anything that stands the preview down under a hold
 * would break the thing he is watching.
 *
 * A critical operation is minutes of compute he started and is waiting on, and
 * during one the preview is competing with it for the same GPU and the same main
 * thread for nothing. His words, 2026-08-24: *"while exporting, it's just so
 * fucking laggy, everything."*
 */
export const isCriticalWorkRunning = (): boolean => criticalCount > 0

/**
 * Tell the desktop shell, so it does not even ASK.
 *
 * The renderer can refuse an update on its own, but main stops watching for a
 * quiet moment the instant it asks once, so a refusal used to leave the update
 * waiting for a click he was promised he would never have to make. Main holding
 * the same answer means it keeps waiting instead, and applies the update the
 * next time he really is away. Half of what this covers is invisible to main
 * anyway: an in-browser export and a microphone both live over here.
 */
let lastPublished: boolean | null = null
function publish(): void {
  const busy = isRestartUnsafe()
  if (busy === lastPublished) return
  lastPublished = busy
  try {
    ;(globalThis as { api?: { setUpdateBusy?: (on: boolean) => void } }).api?.setUpdateBusy?.(busy)
  } catch {
    // No desktop shell (web build), or an older preload. The renderer-side
    // refusal in App.tsx still holds on its own.
  }
}
