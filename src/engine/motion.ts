// The Jettism Motion Pack's pure keyframe builders: punch-in zoom, punch-out
// fall, impact hit, speed ramp. Everything writes ordinary clip keyframe
// channels (or splits + Clip.speed), so it renders through the same
// resolve/evalChannel path in preview and export, stays fully hand-editable
// afterwards, and merges with whatever keyframes the clip already carries.
// Pure: no store, no DOM.

import { channelBase, channelKeyframes, resolveChannel, withChannelKeyframes } from './effects/channels'
import { upsertKeyframe } from './keyframes'
import { clipEndS, recomputeDuration, setClipSpeed, splitClip } from './timeline'
import type { AnimChannel, Clip, Curve, EffectInstance, Id, Keyframe, Sequence } from './types'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/**
 * The one curve table, cubic-bezier in CSS `cubic-bezier(x1, y1, x2, y2)` order.
 *
 * The builders below and the curve chips in the Inspector both read THIS, so the
 * move a one-click preset writes and the chip claiming to be that move can never
 * drift apart: a second table would go stale the first time one of these six
 * numbers is tuned.
 */
export const MOTION_CURVES = {
  /** Arriving with emphasis: the punch. */
  snapIn: [0.16, 1, 0.3, 1] as Curve,
  /** Softer arrival: the reveal. */
  settle: [0.23, 1, 0.32, 1] as Curve,
  /** Continuous at both ends: the slow push. */
  smooth: [0.37, 0, 0.63, 1] as Curve,
  /** Leaving: the whip out. */
  windUp: [0.5, 0, 1, 1] as Curve,
  /** Travels past the target and comes back. y over 1 on purpose. */
  overshoot: [0.34, 1.56, 0.64, 1] as Curve,
  /** The generic safe default: After Effects' 33.33 percent on both sides. */
  easyEase: [0.33, 0, 0.67, 1] as Curve,
}

/** A key of MOTION_CURVES: what the UI stores and the curve chips address. */
export type MotionCurveName = keyof typeof MOTION_CURVES

/**
 * The named ease each curve degrades to, beside the curve table so there is ONE
 * pairing rather than two that drift.
 *
 * A keyframe carrying a curve renders through that curve everywhere in this
 * build, so `ease` is only what anything that has not learned `curve` reads: an
 * older build, or a project opened after a validator strips the field. A punch
 * written by a preset and one written by a drag therefore lean the same way.
 */
export const CURVE_EASE: Readonly<Record<MotionCurveName, Keyframe['ease']>> = {
  snapIn: 'easeOut',
  settle: 'easeOut',
  smooth: 'easeInOut',
  windUp: 'easeIn',
  overshoot: 'easeOut',
  easyEase: 'easeInOut',
}

/**
 * Merge a run of keyframes into one channel of a clip (immutably).
 *
 * Goes through the channel adapter, NOT `clip.keyframes` directly: transform
 * channels live on the clip but the colour channels ('saturation', 'blur') are
 * addresses into `clip.effects`, and the renderer only ever reads colour out of
 * the effect stack. Writing those straight to `clip.keyframes` produced
 * keyframes nothing rendered until a reload, at which point the legacy migration
 * moved them into real effects and the same project suddenly graded differently.
 */
export function withKeyframes(clip: Clip, channel: AnimChannel, kfs: Keyframe[]): Clip {
  let list: readonly Keyframe[] = channelKeyframes(clip, channel)
  for (const kf of kfs) list = upsertKeyframe(list, kf)
  return withChannelKeyframes(clip, channel, [...list])
}

const durS = (clip: Clip): number => (clip.outS - clip.inS) / (Math.abs(clip.speed) || 1)

/**
 * One knot of a zoom envelope: a moment, the ratio `r` of the resting scale
 * there, and the easing of the segment LEAVING it. `curve` wins over `ease`
 * when both are present; the named ease stays as the shape the segment falls
 * back to if the curve is ever cleared in the editor.
 */
interface Knot {
  t: number
  r: number
  ease: Keyframe['ease']
  curve?: Curve
}

/** A knot as a real keyframe, carrying `curve` only when it has one. */
const knotKeyframe = (k: Knot, value: number): Keyframe =>
  k.curve ? { t: k.t, value, ease: k.ease, curve: k.curve } : { t: k.t, value, ease: k.ease }

