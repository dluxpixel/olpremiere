// Effect presets: a named effect stack saved OUTSIDE any project document, so a
// grade built once ("my Shorts look") applies to any clip in any future project
// with one action. Pure — ids and timestamps are injected, storage lives in
// state/library.ts.

import type { Clip, EffectInstance, Id, Keyframeable } from '../types'
import { getEffect } from './registry'

export interface EffectPreset {
  id: Id
  name: string
  /** The stack, in order, params (and their keyframes) deep-copied. */
  effects: EffectInstance[]
  createdAt: number
}

/** Deep-copy one param so a preset can never share array refs with a live clip. */
const copyParam = (v: Keyframeable): Keyframeable =>
  typeof v === 'number' ? v : { value: v.value, keyframes: v.keyframes.map((k) => ({ ...k })) }

/** Copy a stack with FRESH instance ids (each application must be independent). */
export const copyEffects = (effects: readonly EffectInstance[], idFor: () => Id): EffectInstance[] =>
  effects.map((e) => ({
    id: idFor(),
    type: e.type,
    enabled: e.enabled,
    params: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, copyParam(v)])),
  }))

/** "Lift / Gamma / Gain", "Exposure + Saturation", "Exposure + 3 more". */
export function autoPresetName(effects: readonly EffectInstance[]): string {
  const labels = effects.map((e) => getEffect(e.type)?.label ?? e.type)
  if (labels.length === 0) return 'Empty preset'
  if (labels.length <= 2) return labels.join(' + ')
  return `${labels[0]} + ${labels.length - 1} more`
}

/** Snapshot a clip's stack as a preset. Null for a clip with no effects. */
export function presetFromClip(clip: Clip, id: Id, createdAt: number, idFor: () => Id, name?: string): EffectPreset | null {
  if (clip.effects.length === 0) return null
  return {
    id,
    name: name?.trim() || autoPresetName(clip.effects),
    effects: copyEffects(clip.effects, idFor),
    createdAt,
  }
}

/**
 * Apply a preset by APPENDING its effects (fresh ids) after the clip's existing
 * stack. Appending, not replacing: a preset is "add my look", and the user can
 * delete what they no longer want — the reverse (silently destroying an
 * existing grade) is not undoable by intuition.
 */
export const applyPresetToClip = (clip: Clip, preset: EffectPreset, idFor: () => Id): Clip => ({
  ...clip,
  effects: [...clip.effects, ...copyEffects(preset.effects, idFor)],
})
