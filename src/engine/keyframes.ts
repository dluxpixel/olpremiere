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

/** The shape both keyframe-moment helpers read: channels plus effect params. */
export interface KeyframeCarrier {
  keyframes?: Partial<Record<string, readonly Keyframe[]>>
  effects?: readonly { params: Record<string, number | { value?: number; keyframes?: readonly Keyframe[] }> }[]
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
export function clipKeyframeTimes(clip: KeyframeCarrier): number[] {
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

/** Two keyframe times are the same MOMENT when closer together than this. */
export const MOMENT_EPS = 1e-4

/**
 * Move every keyframe at local time `fromT` to `toT`, across every channel and
 * effect param at once — that is what a keyframe IS on the timeline: a moment,
 * not one channel's entry. A punch-in animating scale and both position
 * channels moves as one thing or it tears itself apart.
 *
 * `toT` is clamped inside the clip and kept strictly between the neighbouring
 * moments, so a drag can reorder nothing and no two moments can ever collide.
 * Returns the same clip when nothing moves.
 */
export function moveKeyframeMoment<C extends KeyframeCarrier>(clip: C, fromT: number, toT: number, durationS: number): C {
  const moments = clipKeyframeTimes(clip)
  const idx = moments.findIndex((t) => Math.abs(t - fromT) <= MOMENT_EPS)
  if (idx < 0) return clip

  // A moment may not pass its neighbours, and must stay inside the clip.
  const lo = idx > 0 ? moments[idx - 1] + MOMENT_EPS * 2 : 0
  const hi = idx < moments.length - 1 ? moments[idx + 1] - MOMENT_EPS * 2 : Math.max(0, durationS)
  const t = Math.min(Math.max(toT, lo), Math.max(lo, hi))
  if (Math.abs(t - moments[idx]) <= MOMENT_EPS) return clip

  const at = moments[idx]
  const retime = (kfs: readonly Keyframe[]): Keyframe[] =>
    kfs.map((k) => (Math.abs(k.t - at) <= MOMENT_EPS ? { ...k, t } : k)).sort((a, b) => a.t - b.t)

  const next = { ...clip } as C
  if (clip.keyframes) {
    const channels: Record<string, Keyframe[]> = {}
    for (const [ch, kfs] of Object.entries(clip.keyframes)) if (kfs) channels[ch] = retime(kfs)
    next.keyframes = channels as C['keyframes']
  }
  if (clip.effects) {
    next.effects = clip.effects.map((fx) => {
      let touched = false
      const params: Record<string, number | { value?: number; keyframes?: readonly Keyframe[] }> = {}
      for (const [key, p] of Object.entries(fx.params)) {
        if (typeof p === 'number' || !p.keyframes?.length) {
          params[key] = p
          continue
        }
        touched = true
        params[key] = { ...p, keyframes: retime(p.keyframes) }
      }
      return touched ? { ...fx, params } : fx
    }) as C['effects']
  }
  return next
}
