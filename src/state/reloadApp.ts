// Reloading the app, from the button or from F5.
//
// ⛔ ONE IMPLEMENTATION, TWO WAYS IN. His ask, 2026-08-23: *"Let's make F5 a
// button that refreshes the app."* F5 must do exactly what the melon does, which
// is NOT `window.location.reload()`: it asks main for an update check first, and
// then refuses to reload if that check turned one up, because reloading on top of
// a found update throws away the toast and restarts the renderer underneath a
// download that is already running. A second copy of that rule would drift from
// this one the first time either changed.

import { saveBeforeClose } from './persistence'
import { useToasts } from './toasts'
import { updateInHand, useUpdateFeed } from './updateStatus'

/**
 * Check for updates, then reload unless one was found.
 *
 * The check is asked for FIRST and runs in the main process, which outlives the
 * renderer, so the fresh renderer picks the answer up through the pull channel
 * instead of racing it. Never rejects: a shell that cannot answer still reloads.
 */
export async function reloadAndCheckForUpdates(): Promise<void> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  await Promise.resolve(api?.checkForUpdates?.()).catch(() => undefined)
  // Read fresh from the store rather than a closure: the answer arrives DURING
  // the promise above.
  if (updateInHand(useUpdateFeed.getState().status)) return
  // ⛔ EVERY EDIT IS WRITTEN BEFORE THE PAGE GOES. A reload throws the page away
  // like a close does, and the last second or two of editing used to go with it,
  // left to a write started while the page was being torn down. If the write
  // fails, the reload waits for him to say so.
  if (!(await saveBeforeClose())) {
    useToasts.getState().show('Could not save, so the app did not reload', 'danger', {
      label: 'Reload anyway',
      onClick: () => window.location.reload(),
    })
    return
  }
  window.location.reload()
}
