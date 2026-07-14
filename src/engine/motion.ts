// The Jettism Motion Pack's pure keyframe builders: punch-in zoom, impact hit,
// speed ramp. Everything writes ordinary clip keyframe channels (or splits +
// Clip.speed), so it renders through the same resolve/evalChannel path in
// preview and export, stays fully hand-editable afterwards, and merges with
// whatever keyframes the clip already carries. Pure: no store, no DOM.

import { evalChannel, upsertKeyframe } from './keyframes'
import { clipEndS, recomputeDuration, splitClip } from './timeline'
import type { AnimChannel, Clip, EffectInstance, Id, Keyframe, Sequence } from './types'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** Merge a run of keyframes into one channel of a clip (immutably). */
function withKeyframes(clip: Clip, channel: AnimChannel, kfs: Keyframe[]): Clip {
  let list = clip.keyframes?.[channel]
  for (const kf of kfs) list = upsertKeyframe(list, kf)
  return { ...clip, keyframes: { ...clip.keyframes, [channel]: list! } }
}

const durS = (clip: Clip): number => (clip.outS - clip.inS) / (Math.abs(clip.speed) || 1)

export interface PunchInOptions {
  /** Sequence time of the punch. */
  atS: number
  targetScale?: number
  riseFrames?: number
  holdS?: number
  returnS?: number
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
 * The workhorse zoom: hold, fast-in/soft-out rise to the target over
 * riseFrames, hold, ease back. Scales stack relative to whatever the scale
 * channel already evaluates to at that moment.
 */
export function punchInClip(clip: Clip, fps: number, options: PunchInOptions): Clip {
  const target = options.targetScale ?? 1.2
  const riseS = (options.riseFrames ?? 5) / (fps || 30)
  const holdS = options.holdS ?? 0.5
  const returnS = options.returnS ?? 0.25
  const at = clamp(options.atS - clip.startS, 0, Math.max(0, durS(clip) - riseS))
  const base = evalChannel(clip.keyframes?.scale, at, clip.transform.scale)
  // Envelope shape shared by scale and (when focal) position: ratio r of the
  // resting scale at each knot.
  const knots: { t: number; r: number; ease: Keyframe['ease'] }[] = [
    { t: at, r: 1, ease: 'easeOut' }, // rise segment: fast in, soft landing
    { t: at + riseS, r: target, ease: 'linear' },
    { t: at + riseS + holdS, r: target, ease: 'easeInOut' },
    { t: at + riseS + holdS + returnS, r: 1, ease: 'linear' },
  ]
  let next = withKeyframes(
    clip,
    'scale',
    knots.map((k) => ({ t: k.t, value: base * k.r, ease: k.ease })),
  )
  if (options.focal && options.seqWidth && options.seqHeight) {
    // Keep the focal point still: a point f px from center lands at f*r after
    // scaling, so the layer shifts by -f*(r-1).
    const fx = options.focal.x - options.seqWidth / 2
    const fy = options.focal.y - options.seqHeight / 2
    const xBase = evalChannel(clip.keyframes?.posX, at, clip.transform.x)
    const yBase = evalChannel(clip.keyframes?.posY, at, clip.transform.y)
    next = withKeyframes(next, 'posX', knots.map((k) => ({ t: k.t, value: xBase - fx * (k.r - 1), ease: k.ease })))
    next = withKeyframes(next, 'posY', knots.map((k) => ({ t: k.t, value: yBase - fy * (k.r - 1), ease: k.ease })))
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
 * filter/transform channels — in-shader, keyframeable, hand-editable.
 */
export function impactClip(clip: Clip, fps: number, options: ImpactOptions): Clip {
  const winS = options.durS ?? 0.2
  const f3 = 3 / (fps || 30)
  const at = clamp(options.atS - clip.startS, winS / 2 + f3, Math.max(0, durS(clip) - winS / 2 - f3))
  const t1 = at - winS / 2
  const t2 = at + winS / 2

  const pulse = (baseValue: number, hitValue: number): Keyframe[] => [
    { t: t1 - f3, value: baseValue, ease: 'easeOut' },
    { t: t1, value: hitValue, ease: 'linear' },
    { t: t2, value: hitValue, ease: 'easeIn' },
    { t: t2 + f3, value: baseValue, ease: 'linear' },
  ]

  const satBase = evalChannel(clip.keyframes?.saturation, at, clip.filters?.saturation ?? 0)
  const blurBase = evalChannel(clip.keyframes?.blur, at, clip.filters?.blur ?? 0)
  const scaleBase = evalChannel(clip.keyframes?.scale, at, clip.transform.scale)

  let next = withKeyframes(clip, 'saturation', pulse(satBase, clamp((options.desat ?? 0.1) - 1, -1, 0)))
  next = withKeyframes(next, 'blur', pulse(blurBase, options.blurPx ?? 6))
  next = withKeyframes(next, 'scale', pulse(scaleBase, scaleBase * (options.scale ?? 1.08)))

  const shake = options.shakePx ?? 2
  if (shake > 0) {
    const xBase = evalChannel(clip.keyframes?.posX, at, clip.transform.x)
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
 * push on each side. Both clips stay independent — it's two effect instances
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
          { t: Math.max(0, durS(a) - f), value: 0, ease: 'easeIn' },
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
          { t: 0, value: max, ease: 'easeOut' },
          { t: Math.min(durS(b), f), value: 0, ease: 'linear' },
        ],
      },
    },
  }

  const aScale = evalChannel(a.keyframes?.scale, durS(a), a.transform.scale)
  const bScale = evalChannel(b.keyframes?.scale, 0, b.transform.scale)
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
 * extends to that clip edge. NOTE: speeding up shortens the middle piece and
 * leaves a gap before the right piece — rate changes never ripple here.
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

  const sped: Clip = {
    ...middle,
    speed: (middle.speed < 0 ? -1 : 1) * factor,
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
      t.id === track.id ? { ...t, clips: t.clips.map((c) => (c.id === middle.id ? sped : c)) } : t,
    ),
  }
  return { seq: recomputeDuration(next), middleId: middle.id }
}
