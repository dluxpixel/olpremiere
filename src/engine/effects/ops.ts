// Pure operations on a clip's effect stack, addressed by effect INSTANCE id.
//
// The channel adapter (channels.ts) addresses the canonical colour effects by
// name and materialises them on demand; that path exists for migration and for
// transform/opacity. This module is the other half: what the Effects browser and
// the Effect Controls stack call when the user explicitly applies, reorders,
// disables, resets, or keyframes an effect.
//
// The distinction that matters: an effect the USER applied never evaporates just
// because its params sit at their defaults. Dragging Gaussian Blur onto a clip
// and seeing it vanish because radius is 0 would be absurd. Neutral effects are
// skipped at RENDER time (resolve.ts), which is where it costs nothing.
//
// Pure: every function returns a new Clip; none mutate. No React, no DOM.

import { evalChannel, removeKeyframeNear, upsertKeyframe } from '../keyframes'
import type { Clip, EffectInstance, Id, Keyframe, Keyframeable } from '../types'
import { CANONICAL_ORDER, defaultParams, getEffect } from './registry'

/**
 * Where a newly applied effect lands. Canonical effects keep their frozen math
 * order relative to EACH OTHER; anything else appends. Non-canonical effects
 * already in the stack are transparent to this search (rank -1 never compares
 * greater), so applying a colour effect to a clip that already has a chroma key
 * appends after it rather than jumping in front of it.
 */
function insertIndex(effects: readonly EffectInstance[], type: string): number {
  const rank = CANONICAL_ORDER.indexOf(type as (typeof CANONICAL_ORDER)[number])
  if (rank < 0) return effects.length
  for (let i = 0; i < effects.length; i++) {
    const other = CANONICAL_ORDER.indexOf(effects[i].type as (typeof CANONICAL_ORDER)[number])
    if (other > rank) return i
  }
  return effects.length
}

const mapEffect = (clip: Clip, effectId: Id, fn: (inst: EffectInstance) => EffectInstance): Clip => ({
  ...clip,
  effects: clip.effects.map((e) => (e.id === effectId ? fn(e) : e)),
})

export const findEffectById = (clip: Clip, effectId: Id): EffectInstance | undefined =>
  clip.effects.find((e) => e.id === effectId)

// ---------------------------------------------------------------------------
// Stack CRUD

/**
 * Apply an effect to a clip. `id` is injected so callers stay pure and tests
 * stay deterministic. Unknown types are rejected rather than stored.
 */
export function addEffect(clip: Clip, type: string, id: Id): Clip {
  const def = getEffect(type)
  if (!def) return clip
  // Seed neutral defaults, then apply any `initialParams` so an effect that
  // should do something on drop (Auto Color) isn't invisible at identity.
  const params = { ...defaultParams(def), ...(def.initialParams ?? {}) }
  const inst: EffectInstance = { id, type, params, enabled: true }
  const effects = [...clip.effects]
  effects.splice(insertIndex(effects, type), 0, inst)
  return { ...clip, effects }
}

export function removeEffect(clip: Clip, effectId: Id): Clip {
  const effects = clip.effects.filter((e) => e.id !== effectId)
  return effects.length === clip.effects.length ? clip : { ...clip, effects }
}

export const toggleEffect = (clip: Clip, effectId: Id): Clip =>
  mapEffect(clip, effectId, (e) => ({ ...e, enabled: !e.enabled }))

/** Move an effect one slot up (-1, earlier) or down (+1, later) in the stack. */
export function moveEffect(clip: Clip, effectId: Id, delta: -1 | 1): Clip {
  const i = clip.effects.findIndex((e) => e.id === effectId)
  const j = i + delta
  if (i < 0 || j < 0 || j >= clip.effects.length) return clip
  const effects = [...clip.effects]
  const [moved] = effects.splice(i, 1)
  effects.splice(j, 0, moved)
  return { ...clip, effects }
}

/** Every param back to neutral, keyframes dropped. The instance stays applied. */
export function resetEffect(clip: Clip, effectId: Id): Clip {
  return mapEffect(clip, effectId, (e) => {
    const def = getEffect(e.type)
    return def ? { ...e, params: defaultParams(def) } : e
  })
}

// ---------------------------------------------------------------------------
// Param reads

/** The retained static base of a param: what it returns to when de-animated. */
export function paramBase(inst: EffectInstance, key: string): number {
  const raw = inst.params[key]
  if (typeof raw === 'number') return raw
  if (raw) return raw.value
  return getEffect(inst.type)?.params.find((p) => p.key === key)?.default ?? 0
}

export function paramKeyframes(inst: EffectInstance, key: string): readonly Keyframe[] {
  const raw = inst.params[key]
  return typeof raw === 'object' && raw !== null ? raw.keyframes : []
}

export const isParamAnimated = (inst: EffectInstance, key: string): boolean => paramKeyframes(inst, key).length > 0

/** The param's value at clip-local time `localT`. */
export function resolveParam(inst: EffectInstance, key: string, localT: number): number {
  const kfs = paramKeyframes(inst, key)
  const base = paramBase(inst, key)
  return kfs.length === 0 ? base : evalChannel(kfs, localT, base)
}

// ---------------------------------------------------------------------------
// Param writes

const withParam = (clip: Clip, effectId: Id, key: string, value: Keyframeable): Clip =>
  mapEffect(clip, effectId, (e) => ({ ...e, params: { ...e.params, [key]: value } }))

