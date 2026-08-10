// Channel <-> effect-stack adapter.
//
// The UI addresses a clip's animatable values by CHANNEL name ('scale',
// 'brightness'). Transform and opacity channels live directly on the clip.
// The ten colour channels are addresses INTO the clip's effect stack: 'lift'
// means "the `lift` param of this clip's colorWheels effect".
//
// Keeping that indirection here means clip.effects can be the document's single
// source of truth for effects while the Inspector, the keyframe lane, and the
// scrubbable fields keep speaking channels. It also means a clip carries no
// effect it does not actually use: a colour channel materialises its effect on
// first non-neutral write, and the effect evaporates when it returns to neutral.
//
// CHANNEL_EFFECT is the LIVE map: where a channel written TODAY lands. It is not
// the map a legacy `filters` bag migrates through. Those were the same table
// until Brightness split into Brightness and Contrast, and migrate.ts now owns
// its own frozen copy for exactly that reason. Read the comment there before
// tying them back together.
//
// Pure: no React, no DOM, no store. Imports registry + the keyframe math only.

import { MOMENT_EPS, clipKeyframeTimes, evalChannel, upsertKeyframe } from '../keyframes'
import type { AnimChannel, Clip, Curve, EffectInstance, Keyframe } from '../types'
import { CANONICAL_ORDER, EFFECT_BY_TYPE, defaultParams, getEffect, isNeutral } from './registry'

/**
 * One param of one effect: the thing a channel resolves to, and the unit both
 * the channel API and the legacy-filters migration address the stack by.
 */
export interface EffectAddr {
  type: string
  param: string
}

/** Which effect + param each legacy colour channel addresses. */
export const CHANNEL_EFFECT: Readonly<Partial<Record<AnimChannel, EffectAddr>>> = Object.freeze({
  exposure: { type: 'exposure', param: 'exposure' },
  lift: { type: 'colorWheels', param: 'lift' },
  gamma: { type: 'colorWheels', param: 'gamma' },
  gain: { type: 'colorWheels', param: 'gain' },
  temperature: { type: 'whiteBalance', param: 'temperature' },
  tint: { type: 'whiteBalance', param: 'tint' },
  // Their own effects since 2026-08-10. A write through these channels lands on
  // the MULTIPLICATIVE brightness and the standalone contrast, never on the
  // legacy `brightnessContrast`, which is frozen and hidden.
  brightness: { type: 'brightness', param: 'brightness' },
  contrast: { type: 'contrast', param: 'contrast' },
  saturation: { type: 'saturation', param: 'saturation' },
  blur: { type: 'gaussianBlur', param: 'blur' },
})

/** Neutral value of one effect param, straight from the registry. */
export const addrDefault = (addr: EffectAddr): number =>
  getEffect(addr.type)?.params.find((p) => p.key === addr.param)?.default ?? 0

/** Neutral value for a channel, from the registry for effects and by hand otherwise. */
export function channelDefault(channel: AnimChannel): number {
  const addr = CHANNEL_EFFECT[channel]
  if (addr) return addrDefault(addr)
  switch (channel) {
    case 'scale':
      return 1
    case 'opacity':
      return 1
    case 'anchorX':
    case 'anchorY':
      return 0.5
    default:
      return 0
  }
}

/**
 * The first effect of `type` in the stack. A stack may hold two blurs; the
 * legacy channel address resolves to the first, which is the one the Inspector's
 * fixed Filters/Color sections edit. The generic stack UI addresses by id.
 */
const findEffect = (clip: Clip, type: string): EffectInstance | undefined =>
  clip.effects.find((e) => e.type === type)

/** Static (non-keyframed) value at an address, or `fallback` when nothing is there. */
export function effectParamBase(clip: Clip, addr: EffectAddr, fallback: number): number {
  const raw = findEffect(clip, addr.type)?.params[addr.param]
  if (typeof raw === 'number') return raw
  // An animated param retains the base it had before the stopwatch went on.
  if (raw) return raw.value
  return fallback
}

/** Static (non-keyframed) value of a channel. */
export function channelBase(clip: Clip, channel: AnimChannel): number {
  const addr = CHANNEL_EFFECT[channel]
  if (addr) return effectParamBase(clip, addr, channelDefault(channel))

  const tf = clip.transform
  switch (channel) {
    case 'posX':
      return tf.x
    case 'posY':
      return tf.y
    case 'scale':
      return tf.scale
    case 'rotation':
      return tf.rotationDeg
    case 'anchorX':
      return tf.anchorX
    case 'anchorY':
      return tf.anchorY
    case 'cropT':
      return tf.crop.t
    case 'cropR':
      return tf.crop.r
    case 'cropB':
      return tf.crop.b
    case 'cropL':
      return tf.crop.l
    case 'opacity':
      return clip.opacity
    case 'volume':
      return clip.audioGainDb
    default:
      return 0
  }
}

