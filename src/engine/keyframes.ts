// Pure keyframe evaluation (spec §4 Keyframeable). A channel is a list of
// Keyframes sorted by t; evaluating at time t clamps at the ends (hold) and
// interpolates between the surrounding pair using the LEFT keyframe's easing
// (the ease describes the segment leaving that keyframe). No React, no DOM.
//
// This module is a LEAF: it knows nothing about clips or the effect registry,
// which is what lets effects/registry.ts depend on it. Channel resolution
// (which needs both) lives in effects/channels.ts.

import type { Curve, Keyframe } from './types'

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
    // Nothing sanitizes `ease` on load, so an unknown name stored by a newer
    // build reaches this switch, falls off the end and returns undefined, which
    // NaNs the transform and renders a black frame. Fall back to linear.
    default:
      return x
  }
}

/** One axis of a cubic bezier from (0,0) to (1,1) with handles a1 and a2. */
function bezierAxis(t: number, a1: number, a2: number): number {
  const c = 3 * a1
  const b = 3 * a2 - 6 * a1
  const a = 1 - 3 * a2 + 3 * a1
  return ((a * t + b) * t + c) * t
}

/** d/dt of bezierAxis, the slope Newton-Raphson steps along. */
function bezierSlope(t: number, a1: number, a2: number): number {
  const c = 3 * a1
  const b = 3 * a2 - 6 * a1
  const a = 1 - 3 * a2 + 3 * a1
  return (3 * a * t + 2 * b) * t + c
}

/** Convergence epsilon for the bezier solver, on x and on the slope alike. */
const BEZIER_EPS = 1e-6

/**
 * Map normalized progress p∈[0,1] → eased value through a cubic bezier given in
 * CSS `cubic-bezier(x1, y1, x2, y2)` order.
 *
 * x1 and x2 are clamped into 0..1, which is what keeps x(t) monotonic: time has
 * to stay a function of time or a segment plays backwards in the middle. y1 and
 * y2 are deliberately left alone, so a curve may travel past its target and
 * settle back. That overshoot is the whole point of a snap, and clamping y here
 * would quietly delete it.
 *
 * Solves t from x by Newton-Raphson, falling back to bisection when the slope
 * collapses (x1=1, x2=0 is flat at t=0.5 and Newton cannot move off it).
 */
