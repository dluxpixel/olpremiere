// Carrying localStorage across the `reel` -> `olpremiere` rename.
//
// Renaming a storage key does not rename the DATA behind it: the old value stays
// parked under the old name and the app boots as though the user had never set
// anything. For preferences that is an annoyance; for `textPresets` and
// `track-presets` it is silently losing things the user MADE. So every renamed
// key is listed here and adopted once, on boot, before anything reads it.
//
// One list, one call site, because a per-module fallback would be twenty places to
// forget. Delete this module once it is certain no machine still holds `reel:`
// keys; nothing else depends on it.

/** new name -> the `reel:` name it used to live under. */
export const RENAMED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'olpremiere:lastSeenVersion': 'reel:lastSeenVersion',
  'olpremiere:collab:name': 'reel:collab:name',
  'olpremiere:zoomPresets': 'reel:zoomPresets',
  'olpremiere:quickstart': 'reel:quickstart',
  'olpremiere:audio:output-device': 'reel:audio:output-device',
  'olpremiere:captions:lang': 'reel:captions:lang',
  'olpremiere:captions:words': 'reel:captions:words',
  'olpremiere:captions:style': 'reel:captions:style',
  'olpremiere:settings:theme': 'reel:settings:theme',
  'olpremiere:settings:preview-quality': 'reel:settings:preview-quality',
  'olpremiere:settings:auto-keyframe': 'reel:settings:auto-keyframe',
  'olpremiere:textPresets': 'reel:textPresets',
  'olpremiere:track-presets': 'reel:track-presets',
  'olpremiere:track-template': 'reel:track-template',
  'olpremiere:recorder:input-device': 'reel:recorder:input-device',
  'olpremiere:recorder:monitor': 'reel:recorder:monitor',
  'olpremiere.layout.v1': 'reel.layout.v1',
})

/**
 * Move each legacy value to its new key, once. A key that already exists under
 * the new name wins and the legacy one is dropped: the new name is the source
 * of truth the moment it has ever been written.
 *
 * Never throws: localStorage can be unavailable (private mode, a locked-down
 * origin) and a rename is not worth failing a boot over.
 */
export function migrateRenamedKeys(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): number {
  let moved = 0
  for (const [next, legacy] of Object.entries(RENAMED_KEYS)) {
    try {
      const old = store.getItem(legacy)
      if (old === null) continue
      if (store.getItem(next) === null) {
        store.setItem(next, old)
        moved++
      }
      store.removeItem(legacy)
    } catch {
      // Quota or a blocked origin. Leave the legacy value where it is so a
      // later boot can try again, and never take the app down for this.
    }
  }
  return moved
}