/** The keyframes animating a channel, wherever they live. Empty when static. */
export function channelKeyframes(clip: Clip, channel: AnimChannel): readonly Keyframe[] {
  const addr = CHANNEL_EFFECT[channel]
  if (addr) {
    const raw = findEffect(clip, addr.type)?.params[addr.param]
    return typeof raw === 'object' && raw !== null ? raw.keyframes : []
  }
  return clip.keyframes?.[channel] ?? []
}

export const isChannelAnimated = (clip: Clip, channel: AnimChannel): boolean =>
  channelKeyframes(clip, channel).length > 0

/**
 * Resolve a channel at LOCAL clip time (t - clip.startS): the keyframed value
 * when animated, else the static base.
 */
export function resolveChannel(clip: Clip, channel: AnimChannel, localT: number): number {
  const kfs = channelKeyframes(clip, channel)
  if (kfs.length === 0) return channelBase(clip, channel)
  return evalChannel(kfs, localT, channelBase(clip, channel))
}

// ---------------------------------------------------------------------------
// Writes. Every one returns a NEW clip; none mutate.

/** Where an effect belongs in the stack so canonical effects keep their math order. */
function insertAt(effects: readonly EffectInstance[], type: string): number {
  const rank = CANONICAL_ORDER.indexOf(type as (typeof CANONICAL_ORDER)[number])
  if (rank < 0) return effects.length // user-added effects append
  for (let i = 0; i < effects.length; i++) {
    const other = CANONICAL_ORDER.indexOf(effects[i].type as (typeof CANONICAL_ORDER)[number])
    if (other > rank) return i
  }
  return effects.length
}

/** Replace or insert an effect, keeping canonical order; drop it when it goes neutral. */
function withEffect(clip: Clip, type: string, patch: (inst: EffectInstance) => EffectInstance): Clip {
  const def = EFFECT_BY_TYPE[type]
  if (!def) return clip
  const idx = clip.effects.findIndex((e) => e.type === type)
  const current: EffectInstance =
    idx >= 0 ? clip.effects[idx] : { id: `fx_${type}`, type, params: defaultParams(def), enabled: true }
  const next = patch(current)

  // A neutral, enabled effect renders as the identity. Keep the document clean
  // by removing it rather than carrying a no-op the user never asked for.
  const drop = next.enabled && isNeutral(next)

  const effects = [...clip.effects]
  if (idx >= 0) {
    if (drop) effects.splice(idx, 1)
    else effects[idx] = next
  } else if (!drop) {
    effects.splice(insertAt(effects, type), 0, next)
  }
  return { ...clip, effects }
}

/**
 * Set one effect param by ADDRESS, materialising or removing its effect as
 * needed. The channel writes below go through here, and so does the legacy
 * `filters` migration, which has to address `brightnessContrast` rather than the
 * effect the `brightness` channel points at today.
 */
export function withEffectParamValue(clip: Clip, addr: EffectAddr, value: number): Clip {
  return withEffect(clip, addr.type, (i) => ({ ...i, params: { ...i.params, [addr.param]: value } }))
}

/**
 * Set one effect param's keyframes by ADDRESS. `base` is carried INTO the
 * animated param so de-animating later restores it rather than snapping to
 * neutral; an empty list collapses the param back to that static number.
 */
export function withEffectParamKeyframes(clip: Clip, addr: EffectAddr, base: number, kfs: Keyframe[]): Clip {
  return withEffect(clip, addr.type, (i) => ({
    ...i,
    params: { ...i.params, [addr.param]: kfs.length === 0 ? base : { value: base, keyframes: kfs } },
  }))
}

