// Looks: one click applies a whole channel style. The Jettism look = the
// genre-standard punchy grade on every video clip + 9:16 Shorts format + pop
// entrances for new text, and the grade is banked as a reusable Library
// preset. The project edit is ONE dispatch (one undo step); the Library/
// default-appearance side effects live outside the undo stack by design.

import { CAPTION_POP_DUR_S } from '../engine/captions/captions'
import type { EffectPreset } from '../engine/effects/presets'
import { setSequenceFormat } from '../engine/timeline'
import { newId, type Clip, type EffectInstance } from '../engine/types'
import { setDefaultTextAppearance } from './appearanceActions'
import { useLibrary } from './library'
import { db } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

export const JETTISM_LOOK_NAME = 'Jettism Punch'

/** Shorts frame. */
const LOOK_W = 1080
const LOOK_H = 1920

/**
 * The grade, straight from the channel spec: +13% saturation, +10% contrast,
 * +0.1 stops. Fresh instance ids per call (instances live on clips).
 */
export function jettismGradeEffects(): EffectInstance[] {
  return [
    { id: newId(), type: 'exposure', enabled: true, params: { exposure: 0.1 } },
    { id: newId(), type: 'brightnessContrast', enabled: true, params: { brightness: 0, contrast: 0.1 } },
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

/** Bank the grade as a Library preset (idempotent by name; best-effort). */
async function ensureLookPreset(): Promise<void> {
  const lib = useLibrary.getState()
  if (lib.presets.some((p) => p.name === JETTISM_LOOK_NAME)) return
  const preset: EffectPreset = {
    id: newId(),
    name: JETTISM_LOOK_NAME,
    effects: jettismGradeEffects(),
    createdAt: Date.now(),
  }
  try {
    const d = await db()
    await d.put('presets', preset, preset.id)
    useLibrary.setState((s) => ({ presets: [preset, ...s.presets] }))
  } catch (err) {
    console.error('OL Studio: could not bank the look preset', err)
  }
}

/** Just the grade on one clip (no 9:16, no text defaults); banks the preset. */
export function applyPunchyGrade(clipId: string): void {
  useStore.getState().dispatch('Punchy grade', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const tracks = seq.tracks.map((t) =>
      t.locked || !t.clips.some((c) => c.id === clipId)
        ? t
        : {
            ...t,
            clips: t.clips.map((c) =>
              c.id !== clipId || hasJettismGrade(c)
                ? c
                : { ...c, effects: [...c.effects, ...jettismGradeEffects()] },
            ),
          },
    )
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
  })
  void ensureLookPreset()
}

/**
 * Apply the Jettism look: 9:16 + punch grade on every ungraded video clip
 * (title clips stay clean — the caption style owns them) in one undo step,
 * pop as the default text entrance, and the grade banked for reuse.
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
  void ensureLookPreset()
  useToasts
    .getState()
    .show(
      graded > 0
        ? `Jettism look: 9:16, punch grade on ${graded} clip(s), pop titles`
        : 'Jettism look: 9:16 set, clips already graded, pop titles',
      'success',
    )
}
