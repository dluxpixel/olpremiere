// Export presets: a name, the export setting it remembers and its own folder.
//
// His words, 2026-10-11: *"I think you should make save repositories. For
// example, when I click Export, it asks me what preset, and when I click, for
// example, Gym Preset, it exports the finished video to a specific folder where
// it pops up that option for me."*
//
// WHERE THEY LIVE. In the app's own preferences, not in a project, so they
// survive a restart and work in every project. One localStorage key holding the
// whole list as JSON, listed in PREFS_KEYS (prefsHome.ts), so the same change
// that saves any other preference also writes it to `Preferences.json` beside his
// project files, and a wiped profile gets it back. No second store.
//
// WHAT A PRESET REMEMBERS. The export window offers exactly one choice today,
// Platform loudness (engine/export/exportPlan.ts: "one button, no settings"), so
// that is the setting a preset carries. More would be invented. The folder is
// null until the first export with the preset asks for it.
//
// NO BUILT IN PRESETS. The list starts empty.

import { create } from 'zustand'
import { notePrefsChanged } from './prefsSignal'

export interface ExportPreset {
  id: string
  /** What he calls it, shown in the list. A label only, never part of a file name. */
  name: string
  /** Where its videos go. Null until the first export with it picks one. */
  folder: string | null
  /** The one export setting the window offers. */
  platformLoudness: boolean
}

/** The one place the list is stored, and the key prefsHome.ts carries to the file. */
export const EXPORT_PRESETS_KEY = 'olpremiere:export-presets'

export const PRESET_NAME_MAX = 40

/** A name as he typed it, tidied: one space between words, no edge spaces, cut to length. Empty when blank. */
export function cleanPresetName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Control characters (tabs, newlines, escapes) become spaces, then runs of spaces become one.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim()
}

/** `name` when no other preset has it, else `name 2`, `name 3` and on. Compared without regard to case. */
export function uniquePresetName(name: string, others: readonly string[]): string {
  const taken = new Set(others.map((n) => n.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; n < 10_000; n++) {
    const next = `${name} ${n}`
    if (!taken.has(next.toLowerCase())) return next
  }
  return `${name} ${Date.now()}`
}

let counter = 0
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // Falls through to the counter.
  }
  counter++
  return `preset-${Date.now().toString(36)}-${counter}`
}

/**
 * The stored text as a list. It is untrusted: a hand edit, a damaged file or a
 * newer build can leave anything there, so every field is checked and a row that
 * is not a preset is dropped on its own without losing the rest.
 */
export function parsePresets(text: string | null): ExportPreset[] {
  if (!text) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: ExportPreset[] = []
  const ids = new Set<string>()
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const name = cleanPresetName(r.name)
    if (!name || typeof r.id !== 'string' || r.id === '' || ids.has(r.id)) continue
    ids.add(r.id)
    out.push({
      id: r.id,
      name: uniquePresetName(name, out.map((p) => p.name)),
      folder: typeof r.folder === 'string' && r.folder.trim() !== '' ? r.folder : null,
      // On unless he turned it off, like the setting it copies (settings.ts).
      platformLoudness: r.platformLoudness !== false,
    })
  }
  return out
}

function readStored(): ExportPreset[] {
  try {
    return typeof localStorage !== 'undefined' ? parsePresets(localStorage.getItem(EXPORT_PRESETS_KEY)) : []
  } catch {
    return []
  }
}

export const useExportPresets = create<{ presets: ExportPreset[] }>(() => ({ presets: readStored() }))

/** Keep the new list in memory and in the preferences. An empty list is not stored: it is the default. */
function commit(presets: ExportPreset[]): void {
  useExportPresets.setState({ presets })
  try {
    if (typeof localStorage === 'undefined') return
    if (presets.length === 0) localStorage.removeItem(EXPORT_PRESETS_KEY)
    else localStorage.setItem(EXPORT_PRESETS_KEY, JSON.stringify(presets))
    notePrefsChanged()
  } catch {
    // Private mode or no room: the list still applies for this run.
  }
}

const current = (): ExportPreset[] => useExportPresets.getState().presets

/** Make a preset from the settings as they are now. Null for a blank name. */
export function createPreset(name: string, platformLoudness: boolean, folder: string | null = null): ExportPreset | null {
  const clean = cleanPresetName(name)
  if (!clean) return null
  const preset: ExportPreset = {
    id: newId(),
    name: uniquePresetName(clean, current().map((p) => p.name)),
    folder: folder && folder.trim() !== '' ? folder : null,
    platformLoudness,
  }
  commit([...current(), preset])
  return preset
}

/** Rename. A blank name changes nothing. Returns whether it changed. */
export function renamePreset(id: string, name: string): boolean {
  const clean = cleanPresetName(name)
  const list = current()
  const at = list.findIndex((p) => p.id === id)
  if (!clean || at < 0) return false
  const others = list.filter((p) => p.id !== id).map((p) => p.name)
  const next = uniquePresetName(clean, others)
  if (list[at].name === next) return false
  commit(list.map((p) => (p.id === id ? { ...p, name: next } : p)))
  return true
}

/** Change the settings it remembers. */
export function updatePresetSettings(id: string, settings: { platformLoudness: boolean }): void {
  const list = current()
  if (!list.some((p) => p.id === id)) return
  commit(list.map((p) => (p.id === id ? { ...p, platformLoudness: settings.platformLoudness } : p)))
}

/** Change its folder. Null forgets it, so the next export asks again. */
export function setPresetFolder(id: string, folder: string | null): void {
  const list = current()
  if (!list.some((p) => p.id === id)) return
  const next = folder && folder.trim() !== '' ? folder : null
  commit(list.map((p) => (p.id === id ? { ...p, folder: next } : p)))
}

export function deletePreset(id: string): void {
  const list = current()
  if (!list.some((p) => p.id === id)) return
  commit(list.filter((p) => p.id !== id))
}

export const findPreset = (id: string | null | undefined): ExportPreset | undefined =>
  id ? current().find((p) => p.id === id) : undefined

/** Read the list again, after the preferences file put it back (prefsHome.ts). */
export function reloadExportPresets(): void {
  useExportPresets.setState({ presets: readStored() })
}
