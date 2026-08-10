// Looks: one click applies a whole channel style. The Jettism look = the
// genre-standard punchy grade on every video clip + 9:16 Shorts format + pop
// entrances for new text. The project edit is ONE dispatch (one undo step); the
// default-appearance side effect lives outside the undo stack by design.

import { CAPTION_POP_DUR_S } from '../engine/captions/captions'
import { setSequenceFormat } from '../engine/timeline'
import { newId, type Clip, type EffectInstance } from '../engine/types'
import { setDefaultTextAppearance } from './appearanceActions'
import { useStore } from './store'
import { useToasts } from './toasts'

/** Shorts frame. */
const LOOK_W = 1080
const LOOK_H = 1920

/**
 * The grade, straight from the channel spec: +13% saturation, +10% contrast,
 * +0.1 stops. Fresh instance ids per call (instances live on clips).
 *
 * The contrast used to ride on `brightnessContrast { brightness: 0, contrast:
 * 0.1 }`. It is the standalone `contrast` effect now, and the two render
 * identically because the new shader IS the old one's contrast line. This
 * signature is load-bearing: `hasJettismGrade` below matches on it, and
 * migrate.ts rewrites the old instance to this exact shape on load so clips
 * graded before the split still read as graded. Change one without the other
 * and a second click double-grades every old clip.
 */
export function jettismGradeEffects(): EffectInstance[] {
  return [
    { id: newId(), type: 'exposure', enabled: true, params: { exposure: 0.1 } },
    { id: newId(), type: 'contrast', enabled: true, params: { contrast: 0.1 } },
    { id: newId(), type: 'saturation', enabled: true, params: { saturation: 0.13 } },
  ]
}

/** Signature match so a second click doesn't stack the grade twice. */
function hasJettismGrade(clip: Clip): boolean {
  const grade = jettismGradeEffects()
  return grade.every((g) =>
    clip.effects.some(
      (e) => e.type === g.type && JSON.stringify(e.params) === JSON.stringify(g.params),
    ),
  )
}

// There is deliberately NO third door to this grade. Applying the look used to
// deposit a "Jettism Punch" preset into the user's Library, sitting among the
// presets they actually saved, and that copy applied through applyPresetToSelection,
// which appends unconditionally. So the one door that looked identical to the other
// two was the only one that could grade an already-graded clip a second time and
// blow it out. The Effects tab tile and the Inspector button both route through
// applyPunchyGradeToClips, which dedupes.

/** Just the grade on one clip (no 9:16, no text defaults). */
export function applyPunchyGrade(clipId: string): void {
  applyPunchyGradeToClips([clipId])
}

/**
 * The punch grade on every selected clip in ONE undo step (the multi-select
 * "Punch grade" button). Title clips and already-graded clips are skipped, so a
 * second click never stacks the grade twice. It now SAYS so, instead of the
 * button flashing while nothing happens and nothing explains why.
 */
export function applyPunchyGradeToClips(ids: Iterable<string>): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  let graded = 0
  useStore.getState().dispatch('Punchy grade', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    let changed = false
    const tracks = seq.tracks.map((t) =>
      t.locked || !t.clips.some((c) => idSet.has(c.id))
        ? t
        : {
            ...t,
            clips: t.clips.map((c) => {
              if (!idSet.has(c.id) || c.title || hasJettismGrade(c)) return c
              changed = true
              graded++
              return { ...c, effects: [...c.effects, ...jettismGradeEffects()] }
            }),
          },
    )
    return changed ? { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } } : p
  })
  useToasts
    .getState()
    .show(
      graded > 0 ? `Punch grade on ${graded} clip(s)` : 'Those clips are already graded',
      graded > 0 ? 'success' : 'info',
    )
}

/**
 * Apply the Jettism look: 9:16 + punch grade on every ungraded video clip
 * (title clips stay clean, since the caption style owns them) in one undo step,
 * and pop as the default text entrance.
 */
export function applyJettismLook(): void {
  let graded = 0
  useStore.getState().dispatch('Apply Jettism look', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    let sq = setSequenceFormat(seq, p.assets, LOOK_W, LOOK_H, true)
    const tracks = sq.tracks.map((t) =>
      t.kind !== 'video'
        ? t
        : {
            ...t,
            clips: t.clips.map((c) => {
              if (c.title || hasJettismGrade(c)) return c
              graded++
              return { ...c, effects: [...c.effects, ...jettismGradeEffects()] }
            }),
          },
    )
    sq = { ...sq, tracks }
    return {
      ...p,
      sequences: { ...p.sequences, [seq.id]: sq },
      settings: { ...p.settings, width: LOOK_W, height: LOOK_H },
    }
  })
  setDefaultTextAppearance({ in: 'pop', durS: CAPTION_POP_DUR_S })
  useToasts
    .getState()
    .show(
      graded > 0
        ? `Jettism look: 9:16, punch grade on ${graded} clip(s), pop titles`
        : 'Jettism look: 9:16 set, clips already graded, pop titles',
      'success',
    )
}
