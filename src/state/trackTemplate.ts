// Track-setup template: most videos want the same track layout, so the owner
// can bookmark the ACTIVE sequence's tracks — count, kinds, names, and the
// per-track audio settings (volumeDb / pan / autoLevel / audioRole) — and every
// NEW project or sequence starts from that layout instead of the stock
// V1/V2/A1/A2. Persisted in localStorage so it survives across projects and
// sessions. muted/solo are session toggles and locked is a safety latch, so
// none of them travel with the template.

import { activeSequence, newTrack, type AutoLevel, type Track } from '../engine/types'
import { useStore } from './store'
import { useToasts } from './toasts'

export interface TrackTemplateEntry {
  kind: Track['kind']
  name: string
  volumeDb: number
  pan: number
  autoLevel?: AutoLevel
  audioRole?: 'voice' | 'music'
}

const KEY = 'reel:track-template'

const AUTO_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high']
const AUDIO_ROLES: readonly string[] = ['voice', 'music']

/** A template is all-or-nothing: one malformed entry rejects the whole thing
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

/** Capture the active sequence's track layout as the template (overwrites any
 * previous one) and confirm with a toast. */
export function saveTrackTemplate(): void {
  const seq = activeSequence(useStore.getState().project)
  const entries: TrackTemplateEntry[] = seq.tracks.map((t) => ({
    kind: t.kind,
    name: t.name,
    volumeDb: t.volumeDb,
    pan: t.pan,
    ...(t.autoLevel !== undefined ? { autoLevel: t.autoLevel } : {}),
    ...(t.audioRole !== undefined ? { audioRole: t.audioRole } : {}),
  }))
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* private mode / quota — the template just won't persist */
  }
  useToasts.getState().show('Track setup saved, new videos start like this', 'success')
}

/** The saved template, or null when none exists / storage is unreadable. */
export function loadTrackTemplate(): TrackTemplateEntry[] | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    return raw ? sanitize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function clearTrackTemplate(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

/**
 * Tracks for a brand-new sequence: built from the template when one exists,
 * otherwise the stock defaults passed in (same reference, so callers can skip
 * a rebuild). Every call mints fresh ids and empty clips — tracks are never
 * shared between sequences.
 */
export function applyTemplateTracks(defaults: Track[]): Track[] {
  const tpl = loadTrackTemplate()
  if (!tpl) return defaults
  return tpl.map((e) => ({
    ...newTrack(e.kind, e.name),
    volumeDb: e.volumeDb,
    pan: e.pan,
    ...(e.autoLevel !== undefined ? { autoLevel: e.autoLevel } : {}),
    ...(e.audioRole !== undefined ? { audioRole: e.audioRole } : {}),
  }))
}
