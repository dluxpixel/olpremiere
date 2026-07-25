// Pure keyframe evaluation (spec §4 Keyframeable). A channel is a list of
// Keyframes sorted by t; evaluating at time t clamps at the ends (hold) and
// interpolates between the surrounding pair using the LEFT keyframe's easing
// (the ease describes the segment leaving that keyframe). No React, no DOM.
//
// This module is a LEAF: it knows nothing about clips or the effect registry,
// which is what lets effects/registry.ts depend on it. Channel resolution
// (which needs both) lives in effects/channels.ts.

import type { Keyframe } from './types'

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

/**
 * Every distinct LOCAL time at which this clip has a keyframe, sorted, across
 * every animated channel it has — the transform/opacity channels and any
 * keyframed effect param alike.
 *
 * The timeline needs one mark per MOMENT, not per channel: a punch-in that
 * animates scale and position at the same instant is one keyframe to the person
 * looking at it, which is how CapCut shows them and why they can be grabbed at
 * all. Pure, so the mark and the animation can never disagree.
 */
export function clipKeyframeTimes(clip: {
  keyframes?: Partial<Record<string, readonly Keyframe[]>>
  effects?: readonly { params: Record<string, number | { keyframes?: readonly Keyframe[] }> }[]
}): number[] {
  const times: number[] = []
  const add = (kfs: readonly Keyframe[] | undefined): void => {
    if (kfs) for (const k of kfs) times.push(k.t)
  }
  for (const kfs of Object.values(clip.keyframes ?? {})) add(kfs)
  for (const fx of clip.effects ?? []) {
    for (const p of Object.values(fx.params)) {
      if (typeof p !== 'number') add(p.keyframes)
    }
  }
  if (times.length === 0) return times
  times.sort((a, b) => a - b)
  // Collapse moments that land within a frame of each other at any sane rate;
  // two marks a pixel apart are one mark to the eye and to the cursor.
  const out: number[] = [times[0]]
  for (const t of times) if (t - out[out.length - 1] > 1e-4) out.push(t)
  return out
}
