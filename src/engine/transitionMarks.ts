// Where a transition's mark belongs on the timeline, per clip edge. Pure: no
// React, no DOM, no store.
//
// A pair transition is STORED on one clip (B.transitionIn or A.transitionOut)
// but it PLAYS across the cut: resolve.ts runs its window at B's head and keeps
// sampling A past its out point through it. Drawing the mark only on the clip
// that happens to own the field left the other half of the dissolve invisible -
// the grass faded out with nothing on the incoming clip to say so.
//
// The lengths come from pairTransitionWindow, so a mark can never claim a
// duration the renderer will not honour: B.transitionIn winning over
// A.transitionOut, the clamp to the SHORTER of the two clips, the one-frame
// floor, and the adjacency / enabled / adjustment rules are all already in
// there. The no-partner fallback mirrors resolveTrack's own lone-edge clamp.

import { pairTransitionWindow } from './preview'
import { clipDurationS, type Clip, type Transition } from './types'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

export interface TransitionMarkSpans {
  /**
   * Seconds at this clip's HEAD, 0 when there is no mark. For an incoming clip
   * this is literally the renderer's window: its first `headS` seconds are the
   * transition, not the plain clip.
   */
  headS: number
  /**
   * Seconds at this clip's TAIL, 0 when there is no mark. For an outgoing clip
   * the window itself sits just PAST this edge (the renderer pulls this clip's
   * picture from beyond its out point for exactly this long), so the mark reads
   * as "this much of me is still on screen after the cut".
   */
  tailS: number
}

/** No partner on that side, so the window lives wholly inside this clip. Mirrors resolveTrack. */
const loneEdgeS = (tr: Transition | undefined, clip: Clip, fps: number): number =>
  tr ? clamp(tr.durationS, 1 / fps, clipDurationS(clip)) : 0

/**
 * The real transition spans at both edges of `clip`, given its neighbours on
 * the same track (undefined at the ends of the track). Asymmetric by design:
 * the two edges are computed independently and a pair's own clamps can differ
 * from the raw `durationS` the user typed.
 */
export function transitionMarkSpans(
  clip: Clip,
  prev: Clip | undefined,
  next: Clip | undefined,
  fps: number,
): TransitionMarkSpans {
  const inWin = prev ? pairTransitionWindow(prev, clip, fps) : null
  const outWin = next ? pairTransitionWindow(clip, next, fps) : null
  return {
    headS: inWin ? inWin.endS - inWin.startS : loneEdgeS(clip.transitionIn, clip, fps),
    tailS: outWin ? outWin.endS - outWin.startS : loneEdgeS(clip.transitionOut, clip, fps),
  }
}

export interface TransitionMarkPx {
  headPx: number
  tailPx: number
}

/**
 * Mark widths in px. Each edge caps at half the DRAWN clip, or two long marks
 * on a short clip would draw past each other. That cap is per clip, which is
 * why one transition can legitimately come out two different widths: a 2 s
 * dissolve onto a 0.6 s incoming clip really runs 0.6 s, drawn as 0.3 s of mark
 * on that clip and the full 0.6 s on the long outgoing one. The MARK is capped,
 * never the transition.
 */
export function transitionMarkPx(
  spans: TransitionMarkSpans,
  pxPerS: number,
  widthPx: number,
): TransitionMarkPx {
  const halfPx = widthPx / 2
  return {
    headPx: Math.min(halfPx, spans.headS * pxPerS),
    tailPx: Math.min(halfPx, spans.tailS * pxPerS),
  }
}
