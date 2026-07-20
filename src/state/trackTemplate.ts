// Track-setup presets: most videos want the same track layout, so the owner can
// bookmark the ACTIVE sequence's tracks (count, kinds, names, and the per-track
// audio settings volumeDb / pan / autoLevel / audioRole) under a NAME, keep as
// many of those presets as he likes, and flag ONE of them as the layout every
// NEW project or sequence starts from instead of the stock V1/V2/A1/A2.
// Persisted in localStorage so they survive across projects and sessions.
// muted/solo are session toggles and locked is a safety latch, so none of them
// travel with a preset.
//
// This replaces an earlier single anonymous template stored under LEGACY_KEY.
// That one entry is adopted as a preset named "Default" the first time this
// module reads storage, so nobody loses a setup they already saved.

import { activeSequence, newTrack, type AutoLevel, type Track } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

export interface TrackTemplateEntry {
  kind: Track['kind']
  name: string
  volumeDb: number
  pan: number
  autoLevel?: AutoLevel
  audioRole?: 'voice' | 'music'
}

export interface TrackPreset {
  id: string
  name: string
  tracks: TrackTemplateEntry[]
}

/** The whole bookmark shelf: the presets plus which one seeds new videos. */
interface PresetStore {
  presets: TrackPreset[]
  /** null = new videos keep the stock layout. */
  defaultId: string | null
}

const KEY = 'reel:track-presets'
const LEGACY_KEY = 'reel:track-template'

/** Newest-wins cap, so a runaway save loop cannot fill the origin's quota. */
const MAX_PRESETS = 24

const AUTO_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high']
const AUDIO_ROLES: readonly string[] = ['voice', 'music']

const EMPTY: PresetStore = { presets: [], defaultId: null }

