// TURNING A MOVE HE PERFORMED BY HAND INTO A TILE.
//
// HIS ASK, 2026-08-14: *"I wanted to maybe animate it with the preview. I can
// animate how I want it, and then I save it, and you just save the movements,
// and then I can completely customize it."* And on 2026-08-15, asked whether his
// move should stretch like the presets or replay exactly as recorded: *"I want it
// to be just like the built-in ten."*
//
// So this is the INVERSE of buildMove. It reads the keyframes a clip actually
// carries and works back to the normalised beats a MoveDef is made of, so his
// move takes the depth slider, the window bar, and any clip length, exactly as
// the ten do.
//
// ⛔ IT INVERTS THE REAL FORWARD MATHS, LINE FOR LINE. `buildMove` writes:
//
//     r      = 1 + d * (depth - 1)
//     travel = |r - 1|
//     scale  = base.scale * r
//     posX   = base.posX - (aim.x - 0.5) * seqWidth * travel + shift.x * seqWidth
//
// and every step below is one of those read backwards. If that maths moves, this
// moves with it, and the round-trip test is what says so out loud.

import { channelBase, channelKeyframes } from './effects/channels'
import { MOTION_CURVES, type MotionCurveName } from './motion'
import type { Beat, MoveDef } from './moves'
import { clipDurationS, type Clip, type Curve } from './types'

/** Two curves are the same shape within this, which is far tighter than the eye. */
const CURVE_EPS = 1e-6

/**
 * The NAME of a stored curve, or 'linear' when it has none and when it matches
 * nothing in the table.
 *
 * ⛔ A recorded move only ever carries curves the app itself wrote, because the
 * shelf's curve preference is what stamps them, so this table lookup covers
 * everything in practice. Falling back to 'linear' rather than inventing a name
 * keeps a hand-shaped bezier from being relabelled as something it is not.
 */
export function curveName(curve: Curve | undefined): MotionCurveName | 'linear' {
  if (!curve) return 'linear'
  for (const [name, c] of Object.entries(MOTION_CURVES)) {
    if (c.every((v, i) => Math.abs(v - curve[i]) <= CURVE_EPS)) return name as MotionCurveName
  }
  return 'linear'
}

export interface RecordContext {
  seqWidth: number
  seqHeight: number
}

/**
 * The beats a clip's own keyframes amount to, or null when there is no move on
 * it at all.
 *
 * ⛔ `d` IS ALLOWED OUTSIDE 0 TO 1 HERE, AND THAT IS DELIBERATE. The built-in
 * table keeps every `d` inside it because each of those moves runs one
 * direction, and a test pins that for the table. A move he performs may go
 * bigger AND smaller than his own framing in one take, and `r = 1 + d*(depth-1)`
 * expresses that perfectly well with a negative `d`. Clamping would quietly
 * flatten half of what he just recorded.
 *
 * ⛔ ALL of the travel goes into `shift`, and `aim` stays centred. The aim is
 * multiplied by how far the zoom sits from normal, so it carries nothing at all
 * at normal size; putting the path in the zoom-independent term is what makes
 * the round trip exact whatever his zoom happened to be doing.
 */
export function normaliseRecording(clip: Clip, ctx: RecordContext): MoveDef | null {
  const scaleK = channelKeyframes(clip, 'scale')
  const xK = channelKeyframes(clip, 'posX')
  const yK = channelKeyframes(clip, 'posY')
  if (scaleK.length === 0 && xK.length === 0 && yK.length === 0) return null

  const durS = clipDurationS(clip)
  if (!(durS > 0)) return null

  // Every moment any of the three channels marks. A hand recording can leave a
  // channel out of a beat entirely (he moved it sideways without resizing), and
  // dropping those moments would drop the shape.
  const times = [...new Set([...scaleK, ...xK, ...yK].map((k) => k.t))].sort((a, b) => a - b)
  if (times.length === 0) return null

  const baseScale = channelBase(clip, 'scale')
  const baseX = channelBase(clip, 'posX')
  const baseY = channelBase(clip, 'posY')
  if (!(baseScale > 0)) return null

  const at = (kfs: readonly { t: number; value: number }[], t: number, fallback: number): number => {
    if (kfs.length === 0) return fallback
    // The value the RENDERER would show at t, which is the only honest reading:
    // between two moments a channel is interpolating, not holding.
    let prev = kfs[0]
    for (const k of kfs) {
      if (Math.abs(k.t - t) <= 1e-9) return k.value
      if (k.t < t) prev = k
      else {
        const span = k.t - prev.t
        return span <= 0 ? k.value : prev.value + ((t - prev.t) / span) * (k.value - prev.value)
      }
    }
    return prev.value
  }

  // The depth is the size FURTHEST from his own framing, which is the same rule
  // matchMove reads a depth back with. It is what makes a recording that only
  // ever shrinks come out as a pull-back rather than as depth 1.
  let depth = 1
  for (const k of scaleK) {
    const r = k.value / baseScale
    if (Math.abs(r - 1) > Math.abs(depth - 1)) depth = r
  }

  const w0 = times[0]
  const w1 = times[times.length - 1]
  const span = w1 - w0

  const beats: Beat[] = times.map((t) => {
    const r = at(scaleK, t, baseScale) / baseScale
    // A recording that never resized has depth 1, and then every beat is at the
    // clip's own size: d is 0 rather than a division by zero.
    const d = Math.abs(depth - 1) <= 1e-9 ? 0 : (r - 1) / (depth - 1)
    const curve = curveName(scaleK.find((k) => Math.abs(k.t - t) <= 1e-9)?.curve)
    return {
      at: span > 0 ? { frac: (t - w0) / span } : { frames: 0 },
      d,
      aim: { x: 0.5, y: 0.5 },
      shift: {
        x: (at(xK, t, baseX) - baseX) / ctx.seqWidth,
        y: (at(yK, t, baseY) - baseY) / ctx.seqHeight,
      },
      curve,
    }
  })

  return {
    // A draft id until state/myMoves.ts mints the real one on save. It is in
    // the `mym-` shape so it is never mistaken for a built-in tile.
    id: 'mym-draft',
    name: 'My move',
    hint: 'The move you performed on the picture, saved',
    window: 'clip',
    beats,
    // The size he recorded it at, so re-applying it with the slider untouched
    // gives back what he saw rather than the shelf's current preference.
    recordedDepth: depth,
  }
}
