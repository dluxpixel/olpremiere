// A beforeunload guard for work the browser would silently destroy on close.
//
// Scoped to CRITICAL, non-recoverable operations like an in-flight export, whose
// minutes of compute and unsaved output vanish on a tab close. Ordinary edits
// are NOT guarded: autosave persists them within a debounce, so prompting on
// every close during that window would only annoy.
//
// A counter, not a boolean: two exports (or a future proxy build) can overlap,
// and the guard must stay armed until the last one finishes.

let criticalCount = 0
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
  let done = false
  return () => {
    if (done) return
    done = true
    criticalCount = Math.max(0, criticalCount - 1)
  }
}

/** Test/inspection helper: is the unload guard currently armed? */
export const isCriticalWorkInFlight = (): boolean => criticalCount > 0
