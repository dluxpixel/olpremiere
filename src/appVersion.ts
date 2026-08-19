// The running app version + the "was I just updated?" check that powers the
// post-update notification. Kept tiny and pure so the decision is unit-tested
// without a DOM.

/** The build's version, injected from package.json at build time (see vite configs). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

/**
 * The version as he wants to READ it.
 *
 * His call, 2026-07-28, looking at the boot card: *"it says version 0.1.21,
 * make it just 1.21."* The leading zero is semver's pre-1.0 marker and on his
 * own app it just reads as unfinished.
 *
 * His call, 2026-08-19, looking at v2.0.17: *"let's change the format of this
 * to 2.17 and when we do smaller updates, more like patch fixes, let's make it
 * 2.17.1 and so on when we do a bigger update, let's turn it into 2.18."* So an
 * ordinary release is `2.18`, a fix on top of it is `2.18.1`, and the trailing
 * `.0` that says "no fixes yet" is noise he should not have to read.
 *
 * ⛔ THIS IS A DISPLAY NAME AND NOTHING ELSE. The real version, the update feed,
 * the git tag and the installer filename all keep the true three part semver,
 * because electron-updater COMPARES those strings and a made up number there
 * would break updating outright. Every number he sees goes through here; every
 * number a machine reads never does.
 */
export function displayVersion(v: string = APP_VERSION): string {
  const noPreRelease = v.replace(/^0\./, '')
  // ⛔ ONLY A THREE PART VERSION LOSES ITS TRAILING ZERO. A bare `.replace(/\.0$/)`
  // turns the historical `0.2.0` into "2", because the leading strip has already
  // taken it down to two parts and there is nothing left to spare. Requiring
  // two segments in front is what keeps "2.17.0" reading as "2.17" and stops
  // anything reading as a single number.
  return noPreRelease.replace(/^(\d+\.\d+)\.0$/, '$1')
}

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
