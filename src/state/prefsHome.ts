// His saved moves, his track setups and his settings, kept in a second home.
//
// ⛔ TWO HOMES, THE WAY CAPTION STYLES HAVE TWO (captionStyles.ts). localStorage
// is the quick copy every reader uses, and it sits in the same browser profile
// the engine has wiped under him four times since July. Caption styles were
// given a file beside his projects for exactly that reason; nothing else was, so
// after a wipe his projects came back from their files and the moves he
// performed and saved, the track setup new videos start from and every setting
// came back as nothing. Now every change to them is ALSO written to
// `Preferences.json` beside his project files (electron/preferencesFile.ts), and
// a launch whose quick copy is older than that file reads it back. Whichever
// copy was saved last wins, so an old file never undoes a change he just made.
//
// The values are kept exactly as their own modules store them, so each module
// still owns its shape and its checks: a file read back is untrusted text that
// goes through the same readers as the quick copy.

import { reloadExportPresets } from './exportPresets'
import { reloadSettings } from './settings'
import { onPrefsChanged } from './prefsSignal'
import { reloadStoredPrefs } from './store'
import { useToasts } from './toasts'

/** Every remembered preference this file carries, by its localStorage key. */
export const PREFS_KEYS = [
  'olpremiere:my-moves',
  'olpremiere:track-presets',
  'olpremiere:settings:theme',
  'olpremiere:settings:preview-quality',
  'olpremiere:settings:ease-seconds',
  'olpremiere:settings:platform-loudness',
  'olpremiere:settings:usage-log',
  'olpremiere:settings:safe-margins',
  'olpremiere:export-presets',
  'olpremiere:settings:app-guides',
  'olpremiere:settings:app-guides-app',
  'olpremiere:zoomAnchor',
  'olpremiere:moveCurve',
  'olpremiere:snapping',
] as const

/** The things he MADE. No default can stand in for these, so their return is said out loud. */
const MADE: readonly string[] = ['olpremiere:my-moves', 'olpremiere:track-presets']

/** When the quick copy last changed. It goes with a wipe, which is what makes the file newer. */
export const PREFS_SAVED_AT_KEY = 'olpremiere:prefs:savedAt'

/** What the file holds. `kind` and `version` let a reader refuse anything else. */
export interface PrefsSnapshot {
  kind: 'ol-premiere-preferences'
  version: 1
  savedAt: number
  /** Only the keys he has set: a setting at its default is not stored, here or there. */
  values: Record<string, string>
}

/** The desktop half: one file, read and written whole. */
export interface PrefsHomeApi {
  prefsWrite(json: string): Promise<void>
  /** Null only when there is no file. Rejects when there is one it could not read. */
  prefsRead(): Promise<string | null>
}

export function prefsHomeApi(): PrefsHomeApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  if (!api || typeof api.prefsWrite !== 'function' || typeof api.prefsRead !== 'function') return null
  return api
}

const KNOWN: ReadonlySet<string> = new Set(PREFS_KEYS)

/** The file's text as a snapshot, or null for anything that is not one. Unknown keys are dropped. */
export function parsePrefs(text: string | null): PrefsSnapshot | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<PrefsSnapshot>
    if (raw?.kind !== 'ol-premiere-preferences' || raw.version !== 1) return null
    if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) return null
    if (typeof raw.values !== 'object' || raw.values === null) return null
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.values)) if (KNOWN.has(k) && typeof v === 'string') values[k] = v
    return { kind: 'ol-premiere-preferences', version: 1, savedAt: raw.savedAt, values }
  } catch {
    return null
  }
}

/**
 * Which copy wins at launch. The file, when it holds something of his and was
 * saved after the quick copy: that is what a wiped profile looks like. Otherwise
 * the quick copy is the truth, and the file is brought up to it, but only when
 * there is something of his to write.
 *
 * ⛔ A LAUNCH WITH NOTHING OF HIS NEVER WRITES. A profile that came up empty must
 * not overwrite the one file that still holds his moves.
 */