let counter = 0
/** Ids outlive the session (they are persisted), so they carry a time part. */
const freshId = (): string => `tkp-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** A layout is all-or-nothing: one malformed entry rejects the whole thing
 * (a partial layout would silently drop tracks the user expects). */
function sanitize(raw: unknown): TrackTemplateEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const entries: TrackTemplateEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const { kind, name, volumeDb, pan, autoLevel, audioRole } = item as Record<string, unknown>
    if (kind !== 'video' && kind !== 'audio') return null
    if (typeof name !== 'string') return null
    if (typeof volumeDb !== 'number' || !Number.isFinite(volumeDb)) return null
    if (typeof pan !== 'number' || !Number.isFinite(pan)) return null
    entries.push({
      kind,
      name,
      volumeDb,
      pan,
      ...(typeof autoLevel === 'string' && AUTO_LEVELS.includes(autoLevel)
        ? { autoLevel: autoLevel as AutoLevel }
        : {}),
      ...(typeof audioRole === 'string' && AUDIO_ROLES.includes(audioRole)
        ? { audioRole: audioRole as 'voice' | 'music' }
        : {}),
    })
  }
  return entries
}

/** Unlike the entries inside one preset, a corrupt preset is dropped ALONE:
 * one bad row must not cost the owner the rest of his shelf. */
function sanitizePreset(raw: unknown): TrackPreset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, name, tracks } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '') return null
  if (typeof name !== 'string' || name === '') return null
  const entries = sanitize(tracks)
  return entries ? { id, name, tracks: entries } : null
}

function persist(store: PresetStore): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    /* private mode / quota: the presets just will not persist */
  }
}

/**
 * Adopt the pre-presets single template as a preset named "Default" and retire
 * the old key. Only ever runs while KEY is absent, so it cannot resurrect a
 * setup the owner has since deleted.
 */
function migrateLegacy(): PresetStore {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    return EMPTY
  }
  if (raw === null) return EMPTY
  let entries: TrackTemplateEntry[] | null = null
  try {
    entries = sanitize(JSON.parse(raw))
  } catch {
    /* corrupt legacy blob: nothing to carry over, but still retire the key */
  }
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* best effort */
  }
  if (!entries) return EMPTY
  const adopted: TrackPreset = { id: freshId(), name: 'Default', tracks: entries }
  const store: PresetStore = { presets: [adopted], defaultId: adopted.id }
  persist(store)
  return store
}

/** The shelf as stored, with a dangling defaultId healed to null. */
function readStore(): PresetStore {
  try {
    if (typeof localStorage === 'undefined') return EMPTY
    const raw = localStorage.getItem(KEY)
    if (raw === null) return migrateLegacy()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return EMPTY
    const list = Array.isArray(parsed.presets) ? parsed.presets : []
    const presets = list.map(sanitizePreset).filter((p): p is TrackPreset => p !== null)
    const rawDefault = typeof parsed.defaultId === 'string' ? parsed.defaultId : null
    return { presets, defaultId: presets.some((p) => p.id === rawDefault) ? rawDefault : null }
  } catch {
    return EMPTY
  }
}

/** Every saved preset, oldest first. */
export function listTrackPresets(): TrackPreset[] {
  return readStore().presets
}

/** Which preset new videos start from, or null when none is flagged. */
export function defaultTrackPresetId(): string | null {
  return readStore().defaultId
}

/** The preset new videos start from, or null. */
export function getDefaultTrackPreset(): TrackPreset | null {
  const { presets, defaultId } = readStore()
  return presets.find((p) => p.id === defaultId) ?? null
}

/** Flag which preset seeds new videos; null means "back to the stock layout". */
export function setDefaultTrackPreset(id: string | null): void {
  const store = readStore()
  const next = id !== null && store.presets.some((p) => p.id === id) ? id : null
  if (next === store.defaultId) return
  persist({ ...store, defaultId: next })
  const preset = store.presets.find((p) => p.id === next)
  useToasts
    .getState()
    .show(
      preset ? `New videos start from "${preset.name}"` : 'New videos use the default tracks',
      'success',
    )
}

/**
 * Capture the active sequence's track layout as a NAMED preset. Saving over an
 * existing name updates that preset in place (keeping its id, so a default flag
 * pointing at it survives). The very first preset becomes the default, because
 * bookmarking a setup and having new videos ignore it would be a surprise.
 * Returns the stored preset, or null when the name was blank.
 */
export function saveTrackPresetFromCurrent(name: string): TrackPreset | null {
  const clean = name.trim()
  if (clean === '') return null
  const seq = activeSequence(useStore.getState().project)
  const tracks: TrackTemplateEntry[] = seq.tracks.map((t) => ({
    kind: t.kind,
    name: t.name,
    volumeDb: t.volumeDb,
    pan: t.pan,
    ...(t.autoLevel !== undefined ? { autoLevel: t.autoLevel } : {}),
    ...(t.audioRole !== undefined ? { audioRole: t.audioRole } : {}),
  }))
  const store = readStore()
  const existing = store.presets.find((p) => p.name === clean)
  const preset: TrackPreset = { id: existing ? existing.id : freshId(), name: clean, tracks }
  const presets = existing
    ? store.presets.map((p) => (p.id === preset.id ? preset : p))
    : [...store.presets, preset].slice(-MAX_PRESETS)
  const defaultId = store.defaultId ?? preset.id
  // slice() above can evict the oldest preset, which may have held the flag.
  persist({ presets, defaultId: presets.some((p) => p.id === defaultId) ? defaultId : null })
  useToasts.getState().show(`Track setup saved as "${clean}"`, 'success')
  return preset
}

export function removeTrackPreset(id: string): void {
  const store = readStore()
  const preset = store.presets.find((p) => p.id === id)
  if (!preset) return
  const presets = store.presets.filter((p) => p.id !== id)
  persist({ presets, defaultId: store.defaultId === id ? null : store.defaultId })
  useToasts.getState().show(`Removed "${preset.name}"`)
}

/** Does this track already match the entry? Then reuse it (and its clips) as-is. */
function matches(track: Track, e: TrackTemplateEntry): boolean {
  return (
    track.name === e.name &&
    track.volumeDb === e.volumeDb &&
    track.pan === e.pan &&
    track.autoLevel === e.autoLevel &&
    track.audioRole === e.audioRole
  )
}

function applyEntry(base: Track, e: TrackTemplateEntry): Track {
  const next: Track = { ...base, name: e.name, volumeDb: e.volumeDb, pan: e.pan }
  // Explicit delete, not a spread: an entry WITHOUT autoLevel/audioRole means
  // "off", and spreading base would keep whatever the track had.
  if (e.autoLevel !== undefined) next.autoLevel = e.autoLevel
  else delete next.autoLevel
  if (e.audioRole !== undefined) next.audioRole = e.audioRole
  else delete next.audioRole
  return next
}

/**
 * Reshape the ACTIVE sequence to a preset in ONE undo step: entries are paired
 * with the existing tracks of the same kind in order, so a matched track keeps
 * its id and its CLIPS and only takes the preset's name/volume/pan/autoLevel/
 * audioRole. Extra entries mint fresh tracks.
 *
 * Surplus tracks are removed only while they are EMPTY. A preset is a layout
 * bookmark, not a delete button, and silently dropping a track that still holds
 * the owner's footage is not something an undo step makes acceptable.
 */
export function applyTrackPreset(id: string): void {
  const preset = readStore().presets.find((p) => p.id === id)
  if (!preset) return
  updateActiveSequence(`Apply track setup "${preset.name}"`, (seq) => {
    let changed = false
    const build = (kind: Track['kind']): Track[] => {
      const wanted = preset.tracks.filter((e) => e.kind === kind)
      const have = seq.tracks.filter((t) => t.kind === kind)
      const out = wanted.map((e, i) => {
        const base = have[i]
        if (base && matches(base, e)) return base
        changed = true
        return applyEntry(base ?? newTrack(e.kind, e.name), e)
      })
      for (const t of have.slice(wanted.length)) {
        if (t.clips.length === 0) changed = true
        else out.push(t)
      }
      return out
    }
    const tracks = [...build('video'), ...build('audio')]
    return changed ? { ...seq, tracks } : seq
  })
  useToasts.getState().show(`Track setup "${preset.name}" applied`, 'success')
}

/**
 * Tracks for a brand-new sequence: built from the DEFAULT preset when one is
 * flagged, otherwise the stock defaults passed in (same reference, so callers
 * can skip a rebuild). Every call mints fresh ids and empty clips: tracks are
 * never shared between sequences.
 */
export function applyTemplateTracks(defaults: Track[]): Track[] {
  const preset = getDefaultTrackPreset()
  if (!preset) return defaults
  return preset.tracks.map((e) => ({
    ...newTrack(e.kind, e.name),
    volumeDb: e.volumeDb,
    pan: e.pan,
    ...(e.autoLevel !== undefined ? { autoLevel: e.autoLevel } : {}),
    ...(e.audioRole !== undefined ? { audioRole: e.audioRole } : {}),
  }))
}