/** Store keyframes, keeping the retained base. An empty list de-animates to that base. */
function withParamKeyframes(clip: Clip, effectId: Id, key: string, kfs: Keyframe[]): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  const base = paramBase(inst, key)
  return withParam(clip, effectId, key, kfs.length === 0 ? base : { value: base, keyframes: kfs })
}

/**
 * Set a param. Animated → upsert a keyframe at the playhead. Static → move the
 * base. Mirrors setChannel, one level down.
 */
export function setEffectParam(clip: Clip, effectId: Id, key: string, value: number, localT: number): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  if (!isParamAnimated(inst, key)) return withParam(clip, effectId, key, value)
  return withParamKeyframes(clip, effectId, key, upsertKeyframe(paramKeyframes(inst, key), { t: localT, value, ease: 'linear' }))
}

/** Stopwatch: on → seed a keyframe at the playhead holding the current value; off → drop all. */
export function toggleEffectParamAnimation(clip: Clip, effectId: Id, key: string, localT: number): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  if (isParamAnimated(inst, key)) return withParamKeyframes(clip, effectId, key, [])
  return withParamKeyframes(clip, effectId, key, [{ t: localT, value: paramBase(inst, key), ease: 'linear' }])
}

export function addEffectParamKeyframe(clip: Clip, effectId: Id, key: string, localT: number): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  const value = resolveParam(inst, key, localT)
  return withParamKeyframes(clip, effectId, key, upsertKeyframe(paramKeyframes(inst, key), { t: localT, value, ease: 'linear' }))
}

export function removeEffectParamKeyframe(clip: Clip, effectId: Id, key: string, localT: number, toleranceS = 0.05): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  return withParamKeyframes(clip, effectId, key, removeKeyframeNear(paramKeyframes(inst, key), localT, toleranceS))
}

export function setEffectParamEase(
  clip: Clip,
  effectId: Id,
  key: string,
  kfT: number,
  ease: Keyframe['ease'],
  toleranceS = 1e-4,
): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  const kfs = paramKeyframes(inst, key)
  if (kfs.length === 0) return clip
  return withParamKeyframes(
    clip,
    effectId,
    key,
    kfs.map((k) => (Math.abs(k.t - kfT) <= toleranceS ? { ...k, ease } : k)),
  )
}

/**
 * Ramp an effect ON at the head of the clip, or OFF at its tail.
 *
 * HIS WORDS, 2026-08-06: *"I selected a blur, but can I somehow make it so it
 * transitions into the blur? Can you make that an option for the effects, so
 * that it has also transitions?"*
 *
 * It was already possible and effectively undiscoverable: keyframe the Radius
 * by hand, twice, at the right two moments. That is not an answer for someone
 * who wants a blur to arrive rather than appear.
 *
 * The trick is that the registry already carries what a ramp needs. Every param
 * declares a `default` that is documented as its NEUTRAL value ("an effect whose
 * params all sit here is a no-op"), so fading an effect in is just animating
 * every param from its neutral to whatever he set, and fading it out is the
 * same in reverse. That works for EVERY effect, present and future, with no
 * per-effect table to keep in step.
 *
 * Params he has already keyframed by hand are left completely alone: he has
 * said something more specific than "ramp this", and it wins.
 *
 * `durationS` is in CLIP-LOCAL seconds, the same clock the keyframes use.
 */
export function rampEffect(
  clip: Clip,
  effectId: Id,
  edge: 'in' | 'out',
  durationS: number,
  clipDurationS: number,
): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  const def = getEffect(inst.type)
  if (!def) return clip
  // A ramp longer than the clip would put both knots at the same instant, which
  // is a step, not a ramp. Half the clip is the most that can still read as one.
  const dur = Math.min(Math.max(durationS, 1 / 240), Math.max(clipDurationS / 2, 1 / 240))
  const [tStart, tEnd] = edge === 'in' ? [0, dur] : [Math.max(0, clipDurationS - dur), clipDurationS]

  let next = clip
  for (const param of def.params) {
    const cur = findEffectById(next, effectId)
    if (!cur) break
    // Already animated: he has been more specific than this. Leave it.
    if (isParamAnimated(cur, param.key)) continue
    const value = paramBase(cur, param.key)
    // A param sitting at neutral has nothing to ramp between.
    if (Math.abs(value - param.default) < 1e-9) continue
    const from = edge === 'in' ? param.default : value
    const to = edge === 'in' ? value : param.default
    next = withParamKeyframes(next, effectId, param.key, [
      { t: tStart, value: from, ease: 'easeOut' },
      { t: tEnd, value: to, ease: 'linear' },
    ])
  }
  return next
}

/** True when any of the effect's params carries keyframes (so a ramp is already there). */
export function isEffectRamped(clip: Clip, effectId: Id): boolean {
  const inst = findEffectById(clip, effectId)
  if (!inst) return false
  const def = getEffect(inst.type)
  if (!def) return false
  return def.params.some((p) => isParamAnimated(inst, p.key))
}

/** Drop every keyframe on an effect, leaving each param at the value it shows now. */
export function clearEffectRamp(clip: Clip, effectId: Id, localT: number): Clip {
  const inst = findEffectById(clip, effectId)
  if (!inst) return clip
  const def = getEffect(inst.type)
  if (!def) return clip
  let next = clip
  for (const param of def.params) {
    const cur = findEffectById(next, effectId)
    if (!cur || !isParamAnimated(cur, param.key)) continue
    // Keep what is on screen right now, not the stored base: that is the value
    // he is looking at when he turns the ramp off.
    const shown = resolveParam(cur, param.key, localT)
    next = withParamKeyframes(next, effectId, param.key, [])
    next = withParam(next, effectId, param.key, shown)
  }
  return next
}
