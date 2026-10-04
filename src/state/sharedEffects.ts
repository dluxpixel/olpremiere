// One effect, changed on every clip that carries it.
//
// His ask, 2026-09-29: *"make it so that when there is an effect on everything
// (for example, when there is auto color on everything), and I right-click and
// select all the clips that have auto color, I can change every single one at
// the same time."*
//
// Two halves. The clip menu gets "Select all with Auto Color", and the
// multi-selection Inspector shows every effect ALL the selected clips carry,
// with its settings: a change there lands on every one of them, as ONE undo.
//
// A clip that carries the same effect twice is changed through its FIRST copy,
// the same copy the single clip Inspector's keyframe lanes follow
// (EffectControls paramChannel). A setting he keyframed on one clip is
// keyframed at the playhead on that clip, exactly like editing it on its own,
// so a shared change can never flatten an animation he built by hand.

import { resolveParam, removeEffect, setEffectParam, toggleEffect } from '../engine/effects/ops'
import { getEffect } from '../engine/effects/registry'
import { activeSequence, type Clip, type EffectInstance, type Sequence } from '../engine/types'
import { mapClips } from './bulkEdits'
import { playheadLocalT } from './clipEdits'
import { useStore } from './store'
import { useToasts } from './toasts'
import { plural } from '../engine/plural'

/** The first copy of an effect on a clip, the one a shared change goes through. */
export const firstOfType = (clip: Clip, type: string): EffectInstance | undefined =>
  clip.effects.find((e) => e.type === type)

/** Each effect type a clip carries, once, in stack order. */
export function effectTypesOn(clip: Clip): string[] {
  const out: string[] = []
  for (const e of clip.effects) if (!out.includes(e.type)) out.push(e.type)
  return out
}

/**
 * The effect types EVERY clip carries, in the first clip's stack order. Types
 * the registry no longer knows are left out: there is nothing to show for them.
 */
export function sharedEffectTypes(clips: readonly Clip[]): string[] {
  if (clips.length === 0) return []
  return effectTypesOn(clips[0]!).filter((t) => getEffect(t) && clips.every((c) => c.effects.some((e) => e.type === t)))
}

/** Every clip in the sequence carrying this effect, locked tracks included (a selection may hold them). */
export function clipsWithEffect(seq: Sequence, type: string): string[] {
  return seq.tracks.flatMap((t) => t.clips.filter((c) => c.effects.some((e) => e.type === type)).map((c) => c.id))
}

/** "Select all with Auto Color": the selection becomes every clip carrying it. */
export function selectClipsWithEffect(type: string): void {
  const ids = clipsWithEffect(activeSequence(useStore.getState().project), type)
  const label = getEffect(type)?.label ?? type
  useStore.getState().setUI({ selection: ids })
  useToasts
    .getState()
    .show(ids.length === 1 ? `1 clip has ${label}` : `Selected the ${ids.length} clips with ${label}`, 'info')
}

/**
 * What a setting reads across the clips, at the playhead: the first clip's
 * value, and whether any other clip differs from it by more than half a step.
 */
export function sharedParamValue(
  clips: readonly Clip[],
  type: string,
  key: string,
  localT: (c: Clip) => number,
): { value: number; mixed: boolean } {
  const step = getEffect(type)?.params.find((p) => p.key === key)?.step ?? 0
  const values = clips.flatMap((c) => {
    const inst = firstOfType(c, type)
    return inst ? [resolveParam(inst, key, localT(c))] : []
  })
  if (values.length === 0) return { value: 0, mixed: false }
  const first = values[0]!
  return { value: first, mixed: values.some((v) => Math.abs(v - first) > step / 2 + 1e-9) }
}

/** Is the effect switched on across the clips: 'on', 'off', or 'mixed'. */
export function sharedEnabled(clips: readonly Clip[], type: string): 'on' | 'off' | 'mixed' {
  const states = clips.map((c) => firstOfType(c, type)?.enabled !== false)
  if (states.every(Boolean)) return 'on'
  if (states.every((s) => !s)) return 'off'
  return 'mixed'
}

/**
 * Set one setting of one effect on every clip, as one undo. Scrubbing merges
 * into that one step, the same as scrubbing a single clip.
 */
export function setSharedEffectParam(ids: readonly string[], type: string, key: string, value: number): void {
  const def = getEffect(type)
  const param = def?.params.find((p) => p.key === key)
  mapClips(
    ids,
    `Set ${def?.label ?? type} ${param?.label ?? key} on ${plural(ids.length, 'clip')}`,
    (c) => {
      const inst = firstOfType(c, type)
      return inst ? setEffectParam(c, inst.id, key, value, playheadLocalT(c)) : c
    },
    `shared-param:${type}:${key}`,
  )
}

/** Put one setting back to its neutral value on every clip. */
export function resetSharedEffectParam(ids: readonly string[], type: string, key: string): void {
  const param = getEffect(type)?.params.find((p) => p.key === key)
  if (param) setSharedEffectParam(ids, type, key, param.default)
}

/** Switch the effect on or off on every clip at once (mixed switches them all on). */
export function setSharedEffectEnabled(ids: readonly string[], type: string, on: boolean): void {
  mapClips(ids, `${on ? 'Enable' : 'Disable'} ${getEffect(type)?.label ?? type} on ${plural(ids.length, 'clip')}`, (c) => {
    const inst = firstOfType(c, type)
    return inst && inst.enabled !== on ? toggleEffect(c, inst.id) : c
  })
}

/** Take the effect off every clip, every copy of it. */
export function removeSharedEffect(ids: readonly string[], type: string): void {
  mapClips(ids, `Remove ${getEffect(type)?.label ?? type} from ${plural(ids.length, 'clip')}`, (c) =>
    c.effects.filter((e) => e.type === type).reduce((acc, e) => removeEffect(acc, e.id), c),
  )
}
