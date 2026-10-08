// Closing the editor waits for his last edit to be written. Pure, with no
// 'electron' import, so the rule is unit tested without a window.
//
// ⛔ WHY: before 2026-10-06 nothing waited. A close (his X, or an update
// restart, which closes the window the same way) tore the page down while the
// save of his last second or two of editing was still on its way. The page's
// pagehide started a write it could not finish: the app's store write MAY land,
// the file write in Documents never even started. Measured 2026-10-01 in his
// GYM, with that pagehide write already in the code: 27 characters typed, the
// app ended 300 ms after the last one, 6 came back.
//
// So a close of the editor is held, the page is asked to write everything, and
// the window goes only once it answers. If the page cannot write, he is asked.
// If the page never answers (hung, crashed), the window goes anyway after
// CLOSE_SAVE_TIMEOUT_MS, which is what every close did before this.
//
// ⛔ THE 'close' EVENT, NOT beforeunload. main.ts reads any page that refuses to
// unload as an export still running and asks about the export. That question
// still comes, on the second close, after the save.

/**
 * How long a close waits for the page's answer. A save is one store write and
 * one file write, well under a second on his machine; this is only for a page
 * that will never answer.
 */
export const CLOSE_SAVE_TIMEOUT_MS = 10_000

/**
 * The question a failed save asks before the window goes, in the words the
 * failure needs.
 *
 * ⛔ "LOST" ONLY WHEN THEY ARE. Before 2026-10-07 every failure said his changes
 * were lost if he closed, including the one where only the file in Documents
 * could not be written (OneDrive offline, a folder he cannot write to) and the
 * app's own store had every change. The toasts already said it right
 * (saveFailedMessage in src/state/persistence.ts); this is the same truth.
 */
export function notSavedDialog(onlyTheFile: boolean): { title: string; message: string; detail: string } {
  return onlyTheFile
    ? {
        title: 'Not saved to its file',
        message: 'Your last changes are saved in the app, but their file in Documents could not be written.',
        detail:
          'If you close now, the app still has them, only the file is behind. Stay, then use Back up to a file to keep a copy as a file too.',
      }
    : {
        title: 'Not saved',
        message: 'Your last changes could not be saved.',
        detail: 'If you close now, they are lost. Stay, then use Back up to a file to keep them.',
      }
}

export interface CloseGateDeps {
  /** Ask the page to write everything. It answers through `onReply`. */
  askToSave(): void
  /** Close the window for real. The gate lets this close through. */
  closeNow(): void
  /**
   * A write failed. Ask him: true means close anyway. `onlyTheFile`: the app's
   * store has every change and only the file in Documents was not written.
   */
  confirmCloseUnsaved(onlyTheFile: boolean): boolean
  /** He chose to stay, so anything waiting on this close stands down. */
  onStay(): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface CloseGate {
  /** The page said it will answer a close. Without this no close is held. */
  arm(on: boolean): void
  /** The window's 'close' event. True means hold it (preventDefault). */
  onClose(): boolean
  /**
   * The page's answer: true when every edit is written. `onlyTheFile` with a
   * false: the app's store has them all, only the file was not written.
   */
  onReply(saved: boolean, onlyTheFile?: boolean): void
  /**
   * The page went away (a reload, a crash). Nothing is left to wait for, so a
   * close already waiting goes now, and the next page has to arm again.
   */
  pageGone(): void
  /** The page refused to unload after all (he chose to keep an export running). */
  onCloseRefused(): void
}

export function createCloseGate(deps: CloseGateDeps): CloseGate {
  let armed = false
  let phase: 'open' | 'saving' | 'closing' = 'open'
  let timer: unknown = null

  const stopTimer = (): void => {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
  }
  const close = (): void => {
    stopTimer()
    phase = 'closing'
    deps.closeNow()
  }

  return {
    arm(on) {
      armed = on
    },
    onClose() {
      if (phase === 'closing' || !armed) return false
      if (phase === 'open') {
        phase = 'saving'
        timer = deps.setTimer(() => {
          timer = null
          if (phase === 'saving') close()
        }, CLOSE_SAVE_TIMEOUT_MS)
        deps.askToSave()
      }
      // A second click on the X while the save runs is the same close.
      return true
    },
    onReply(saved, onlyTheFile = false) {
      if (phase !== 'saving') return
      stopTimer()
      if (saved || deps.confirmCloseUnsaved(onlyTheFile)) {
        close()
        return
      }
      phase = 'open'
      deps.onStay()
    },
    pageGone() {
      armed = false
      if (phase === 'saving') close()
    },
    onCloseRefused() {
      if (phase === 'closing') phase = 'open'
    },
  }
}
