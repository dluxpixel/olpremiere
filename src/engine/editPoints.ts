// Edit-point navigation: the set of "cuts" the playhead can jump between, and
// the previous/next cut relative to a time. Powers the ',' / '.' and Up/Down
// "jump to cut" transport shortcuts. Pure: no React, no DOM, no store, only the
// document model and the clip-end helper from the timeline engine.
//
// An edit point is any clip start or clip end on any track, plus t=0 (so the
// head can always return to the head of the sequence). Two edges within EPS of
// each other (e.g. a video cut and an audio cut both at 2s) collapse to one.

import { clipEndS } from './timeline'
import type { Sequence } from './types'

// Coarser than the timeline's 1e-9 float tolerance: edit points are the
// user-visible cut times that have been through px->time round-trips, so
// near-equal edges across lanes must dedupe to a single point.
const EPS = 1e-6

/**
 * The sorted, de-duplicated set of all clip start and end times across every
 * track, always including 0. Pass `{ unlockedOnly: true }` to skip the cuts on
 * locked tracks (so a "jump to cut" that only edits unlocked lanes ignores
 * them). Times within EPS of one another collapse to a single point, so a video
 * cut at 2 and an audio cut at 2 yield one 2, not two.
 */
export function editPoints(seq: Sequence, opts?: { unlockedOnly?: boolean }): number[] {
  const unlockedOnly = opts?.unlockedOnly ?? false
  const times: number[] = [0]
  for (const track of seq.tracks) {
    if (unlockedOnly && track.locked) continue
    for (const clip of track.clips) {
      times.push(clip.startS)
      times.push(clipEndS(clip))
    }
  }
  times.sort((a, b) => a - b)

  const out: number[] = []
  for (const t of times) {
    // Sorted, so only the last kept point can be within EPS of this one.
    if (out.length === 0 || t - out[out.length - 1] > EPS) out.push(t)
  }
  return out
}

/**
 * The nearest edit point strictly after `tS` (by more than EPS), so a playhead
 * parked exactly on a cut advances to the NEXT cut rather than sticking. When
 * there is none (the head is at or past the last cut), returns the last edit
 * point, i.e. the end of the timeline, so the shortcut is a no-op at the tail
 * instead of jumping backward.
 */
export function nextEditPoint(seq: Sequence, tS: number): number {
  const points = editPoints(seq)
  for (const p of points) {
    if (p - tS > EPS) return p
  }
  return points[points.length - 1]
}

/**
 * The nearest edit point strictly before `tS` (by more than EPS), so a playhead
 * parked exactly on a cut steps back to the PREVIOUS cut. When there is none
 * (the head is at or before the first cut), returns 0.
 */
export function prevEditPoint(seq: Sequence, tS: number): number {
  const points = editPoints(seq)
  for (let i = points.length - 1; i >= 0; i--) {
    if (tS - points[i] > EPS) return points[i]
  }
  return 0
}
