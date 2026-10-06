// The export on his Windows taskbar button, so he sees it from any app.
//
// The whole point of Keep working (his ask, 2026-09-28) is that he is somewhere else while the file
// is made, often not in this app at all. So the taskbar button fills as it goes, turns red if it
// fails, and flashes once it ends while he is away. Pure, no electron import, so the test drives it
// with a stand-in window; main.ts hands it the real one.

import type { ExportTaskbarState } from './ipc-types'

/** The few BrowserWindow calls this needs. */
export interface TaskbarWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  setProgressBar(progress: number, options?: { mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused' }): void
  flashFrame(flag: boolean): void
  once(event: 'focus', listener: () => void): unknown
}

/** Flash the button until he comes back, then stop. Nothing to flash while he is looking. */
function flashIfAway(win: TaskbarWindow): void {
  if (win.isFocused()) return
  win.flashFrame(true)
  win.once('focus', () => {
    if (!win.isDestroyed()) win.flashFrame(false)
  })
}

export function showExportOnTaskbar(win: TaskbarWindow, state: ExportTaskbarState): void {
  if (win.isDestroyed()) return
  switch (state.kind) {
    case 'busy':
      // Getting ready and mixing the sound have no frame count yet: a moving bar, not a stuck 0.
      win.setProgressBar(1, { mode: 'indeterminate' })
      return
    case 'progress':
      win.setProgressBar(Math.min(1, Math.max(0, Number.isFinite(state.fraction) ? state.fraction : 0)), { mode: 'normal' })
      return
    case 'done':
      win.setProgressBar(-1)
      flashIfAway(win)
      return
    case 'failed':
      // Red stays until the app lets go of the failed export (he opened it or dismissed it).
      win.setProgressBar(1, { mode: 'error' })
      flashIfAway(win)
      return
    case 'clear':
      win.setProgressBar(-1)
      return
  }
}
