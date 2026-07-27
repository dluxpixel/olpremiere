// The running app version + the "was I just updated?" check that powers the
// post-update notification. Kept tiny and pure so the decision is unit-tested
// without a DOM.

/** The build's version, injected from package.json at build time (see vite configs). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

/** localStorage key holding the version the user last opened. */
export const LAST_SEEN_VERSION_KEY = 'olpremiere:lastSeenVersion'

export type UpdateCheck =
  /** First launch ever (or storage cleared): nothing to announce, just record. */
  | { kind: 'first-run'; version: string }
  /** Re-opened the same version: no change. */
  | { kind: 'unchanged'; version: string }
  /** The version changed since last launch, so the app was updated. */
  | { kind: 'updated'; from: string; to: string }

/**
 * Decide whether the app was updated since the user last opened it, from the
 * stored last-seen version and the current one. Pure: the caller owns reading
 * `lastSeen` and persisting `current` afterward.
 *
 * A version is only "updated" when it actually DIFFERS from a real prior value:
 * a first-ever run (no stored value) is never announced, and re-opening the same
 * build is silent. Any change (up or down, since a rollback still counts) is reported,
 * so the notification never lies about the running build.
 */
export function checkForUpdate(lastSeen: string | null, current: string): UpdateCheck {
  if (!lastSeen) return { kind: 'first-run', version: current }
  if (lastSeen === current) return { kind: 'unchanged', version: current }
  return { kind: 'updated', from: lastSeen, to: current }
}