export interface PunchInOptions {
  /** Sequence time of the punch. */
  atS: number
  targetScale?: number
  riseFrames?: number
  holdS?: number
  returnS?: number
  /**
   * Arrive at the target and STAY there for the rest of the clip: the envelope
   * stops at the top of the rise and the hold/return knots are never written.
   * This is what a punch in actually means to him, and it is also what makes
   * "punch out at any time in the clip" a thing he can ask for, because the
   * frame is no longer scheduled to slide back on its own.
   */
  holdToEnd?: boolean
  /**
   * Zoom toward this point (sequence px, frame coordinates). The position
   * shifts so the focal point holds still while the frame scales around it.
   * Requires seqWidth/seqHeight to know where the frame center is.
   */
  focal?: { x: number; y: number }
  seqWidth?: number
  seqHeight?: number
}

/**
 * The workhorse zoom: rise to the target over riseFrames on the snap curve,
 * then either hold to the end of the clip (holdToEnd) or hold and ease back.
 * Scales stack relative to whatever the scale channel already evaluates to at
 * that moment.
 */
export function punchInClip(clip: Clip, fps: number, options: PunchInOptions): Clip {
  const target = options.targetScale ?? 1.2
  const riseS = (options.riseFrames ?? 5) / (fps || 30)
  const holdS = options.holdS ?? 0.5
  const returnS = options.returnS ?? 0.25
  const at = clamp(options.atS - clip.startS, 0, Math.max(0, durS(clip) - riseS))
  const base = resolveChannel(clip, 'scale', at)
  // Envelope shape shared by scale and (when focal) position: ratio r of the
  // resting scale at each knot.
  const knots: Knot[] = [
    // Rise segment: fast in, soft landing. The snap curve is the shape, easeOut
    // is only the named fallback under it.
    { t: at, r: 1, ease: 'easeOut', curve: MOTION_CURVES.snapIn },
    { t: at + riseS, r: target, ease: 'linear' },
  ]
  // The hold-and-return legs survive for punchOnBeats, where a ladder of
  // sixteen non-returning punches would climb to nonsense.
  if (!options.holdToEnd) {
    knots.push(
      { t: at + riseS + holdS, r: target, ease: 'easeInOut' },
      { t: at + riseS + holdS + returnS, r: 1, ease: 'linear' },
    )
  }
  let next = withKeyframes(
    clip,
    'scale',
    knots.map((k) => knotKeyframe(k, base * k.r)),
  )
  if (options.focal && options.seqWidth && options.seqHeight) {
    // Keep the focal point still: a point f px from center lands at f*r after
    // scaling, so the layer shifts by -f*(r-1).
    const fx = options.focal.x - options.seqWidth / 2
    const fy = options.focal.y - options.seqHeight / 2
    const xBase = resolveChannel(clip, 'posX', at)
    const yBase = resolveChannel(clip, 'posY', at)
    next = withKeyframes(next, 'posX', knots.map((k) => knotKeyframe(k, xBase - fx * (k.r - 1))))
    next = withKeyframes(next, 'posY', knots.map((k) => knotKeyframe(k, yBase - fy * (k.r - 1))))
  }
  return next
}

export interface PunchOutOptions {
  /** Sequence time the fall starts. */
  atS: number
  /** Frames the fall takes. Same 200ms shape as the rise it undoes. */
  riseFrames?: number
  /**
   * Bring the framing home as part of the fall, not just the scale.
   *
   * The fall used to need an AIM here, because it re-derived its starting
   * position from the clip's static base and this point. It does not any more:
   * it reads where the picture actually is at that moment and carries that, so
   * there is nothing left to aim (see the position block below). The three
   * fields survive only as the caller's opt-in to moving position at all, and
   * the values are no longer read.
   */
  focal?: { x: number; y: number }
  seqWidth?: number
  seqHeight?: number
}

/**
 * The other half of the verb: fall from wherever the scale currently sits back
 * to the clip's own base over riseFrames on the snap curve, and hold there.
 *
 * The landing is `channelBase`, not the value at some earlier keyframe, because
 * base is the framing the clip is DEFINED to have. Anything else drifts a little
 * further from it on every punch in and out, and the drift only shows up on
 * export. Position lands on its base for the same reason, so a punch in followed
 * by a punch out ends exactly where the clip started rather than a few pixels
 * off centre.
 */
