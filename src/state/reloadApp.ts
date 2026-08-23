// Reloading the app, from the button or from F5.
//
// ⛔ ONE IMPLEMENTATION, TWO WAYS IN. His ask, 2026-08-23: *"Let's make F5 a
// button that refreshes the app."* F5 must do exactly what the melon does, which
// is NOT `window.location.reload()`: it asks main for an update check first, and
// then refuses to reload if that check turned one up, because reloading on top of
// a found update throws away the toast and restarts the renderer underneath a
// download that is already running. A second copy of that rule would drift from
// this one the first time either changed.

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
  window.location.reload()
}