export function prefsDecision(
  local: { values: Record<string, string>; savedAt: number },
  file: PrefsSnapshot | null,
): 'adopt-file' | 'write-file' | 'nothing' {
  if (file && Object.keys(file.values).length > 0 && file.savedAt > local.savedAt) return 'adopt-file'
  return Object.keys(local.values).length > 0 ? 'write-file' : 'nothing'
}

function readLocal(): { values: Record<string, string>; savedAt: number } {
  const values: Record<string, string> = {}
  let savedAt = 0
  try {
    for (const key of PREFS_KEYS) {
      const v = localStorage.getItem(key)
      if (v !== null) values[key] = v
    }
    const at = Number(localStorage.getItem(PREFS_SAVED_AT_KEY))
    if (Number.isFinite(at) && at > 0) savedAt = at
  } catch {
    // No storage at all: nothing of his here, so nothing is written over the file.
  }
  return { values, savedAt }
}

function writeHome(api: PrefsHomeApi, savedAt: number): void {
  const { values } = readLocal()
  try {
    localStorage.setItem(PREFS_SAVED_AT_KEY, String(savedAt))
  } catch {
    // The file still gets the change; the next launch just writes it again.
  }
  const snap: PrefsSnapshot = { kind: 'ol-premiere-preferences', version: 1, savedAt, values }
  void api.prefsWrite(JSON.stringify(snap)).catch((err: unknown) => {
    console.warn('OL Premiere: the preferences file could not be written', err)
  })
}

/** Make the quick copy exactly the file's, then have every reader read it again. */
function adopt(file: PrefsSnapshot): void {
  for (const key of PREFS_KEYS) {
    const v = file.values[key]
    if (v === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  }
  localStorage.setItem(PREFS_SAVED_AT_KEY, String(file.savedAt))
  reloadSettings()
  reloadExportPresets()
  reloadStoredPrefs()
}

let started = false
let homeTimer: ReturnType<typeof setTimeout> | undefined

/** A session that could not tell what is in the file leaves it alone. Said once, in the log. */
function leaveFileAlone(why: string, err?: unknown): void {
  console.warn(`OL Premiere: ${why}, so it is left as it is until the next launch`, err ?? '')
}

/**
 * Read the file back, keep whichever copy is newer, and keep the file current
 * from here on. Run once at launch, behind the card: nothing waits on it.
 *
 * ⛔ A SESSION THAT COULD NOT READ THE FILE NEVER WRITES IT. Not at launch and
 * not on a change. Before 2026-10-07 a read that failed counted as no file, so
 * on a wiped profile his first change of a setting wrote that one setting over
 * the file that still held his moves and track setups. The same goes for a file
 * this build cannot read (a newer build wrote it, or it is damaged) and for one
 * taken back only part way.
 */
export async function initPrefsHome(): Promise<void> {
  const api = prefsHomeApi()
  if (!api || started) return
  started = true
  let text: string | null
  try {
    text = await api.prefsRead()
  } catch (err) {
    leaveFileAlone('the preferences file is there but could not be read', err)
    return
  }
  const file = parsePrefs(text)
  // An empty file holds nothing of his, so it counts as none.
  if (!file && text !== null && text.trim() !== '') {
    leaveFileAlone('the preferences file is not one this version can read')
    return
  }
  const local = readLocal()
  const decision = prefsDecision(local, file)
  if (decision === 'adopt-file' && file) {
    try {
      adopt(file)
    } catch (err) {
      // The quick copy now holds part of the file. Written back, the part
      // would replace the whole.
      leaveFileAlone('the preferences file could not be read back in full', err)
      return
    }
    const cameBack = MADE.some((k) => local.values[k] === undefined && file.values[k] !== undefined)
    if (cameBack) useToasts.getState().show('Your saved moves and settings came back from their file', 'success')
  } else if (decision === 'write-file') {
    // The first launch with this file has no time for the quick copy: now will do.
    writeHome(api, local.savedAt || Date.now())
  }
  onPrefsChanged(() => {
    clearTimeout(homeTimer)
    homeTimer = setTimeout(() => writeHome(api, Date.now()), 300)
  })
}

/** Test seam: forget that the home was read, as a fresh launch would. */
export function resetPrefsHomeForTests(): void {
  started = false
  clearTimeout(homeTimer)
  onPrefsChanged(null)
}
