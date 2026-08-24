// What the "How big" number says, kept out of the React tree so the wording can
// be argued with in a diff and pinned by tests.
//
// ⛔ IT USED TO BE `pct(depth)` AND THAT IS WHY IT READ AS BROKEN, 2026-08-24.
// His words: *"When I drag it, it just breaks and shows different percentages."*
//
// The slider runs 0.5 to 2, and the readout printed `depth * 100`. So at a depth
// of 0.96 the HANDLE sits at (0.96 - 0.5) / 1.5 = 31 percent of its track while
// the number beside it says 96 percent. Both are "right" and they are percentages
// of two different things, sitting at the same eye level, one of them under a
// handle whose position contradicts it. There is no way to read that as anything
// but a bug, because from where he is sitting it IS one.
//
// A depth is a SCALE, not a position, so the fix is to stop printing it as a bare
// percentage and say which way it goes and by how much. "in 40%" and "out 4%"
// move in the same direction as the handle, hit zero exactly where the slider's
// middle is, and can never be mistaken for a position on the track.

/** Neutral, and the one value the slider cannot settle on. See NEUTRAL_BAND. */
const NEUTRAL = 1

export interface DepthLabel {
  /** What is printed next to the slider. */
  text: string
  /** 'in' pushes the picture closer, 'out' pulls it back, 'none' is the dead middle. */
  direction: 'in' | 'out' | 'none'
  /** How far from neutral, as whole percent. Always positive. */
  amountPct: number
}

/**
 * The readout for a move depth.
 *
 * Rounds the AMOUNT, never the depth, so a value that is a hair off neutral reads
 * as the smallest real move rather than as no move at all: the slider refuses to
 * settle on exactly 1, and a readout that says "0%" over a move that is really
 * happening would be the same lie in a smaller font.
 */
export function depthLabel(depth: number): DepthLabel {
  if (!Number.isFinite(depth) || depth === NEUTRAL) return { text: 'none', direction: 'none', amountPct: 0 }
  const away = Math.abs(depth - NEUTRAL) * 100
  // Never round a real move down to nothing.
  const amountPct = Math.max(1, Math.round(away))
  const direction = depth > NEUTRAL ? 'in' : 'out'
  return { text: `${direction} ${amountPct}%`, direction, amountPct }
}

/**
 * Where a depth sits along the slider, 0..1, so the middle marker and the handle
 * are drawn from one number instead of two that can disagree.
 */
export function depthTrackFrac(depth: number, min: number, max: number): number {
  if (!(max > min)) return 0
  return Math.min(1, Math.max(0, (depth - min) / (max - min)))
}