export function punchOutClip(clip: Clip, fps: number, options: PunchOutOptions): Clip {
  const fallS = (options.riseFrames ?? 5) / (fps || 30)
  const at = clamp(options.atS - clip.startS, 0, Math.max(0, durS(clip) - fallS))
  const base = channelBase(clip, 'scale')
  const from = resolveChannel(clip, 'scale', at)
  const knots: Knot[] = [
    { t: at, r: base !== 0 ? from / base : 1, ease: 'easeOut', curve: MOTION_CURVES.snapIn },
    { t: at + fallS, r: 1, ease: 'linear' },
  ]
  let next = withKeyframes(
    clip,
    'scale',
    knots.map((k) => knotKeyframe(k, base * k.r)),
  )
  if (options.focal && options.seqWidth && options.seqHeight) {
    // Start the fall from where the picture ACTUALLY IS, and land it on base.
    //
    // This used to re-derive the starting position from `channelBase` and the
    // aim, which is the same number only when nothing has touched the framing
    // since the punch in. Move the framing by hand first (push in on the left,
    // then travel across to the right) and that derived value was written over
    // the top of the travel: the picture snapped back toward centre at the
    // punch-out moment and the whole middle of the move disappeared, with no
    // toast, no warning and nothing on any lane to show what had gone. Reading
    // the live value at the knot's OWN time with `resolveChannel` is what
    // punchInClip does, and this now matches it.
    //
    // The LANDING stays `channelBase` on purpose: at the base scale there is
    // nowhere left to look, base is the framing the clip is defined to have,
    // and anything else drifts a little further from it on every in/out pair.
    for (const channel of ['posX', 'posY'] as const) {
      const live = resolveChannel(clip, channel, at)
      const home = channelBase(clip, channel)
      // Already home: writing two identical keyframes would only add a flat
      // lane of diamonds that do nothing.
      if (Math.abs(live - home) < 1e-6) continue
      next = withKeyframes(next, channel, [knotKeyframe(knots[0], live), knotKeyframe(knots[1], home)])
    }
  }
  return next
}

export interface ImpactOptions {
  /** Sequence time of the beat. */
  atS: number
  durS?: number
  /** Remaining saturation at the hit (0.1 = almost grey). */
  desat?: number
  blurPx?: number
  scale?: number
  shakePx?: number
}

/**
 * The phonk "freeze on the drop": a brief desaturate + blur + slight punch
 * (and a 2px shake) centered on the beat, then snap back. All through clip
 * filter/transform channels: in-shader, keyframeable, hand-editable.
 */
export function impactClip(clip: Clip, fps: number, options: ImpactOptions): Clip {
  const winS = options.durS ?? 0.2
  const f3 = 3 / (fps || 30)
  const at = clamp(options.atS - clip.startS, winS / 2 + f3, Math.max(0, durS(clip) - winS / 2 - f3))
  const t1 = at - winS / 2
  const t2 = at + winS / 2

  const pulse = (baseValue: number, hitValue: number): Keyframe[] => [
    { t: t1 - f3, value: baseValue, ease: 'easeOut', curve: MOTION_CURVES.snapIn },
    { t: t1, value: hitValue, ease: 'linear' },
    { t: t2, value: hitValue, ease: 'easeIn' },
    { t: t2 + f3, value: baseValue, ease: 'linear' },
  ]

  const satBase = resolveChannel(clip, 'saturation', at)
  const blurBase = resolveChannel(clip, 'blur', at)
  const scaleBase = resolveChannel(clip, 'scale', at)

  let next = withKeyframes(clip, 'saturation', pulse(satBase, clamp((options.desat ?? 0.1) - 1, -1, 0)))
  next = withKeyframes(next, 'blur', pulse(blurBase, options.blurPx ?? 6))
  next = withKeyframes(next, 'scale', pulse(scaleBase, scaleBase * (options.scale ?? 1.08)))

  const shake = options.shakePx ?? 2
  if (shake > 0) {
    const xBase = resolveChannel(clip, 'posX', at)
    const f1 = 1 / (fps || 30)
    next = withKeyframes(next, 'posX', [
      { t: t1, value: xBase, ease: 'linear' },
      { t: t1 + f1, value: xBase + shake, ease: 'linear' },
      { t: t1 + 2 * f1, value: xBase - shake * 0.6, ease: 'linear' },
      { t: t1 + 3 * f1, value: xBase + shake * 0.3, ease: 'linear' },
      { t: Math.max(t2, t1 + 4 * f1), value: xBase, ease: 'linear' },
    ])
  }
  return next
}

export interface WhipOptions {
  frames?: number
  maxStrength?: number
  angleDeg?: number
  /** Scale push at the cut (1.0 → this on each side). */
  push?: number
}

/**
 * Whip transition across a hard cut: directional blur ramps 0→max over the
 * last frames of A and max→0 over the first frames of B, with a small scale
 * push on each side. Both clips stay independent, since it's two effect instances
 * plus scale keyframes, all hand-editable afterwards.
 */
