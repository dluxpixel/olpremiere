// One-way migration of the pre-registry document shape into the effect stack.
//
// Before: a clip carried a flat `filters` bag and animated its colour via
// clip.keyframes.brightness, clip.keyframes.lift, and so on.
// After: those live inside clip.effects, as params of the effect that owns them.
//
// Runs on load (persistence.ts), after migrateProject. Idempotent: a clip that
// already has effects, or one that never had a grade, is returned untouched.
//
// Lives here rather than in engine/types.ts because it needs the registry, and
// types.ts is what the registry ultimately depends on.

import type { AnimChannel, Clip, ClipFilters, Id, Keyframe, Project, Sequence } from '../types'
import { CHANNEL_EFFECT, channelDefault, withChannelKeyframes, withChannelValue } from './channels'

const COLOR_CHANNELS = Object.keys(CHANNEL_EFFECT) as AnimChannel[]

/** Did this clip carry any pre-registry colour state at all? */
function hasLegacyColor(clip: Clip): boolean {
  if (clip.filters && Object.values(clip.filters).some((v) => typeof v === 'number' && v !== 0)) return true
  return COLOR_CHANNELS.some((ch) => (clip.keyframes?.[ch]?.length ?? 0) > 0)
}

/** Shed the legacy bag without disturbing anything else. */
function withoutFilters(clip: Clip): Clip {
  const next: Clip = { ...clip }
  delete next.filters
  return next
}

export function migrateClipEffects(clip: Clip): Clip {
  const alreadyMigrated = clip.effects.length > 0
  if (alreadyMigrated || !hasLegacyColor(clip)) {
    // Nothing to move. Return the SAME object when there is no bag to shed, so
    // migrateProjectEffects can detect "unchanged" by identity.
    return clip.filters ? withoutFilters(clip) : clip
  }

  let next: Clip = { ...clip, effects: [] }

  // Static values first, so withChannelKeyframes can read the correct base when
  // it de-animates, and so each effect materialises at its canonical position.
  for (const ch of COLOR_CHANNELS) {
    const value = clip.filters?.[ch as keyof ClipFilters]
    if (typeof value === 'number' && value !== channelDefault(ch)) next = withChannelValue(next, ch, value)
  }

  // Then move each animated colour channel into its effect's param.
  for (const ch of COLOR_CHANNELS) {
    const kfs: Keyframe[] | undefined = clip.keyframes?.[ch]
    if (kfs && kfs.length > 0) next = withChannelKeyframes(next, ch, kfs)
  }

  // Shed the migrated channels and the legacy bag. Transform/opacity keyframes
  // stay exactly where they were.
  const keyframes: Partial<Record<AnimChannel, Keyframe[]>> = { ...next.keyframes }
  for (const ch of COLOR_CHANNELS) delete keyframes[ch]

  return { ...withoutFilters(next), keyframes }
}

/** Migrate every clip of every sequence. Returns the same object when nothing changed. */
export function migrateProjectEffects(p: Project): Project {
  let changed = false
  const sequences: Record<Id, Sequence> = {}
  for (const [id, seq] of Object.entries(p.sequences)) {
    let seqChanged = false
    const tracks = seq.tracks.map((track) => {
      let trackChanged = false
      const clips = track.clips.map((clip) => {
        const next = migrateClipEffects(clip)
        if (next !== clip) trackChanged = true
        return next
      })
      if (!trackChanged) return track
      seqChanged = true
      return { ...track, clips }
    })
    if (seqChanged) {
      changed = true
      sequences[id] = { ...seq, tracks }
    } else {
      sequences[id] = seq
    }
  }
  return changed ? { ...p, sequences } : p
}
