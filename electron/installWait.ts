// An update install waits for the editor window to close, and the close waits
// for his save (./closeGate). Pure, with no 'electron' import, so the order is
// unit tested without a window. main.ts's 'update:install' says why the window
// goes first.
//
// ⛔ ONE INSTALL AT A TIME, AND NOTHING COUNTS UNTIL THE SAVE IS BEHIND IT.
// Before 2026-10-07 every install request armed its own fallback timer the
// moment it was asked, and "Stay" stopped only the last one. Two requests (the
// Restart toast and the update card, or Restart anyway) and a failed save he
// chose to stay in: the first request's timer still ran the installer, which
// kills the window he had just kept, with his last changes unwritten. The
// fallback also counted while the Not saved question was open, so an answer
// that took longer than it skipped the settle after the window closed.

export interface InstallWaitDeps {
  /** Start the installer and quit (autoUpdater.quitAndInstall). */
  install(): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface InstallWait {
  /** An install was asked for. False when one is already on its way: this request is that one. */
  begin(): boolean
  /** True from begin until he stays, and for good once the installer has started. */
  pending(): boolean
  /**
   * The close gate let the window's close through: his save is behind it. Only
   * now does the fallback count, for a window that still will not close.
   */
  closeLetThrough(): void
  /** The editor window is gone. The installer starts after the settle. */
  windowClosed(): void
  /** He chose to stay in a close whose save failed: the update waits for another restart. */
  cancel(): void
}

export function createInstallWait(deps: InstallWaitDeps, timing: { flushMs: number; fallbackMs: number }): InstallWait {
  let phase: 'idle' | 'waiting' | 'installing' = 'idle'
  let fallback: unknown = null
  let settle: unknown = null

  const stopTimers = (): void => {
    if (fallback !== null) deps.clearTimer(fallback)
    if (settle !== null) deps.clearTimer(settle)
    fallback = null
    settle = null
  }
  const install = (): void => {
    if (phase !== 'waiting') return
    stopTimers()
    phase = 'installing'
    deps.install()
  }

  return {
    begin() {
      if (phase !== 'idle') return false
      phase = 'waiting'
      return true
    },
    pending: () => phase !== 'idle',
    closeLetThrough() {
      if (phase !== 'waiting' || fallback !== null || settle !== null) return
      fallback = deps.setTimer(() => {
        fallback = null
        install()
      }, timing.fallbackMs)
    },
    windowClosed() {
      if (phase !== 'waiting' || settle !== null) return
      if (fallback !== null) deps.clearTimer(fallback)
      fallback = null
      settle = deps.setTimer(() => {
        settle = null
        install()
      }, timing.flushMs)
    },
    cancel() {
      if (phase !== 'waiting') return
      stopTimers()
      phase = 'idle'
    },
  }
}