export function whipClips(
  a: Clip,
  b: Clip,
  fps: number,
  idFor: () => Id,
  options: WhipOptions = {},
): { a: Clip; b: Clip } {
  const f = (options.frames ?? 3) / (fps || 30)
  const max = options.maxStrength ?? 1
  const angleDeg = options.angleDeg ?? 0
  const push = options.push ?? 1.06

  const blurOut: EffectInstance = {
    id: idFor(),
    type: 'directionalBlur',
    enabled: true,
    params: {
      angleDeg,
      strength: {
        value: 0,
        keyframes: [
          // Leaving: windUp on the outgoing half, settle on the incoming one.
          // The pair is deliberately asymmetric, which is what makes a whip read
          // as one move across the cut rather than two mirrored ramps.
          { t: Math.max(0, durS(a) - f), value: 0, ease: 'easeIn', curve: MOTION_CURVES.windUp },
          { t: durS(a), value: max, ease: 'linear' },
        ],
      },
    },
  }
  const blurIn: EffectInstance = {
    id: idFor(),
    type: 'directionalBlur',
    enabled: true,
    params: {
      angleDeg,
      strength: {
        value: 0,
        keyframes: [
          { t: 0, value: max, ease: 'easeOut', curve: MOTION_CURVES.settle },
          { t: Math.min(durS(b), f), value: 0, ease: 'linear' },
        ],
      },
    },
  }

  const aScale = resolveChannel(a, 'scale', durS(a))
  const bScale = resolveChannel(b, 'scale', 0)
  const outA = withKeyframes({ ...a, effects: [...a.effects, blurOut] }, 'scale', [
    { t: Math.max(0, durS(a) - f), value: aScale, ease: 'easeIn' },
    { t: durS(a), value: aScale * push, ease: 'linear' },
  ])
  const outB = withKeyframes({ ...b, effects: [...b.effects, blurIn] }, 'scale', [
    { t: 0, value: bScale * push, ease: 'easeOut' },
    { t: Math.min(durS(b), f), value: bScale, ease: 'linear' },
  ])
  return { a: outA, b: outB }
}

/** A light in-shader blur that reads as motion smear on sped-up footage. */
export const RAMP_MOTION_BLUR_PX = 2.5
/** Above this factor the sped segment gets the motion blur automatically. */
export const RAMP_BLUR_THRESHOLD = 1.5

export interface RampResult {
  seq: Sequence
  /** The sped middle piece (null when the range collapsed to nothing). */
  middleId: Id | null
}

/**
 * Speed-ramp [startS, endS) of a clip: split at both bounds, set the middle
 * piece's speed, and auto-apply a light blur when it plays fast. Split edges
 * within one frame of a clip edge no-op (the sliver guard), so the ramp simply
 * extends to that clip edge.
 *
 * The rate change goes through `setClipSpeed`, which ripples the tail when the
 * middle piece GROWS. Slow motion (factor < 1) lengthens it, and without the
 * ripple it overlapped the piece after it: two clips at the same time on one
 * track, which breaks the resolver's sorted/non-overlapping invariant and makes
 * the tail of the slow-motion invisible. Speeding up still just leaves a gap.
 */
export function rampSpeedRange(
  seq: Sequence,
  clipId: Id,
  startS: number,
  endS: number,
  factor: number,
  blurEffectId: () => Id,
): RampResult {
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!track || !clip || factor <= 0) return { seq, middleId: null }
  const lo = Math.max(clip.startS, Math.min(startS, endS))
  const hi = Math.min(clipEndS(clip), Math.max(startS, endS))
  if (hi - lo <= 0) return { seq, middleId: null }

  // Split right bound first so the left piece keeps the original id.
  let next = splitClip(seq, clipId, hi)
  next = splitClip(next, clipId, lo)
  const midT = (Math.max(lo, clip.startS) + Math.min(hi, clipEndS(clip))) / 2
  const nextTrack = next.tracks.find((t) => t.id === track.id)!
  const middle = nextTrack.clips.find((c) => c.startS <= midT && midT < clipEndS(c))
  if (!middle) return { seq, middleId: null }

  const blurred: Clip = {
    ...middle,
    effects:
      factor > RAMP_BLUR_THRESHOLD
        ? [
            ...middle.effects,
            { id: blurEffectId(), type: 'gaussianBlur', enabled: true, params: { blur: RAMP_MOTION_BLUR_PX } },
          ]
        : middle.effects,
  }
  next = {
    ...next,
    tracks: next.tracks.map((t) =>
      t.id === track.id ? { ...t, clips: t.clips.map((c) => (c.id === middle.id ? blurred : c)) } : t,
    ),
  }
  // The rate change LAST, through the op that owns the ripple.
  next = setClipSpeed(next, middle.id, (middle.speed < 0 ? -1 : 1) * factor)
  return { seq: recomputeDuration(next), middleId: middle.id }
}
