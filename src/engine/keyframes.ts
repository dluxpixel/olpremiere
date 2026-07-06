// Pure keyframe evaluation (spec §4 Keyframeable). A channel is a list of
// Keyframes sorted by t; evaluating at time t clamps at the ends (hold) and
// interpolates between the surrounding pair using the LEFT keyframe's easing
// (the ease describes the segment leaving that keyframe). No React, no DOM.

import type { AnimChannel, Clip, Keyframe } from './types'

export type Easing = Keyframe['ease']

/** Map normalized progress p∈[0,1] → eased p∈[0,1]. 'hold' handled by caller. */
export function ease(kind: Easing, p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p
  switch (kind) {
    case 'linear':
    case 'hold':
      return x
    case 'easeIn':
      return x * x
    case 'easeOut':
      return 1 - (1 - x) * (1 - x)
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
  }
}

/**
 * Value of a keyframe channel at time `t`. Empty list → `fallback`.
 * Before the first / after the last keyframe the value holds (clamps).
 * 'hold' easing steps: the value stays at the left keyframe until the right.
 */
export function evalChannel(keyframes: readonly Keyframe[] | undefined, t: number, fallback: number): number {
  if (!keyframes || keyframes.length === 0) return fallback
  if (keyframes.length === 1) return keyframes[0].value
  if (t <= keyframes[0].t) return keyframes[0].value
  const last = keyframes[keyframes.length - 1]
  if (t >= last.t) return last.value

  // Find the segment [a, b] with a.t <= t < b.t (list is sorted).
  let lo = 0
  let hi = keyframes.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = keyframes[lo]
  const b = keyframes[lo + 1]
  if (a.ease === 'hold') return a.value
  const span = b.t - a.t
  const p = span <= 0 ? 0 : (t - a.t) / span
  return a.value + (b.value - a.value) * ease(a.ease, p)
}

/** Static base value for a channel from the clip's non-animated fields. */
export function channelBase(clip: Clip, channel: AnimChannel): number {
  const tf = clip.transform
  const f = clip.filters
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
    case 'brightness':
      return f?.brightness ?? 0
    case 'contrast':
      return f?.contrast ?? 0
    case 'saturation':
      return f?.saturation ?? 0
    case 'exposure':
      return f?.exposure ?? 0
    case 'blur':
      return f?.blur ?? 0
  }
}

/**
 * Resolve a channel for a clip at LOCAL clip time `localT` (t − clip.startS):
 * the keyframed value when the channel is animated, else the static base.
 */
export function resolveChannel(clip: Clip, channel: AnimChannel, localT: number): number {
  const kf = clip.keyframes?.[channel]
  if (!kf || kf.length === 0) return channelBase(clip, channel)
  return evalChannel(kf, localT, channelBase(clip, channel))
}

export const isChannelAnimated = (clip: Clip, channel: AnimChannel): boolean =>
  (clip.keyframes?.[channel]?.length ?? 0) > 0

/** Insert or replace a keyframe at time t (exact-time replace), returning a new sorted array. */
export function upsertKeyframe(
  keyframes: readonly Keyframe[] | undefined,
  kf: Keyframe,
): Keyframe[] {
  const rest = (keyframes ?? []).filter((k) => Math.abs(k.t - kf.t) > 1e-6)
  const next = [...rest, kf]
  next.sort((a, b) => a.t - b.t)
  return next
}

/** Remove the keyframe nearest to t within tolerance; returns the same ref when nothing matches. */
export function removeKeyframeNear(
  keyframes: readonly Keyframe[] | undefined,
  t: number,
  toleranceS = 1e-6,
): Keyframe[] {
  const list = keyframes ?? []
  let bestIdx = -1
  let bestDist = Infinity
  list.forEach((k, i) => {
    const d = Math.abs(k.t - t)
    if (d <= toleranceS && d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  })
  if (bestIdx === -1) return list as Keyframe[]
  return list.filter((_, i) => i !== bestIdx)
}