function solveBezierT(x: number, x1: number, x2: number): number {
  let t = x
  for (let i = 0; i < 8; i++) {
    const err = bezierAxis(t, x1, x2) - x
    if (Math.abs(err) < BEZIER_EPS) return t
    const d = bezierSlope(t, x1, x2)
    if (Math.abs(d) < BEZIER_EPS) break
    t -= err / d
  }
  let lo = 0
  let hi = 1
  t = x
  for (let i = 0; i < 20; i++) {
    const err = bezierAxis(t, x1, x2) - x
    if (Math.abs(err) < BEZIER_EPS) break
    if (err < 0) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return t
}

export function bezierEase(curve: Curve, p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p
  if (x === 0 || x === 1) return x
  const x1 = curve[0] < 0 ? 0 : curve[0] > 1 ? 1 : curve[0]
  const x2 = curve[2] < 0 ? 0 : curve[2] > 1 ? 1 : curve[2]
  return bezierAxis(solveBezierT(x, x1, x2), curve[1], curve[3])
}

/**
 * The named eases as the SAME cubic bezier the renderer would run.
 *
 * `ease()` writes them as quadratics, and a quadratic in x is expressible
 * exactly as a cubic bezier timing function. x1 = 1/3 and x2 = 2/3 make x(t) = t,
 * and then y(t) = 3y1 t(1-t)^2 + 3y2 t^2(1-t) + t^3. Solving that for y = t^2
 * gives y1 = 0, y2 = 1/3, and for y = 2t - t^2 gives y1 = 2/3, y2 = 1.
 *
 * ⛔ `easeInOut` IS DELIBERATELY ABSENT. It is piecewise, two quadratics either
 * side of the midpoint, and no single cubic reproduces it. Claiming one here
 * would make a cut silently reshape it, which is the exact bug this table exists
 * to fix, so it is left out and the caller falls back honestly.
 */
const CURVE_FOR_EASE: Partial<Record<Easing, Curve>> = {
  easeIn: [1 / 3, 0, 2 / 3, 1 / 3],
  easeOut: [1 / 3, 2 / 3, 2 / 3, 1],
}

/** One control point of the unit-square cubic, during the split. */
type Pt = { x: number; y: number }
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * Cut one eased segment in two AT progress `atP`, exactly.
 *
 * ⛔ WHY THIS EXISTS. Splitting a clip used to keep the left half's ease and run
 * it over the shortened half, and hand the right half a plain linear. Both
 * endpoints matched, so it looked right in a still, and the PATH between them
 * was wrong at every cut he made: the audit measured a push off about 4 percent,
 * a pop about 10, and a hold turned into a ramp. Every cut degraded the motion a
 * little more, silently, and the docstring above it claimed the split was exact.
 *
 * De Casteljau at the bezier parameter that lands on `atP`, then each half is
 * renormalised back into its own unit square. The two halves played back to back
 * reproduce the original curve, so a cut costs nothing at all.
 *
 * Returns null when there is no exact answer (`easeInOut`, or a degenerate split
 * where the value at the cut is the same as one of the ends). The caller then
 * does what it always did, rather than inventing a shape.
 */
export function splitEaseAt(
  kf: Pick<Keyframe, 'ease' | 'curve'>,
  atP: number,
): { left: Pick<Keyframe, 'ease' | 'curve'>; right: Pick<Keyframe, 'ease' | 'curve'> } | null {
  if (!(atP > 0 && atP < 1)) return null
  // Both halves of a hold are a hold, and both halves of a linear are linear.
  // Exact, and no bezier needed for either.
  if (!kf.curve && (kf.ease === 'hold' || kf.ease === 'linear')) {
    return { left: { ease: kf.ease }, right: { ease: kf.ease } }
  }
  const curve = kf.curve ?? CURVE_FOR_EASE[kf.ease]
  if (!curve) return null

  const x1 = curve[0] < 0 ? 0 : curve[0] > 1 ? 1 : curve[0]
  const x2 = curve[2] < 0 ? 0 : curve[2] > 1 ? 1 : curve[2]
  const t = solveBezierT(atP, x1, x2)
  const p0: Pt = { x: 0, y: 0 }
  const p1: Pt = { x: x1, y: curve[1] }
  const p2: Pt = { x: x2, y: curve[3] }
  const p3: Pt = { x: 1, y: 1 }
  const a = lerp(p0, p1, t)
  const b = lerp(p1, p2, t)
  const c = lerp(p2, p3, t)
  const d = lerp(a, b, t)
  const e = lerp(b, c, t)
  const mid = lerp(d, e, t)

  const zx = mid.x
  const zy = mid.y
  // A cut where the value has not moved, or has already arrived, cannot be
  // renormalised: the half would be divided by zero. Left to the fallback.
  if (!(zx > 1e-9 && zx < 1 - 1e-9)) return null
  if (Math.abs(zy) < 1e-9 || Math.abs(1 - zy) < 1e-9) return null

  const left: Curve = [a.x / zx, a.y / zy, d.x / zx, d.y / zy]
  const right: Curve = [
    (e.x - zx) / (1 - zx),
    (e.y - zy) / (1 - zy),
    (c.x - zx) / (1 - zx),
    (c.y - zy) / (1 - zy),
  ]

  // ⛔ A HALF THE RENDERER CANNOT DRAW IS NOT AN ANSWER. `bezierEase` clamps both
  // x control points into 0..1, which is what keeps time a function of time. A
  // curve whose own x handles are OUT OF ORDER (x2 below x1, the hard S a hand
  // can drag in the curve editor) splits into halves that need an x handle
  // outside that range, and the clamp then quietly reshapes them: measured at
  // 1.2e-2 off, two hundred times the solver's own floor. Say so instead.
  const drawable = (c2: Curve): boolean => c2[0] >= 0 && c2[0] <= 1 && c2[2] >= 0 && c2[2] <= 1
  if (!drawable(left) || !drawable(right)) return null

  return {
    left: { ease: kf.ease === 'hold' ? 'linear' : kf.ease, curve: left },
    right: { ease: kf.ease === 'hold' ? 'linear' : kf.ease, curve: right },
  }
}

/**
 * Value of a keyframe channel at time `t`. Empty list → `fallback`.
 * Before the first / after the last keyframe the value holds (clamps).
 * 'hold' easing steps: the value stays at the left keyframe until the right.
 * A left keyframe carrying a `curve` runs that bezier instead of its named ease,
 * so preview and export inherit hand-shaped curves through the one code path.
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
  return a.value + (b.value - a.value) * (a.curve ? bezierEase(a.curve, p) : ease(a.ease, p))
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

/**
 * Write a VALUE at `t`, keeping whatever shape already lives at that moment.
 *
 * ⛔ TYPING A NUMBER MUST NOT REDRAW A CURVE HE SHAPED BY HAND. Both write paths
 * used to stamp the shelf's current curve preference onto every write, so
 * shaping a segment in the curve editor and then correcting the Zoom in the
 * field silently threw the shape away and replaced it with whatever the dropdown
 * happened to say. Found by the keyframe audit, 2026-08-14, item 4.
 *
 * `shape` is what a moment gets when it has no shape of its OWN to keep.
 *
 * ⛔ AND "LINEAR WITH NO CURVE" IS NOT A SHAPE ANYONE CHOSE. It is the neutral
 * placeholder the arming path writes, and the write straight after it is what
 * gives the landed keyframe its snap curve. Treating that placeholder as a
 * decision made arming a clip from the gizmo produce a linear move, which is the
 * exact "reads as machinery" gap the curve is there to close: caught by
 * keyframe-tab.spec.ts on 2026-08-15, one ship after this function was written.
 *
 * So a moment keeps what it has only when it HAS something: a curve, or an ease
 * that is not the default. That is the line between a decision and a placeholder.
 */
export function upsertKeyframeValue(
  keyframes: readonly Keyframe[] | undefined,
  t: number,
  value: number,
  shape: { ease: Keyframe['ease']; curve?: Curve },
): Keyframe[] {
  const existing = (keyframes ?? []).find((k) => Math.abs(k.t - t) <= 1e-6)
  const chosen = existing && (existing.curve !== undefined || existing.ease !== 'linear')
  const kept = chosen ? existing : shape
  const kf: Keyframe = kept.curve ? { t, value, ease: kept.ease, curve: kept.curve } : { t, value, ease: kept.ease }
  return upsertKeyframe(keyframes, kf)
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
 * every animated channel it has: the transform/opacity channels and any
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
 * effect param at once. That is what a keyframe IS on the timeline: a moment,
 * not one channel's entry. A punch-in animating scale and both position
 * channels moves as one thing or it tears itself apart.
 *
 * `toT` is clamped inside the clip and kept strictly between the neighbouring
 * moments, so a drag can reorder nothing and no two moments can ever collide.
 * Returns the same clip when nothing moves.
 */
export function moveKeyframeMoment<C extends KeyframeCarrier>(
  clip: C,
  fromT: number,
  toT: number,
  durationS: number,
  /**
   * Closest a drag may park this moment to its neighbour. The default is the
   * bare arithmetic minimum that keeps them distinct; pass ONE FRAME from the UI
   * so the two never land on the same pixel, because two diamonds a fifth of a
   * millisecond apart are one diamond to the eye and the next drag grabs
   * whichever the DOM happens to list first.
   */
  minGapS = MOMENT_EPS * 2,
): C {
  const moments = clipKeyframeTimes(clip)
  const idx = moments.findIndex((t) => Math.abs(t - fromT) <= MOMENT_EPS)
  if (idx < 0) return clip

  // A moment may not pass its neighbours, and must stay inside the clip (BOTH,
  // not either). The clip bound used to apply only to the LAST moment, so one
  // keyframe left beyond the out point by a trim (the recompile guard leaves
  // hand-authored animation alone) became the only ceiling every earlier moment
  // was clamped against, and they could all be dragged past the end.
  const gap = Math.max(MOMENT_EPS * 2, minGapS)
  const dur = Math.max(0, durationS)
  const lo = idx > 0 ? moments[idx - 1] + gap : 0
  const hi = Math.min(idx < moments.length - 1 ? moments[idx + 1] - gap : dur, dur)
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

/**
 * Put `curve` on the segment LEAVING the keyframe at `segmentStartT`, which is
 * the keyframe that owns it. Passing undefined clears it back to the named ease.
 * Returns the same ref when no keyframe sits at that moment, so a caller can
 * skip the state write the way removeKeyframeNear already lets it.
 */
export function setSegmentCurve(
  keyframes: readonly Keyframe[] | undefined,
  segmentStartT: number,
  curve: Curve | undefined,
): Keyframe[] {
  const list = keyframes ?? []
  const idx = list.findIndex((k) => Math.abs(k.t - segmentStartT) <= MOMENT_EPS)
  if (idx < 0) return list as Keyframe[]
  return list.map((k, i) => {
    if (i !== idx) return k
    if (curve) return { ...k, curve }
    if (k.curve === undefined) return k
    return { t: k.t, value: k.value, ease: k.ease }
  })
}

/**
 * Stretch or squash a channel around `anchorT`: every keyframe keeps its
 * spacing relative to the anchor, scaled by `factor`, clamped inside the clip.
 *
 * `factor` must be positive: a zero or negative one would fold the move through
 * its anchor and reorder the keyframes, which is a different edit than the one
 * the Alt-drag gesture means. Non-positive or a no-op factor returns the same
 * ref. Clamping at either end can land two keyframes on the same moment, but it
 * can never swap them, because the sort is stable.
 */
export function scaleKeyframeSpan(
  keyframes: readonly Keyframe[] | undefined,
  anchorT: number,
  factor: number,
  durationS: number,
): Keyframe[] {
  const list = keyframes ?? []
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return list as Keyframe[]
  const dur = Math.max(0, durationS)
  const next = list.map((k) => {
    const t = anchorT + (k.t - anchorT) * factor
    return { ...k, t: Math.min(Math.max(t, 0), dur) }
  })
  next.sort((a, b) => a.t - b.t)
  return next
}

/**
 * Copy the keyframe at `t` to `toT`, carrying its value, its ease AND its curve.
 * That is what Alt-dragging a diamond means: the same shaped move, somewhere
 * else. Same ref when there is no keyframe at `t`.
 */
export function duplicateKeyframeAt(
  keyframes: readonly Keyframe[] | undefined,
  t: number,
  toT: number,
): Keyframe[] {
  const list = keyframes ?? []
  let bestIdx = -1
  let bestDist = Infinity
  list.forEach((k, i) => {
    const d = Math.abs(k.t - t)
    if (d <= MOMENT_EPS && d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  })
  if (bestIdx === -1) return list as Keyframe[]
  return upsertKeyframe(list, { ...list[bestIdx], t: toT })
}