/** Set a channel's static value, materialising or removing its effect as needed. */
export function withChannelValue(clip: Clip, channel: AnimChannel, value: number): Clip {
  const addr = CHANNEL_EFFECT[channel]
  if (addr) return withEffectParamValue(clip, addr, value)

  const tf = clip.transform
  const setTf = (patch: Partial<Clip['transform']>): Clip => ({ ...clip, transform: { ...tf, ...patch } })
  const setCrop = (patch: Partial<Clip['transform']['crop']>): Clip => ({
    ...clip,
    transform: { ...tf, crop: { ...tf.crop, ...patch } },
  })
  switch (channel) {
    case 'posX':
      return setTf({ x: value })
    case 'posY':
      return setTf({ y: value })
    case 'scale':
      return setTf({ scale: value })
    case 'rotation':
      return setTf({ rotationDeg: value })
    case 'anchorX':
      return setTf({ anchorX: value })
    case 'anchorY':
      return setTf({ anchorY: value })
    case 'cropT':
      return setCrop({ t: value })
    case 'cropR':
      return setCrop({ r: value })
    case 'cropB':
      return setCrop({ b: value })
    case 'cropL':
      return setCrop({ l: value })
    case 'opacity':
      return { ...clip, opacity: value }
    case 'volume':
      return { ...clip, audioGainDb: value }
    default:
      return clip
  }
}

/**
 * Set a channel's keyframes. An empty list de-animates: the param collapses back
 * to a static number holding its current base, matching the pre-stack behaviour.
 */
export function withChannelKeyframes(clip: Clip, channel: AnimChannel, kfs: Keyframe[]): Clip {
  const addr = CHANNEL_EFFECT[channel]
  if (addr) return withEffectParamKeyframes(clip, addr, channelBase(clip, channel), kfs)

  const next: Partial<Record<AnimChannel, Keyframe[]>> = { ...clip.keyframes }
  if (kfs.length === 0) delete next[channel]
  else next[channel] = kfs
  return { ...clip, keyframes: next }
}

/**
 * At the very head of a clip there is nowhere to animate FROM, so auto-keyframe
 * declines and writes a base instead. One frame at any sane rate is far wider
 * than this; it only has to exclude t=0 itself.
 */
const AUTO_KEYFRAME_MIN_T = 1e-3

/**
 * Commit changed channel values at LOCAL clip time `localT` under ONE policy.
 * Per channel:
 *
 * - **already animated** → upsert a keyframe at `localT` (the base is dead data
 *   while keyframes exist, so writing it would silently do nothing);
 * - **armed, past the head** → pin the current value at the nearest MOMENT the
 *   clip already carries before `localT`, t=0 only when it carries none, and land
 *   the new one at `localT`. It takes TWO: a lone keyframe holds everywhere,
 *   which is just a moved base, and the whole point of the mode is that a drag
 *   makes motion. Pinning at the head instead of at that moment is what made a
 *   drag four seconds in ramp linearly across all four of them rather than move
 *   where he dragged;
 * - **otherwise** → write the static base.
 *
 * `commit` is the ease, and the optional hand-shaped curve, written on the
 * keyframe the move leaves FROM: a keyframe's ease describes the segment LEAVING
 * it, so that is the one that shapes this move. The caller owns which, so a drag,
 * a field commit and a preset can all land the same shape.
 *
 * Shared by the single-clip gizmo and the multi-selection align so that one drag
 * means the same thing however many clips are selected. They disagreed before,
 * and the same gesture animated one clip while permanently moving its
 * neighbours. Pure: the caller owns which clips, and at what time.
 */
export function withChannelsAtTime(
  clip: Clip,
  localT: number,
  vals: readonly (readonly [AnimChannel, number])[],
  armed: boolean,
  commit: { ease: Keyframe['ease']; curve?: Curve },
): Clip {
  // The moment to animate FROM, read across every channel so a drag joins the
  // motion the clip already has. A moment AT localT is the same moment, not one
  // to leave from, so it does not count.
  const prevT = clipKeyframeTimes(clip).filter((t) => t < localT - MOMENT_EPS).pop() ?? 0
  const commitKf = (t: number, value: number): Keyframe =>
    commit.curve ? { t, value, ease: commit.ease, curve: commit.curve } : { t, value, ease: commit.ease }

  let next = clip
  for (const [channel, value] of vals) {
    const kfs = channelKeyframes(next, channel)
    if (kfs.length > 0) {
      next = withChannelKeyframes(next, channel, upsertKeyframe(kfs, commitKf(localT, value)))
      continue
    }
    if (armed && localT > AUTO_KEYFRAME_MIN_T) {
      next = withChannelKeyframes(next, channel, [
        commitKf(prevT, channelBase(next, channel)),
        { t: localT, value, ease: 'linear' },
      ])
      continue
    }
    next = withChannelValue(next, channel, value)
  }
  return next
}
