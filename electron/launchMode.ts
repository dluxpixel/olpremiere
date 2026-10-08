// Whether this start is one HE made, or one an update made while he was away. Pure,
// so it can be tested without an Electron window.
//
// ⛔ AN UPDATE THAT APPLIED ITSELF MUST NOT JUMP IN FRONT OF HIM, 2026-10-06. An update
// applies itself once the machine has had no input for five minutes (./updateApply),
// and the installer starts the new version on its own afterwards. That start used to
// be an ordinary launch: the always on top card in the middle of his main screen, then
// the melon taking the keyboard and staying on top of every window until clicked. Five
// quiet minutes is also a video he is watching, or a stream where he is talking. He did
// not start that launch, so it opens on the taskbar, minimized, and waits for him.
//
// A launch he made, and an update he clicked through himself, keep the card and the
// melon exactly as they are.

import { IDLE_APPLY_S } from './updateApply'

/** The marker main writes in userData when an update is applied while he is away. */
export const QUIET_START_FILE = 'quiet-start.json'

/**
 * How old a marker can be and still count. The installer runs in well under this, so
 * an older one is from an update that never finished, and a launch days later is his.
 */
export const QUIET_MARKER_MAX_AGE_MS = 10 * 60_000

export type LaunchMode = 'normal' | 'quiet'

/**
 * `'quiet'` only when BOTH say so: the installer started us (it passes `--updated`)
 * and main wrote the marker, recently, because he was away when the update applied.
 * `markerAt` is when the marker was written, or null when there is none.
 */
export function launchMode({ argv, markerAt, now }: { argv: readonly string[]; markerAt: number | null; now: number }): LaunchMode {
  if (!argv.includes('--updated')) return 'normal'
  if (markerAt === null || !Number.isFinite(markerAt)) return 'normal'
  const age = now - markerAt
  return age >= 0 && age <= QUIET_MARKER_MAX_AGE_MS ? 'quiet' : 'normal'
}

/** Was he away when the update was applied? The same five minutes that let it apply. */
export function appliedWhileAway(idleSeconds: number): boolean {
  return idleSeconds >= IDLE_APPLY_S
}

/** Read the marker's time from its text. Anything odd is no marker at all. */
export function parseQuietMarker(text: string | null): number | null {
  if (!text) return null
  try {
    const at = (JSON.parse(text) as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

/**
 * What a click on the app's icon does while this copy is running, and the click has
 * been handed to it (the single instance lock).
 *
 * ⛔ CLOSING WITH AN UPDATE WAITING, THEN OPENING AGAIN, DID NOTHING, 2026-10-06. With
 * an update downloaded, closing keeps this copy alive a moment with no window (the
 * settle before the installer, see window-all-closed in main), still holding the lock.
 * A click in that moment was handed here, found no window, and was dropped; then the
 * app installed itself silently and did not come back. About two releases a day makes
 * closing with an update waiting the usual case. Now that click asks for the new
 * version to open once it is installed.
 */
export function secondInstanceAction({
  hasWindow,
  quittingToInstall,
}: {
  hasWindow: boolean
  quittingToInstall: boolean
}): 'focus' | 'install-and-open' | 'ignore' {
  if (hasWindow) return 'focus'
  return quittingToInstall ? 'install-and-open' : 'ignore'
}
