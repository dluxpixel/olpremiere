// Say which tracks a ripple left where they were.
//
// A ripple carries every sync locked track along with the cut, except a track
// that would have ended up with one clip on top of another: a caption over a
// caption, two of his voice takes playing at once. That track keeps its own
// timing (see `syncFollowEdits` in engine/timeline.ts), and this is the one
// plain line that tells him so, so a track out of step after the cut is never
// a surprise he finds later.

import type { RippleReport } from '../engine/timeline'
import type { Sequence } from '../engine/types'

/** A report to hand a ripple verb: it lists the tracks it held back. */
export const newRippleReport = (): RippleReport => ({ heldTrackIds: [], lockedTrackIds: [] })

/** "A1" or "A1 and A2", in the sequence's own track order, each named once. */
function trackList(seq: Sequence, ids: readonly string[]): string[] {
  const want = new Set(ids)
  return seq.tracks.filter((t) => want.has(t.id)).map((t) => t.name)
}
const joined = (names: readonly string[]): string =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * Why a gap close held, naming the lock: a clip that had to move is linked to
 * one on a locked track. `all` is Close all gaps, which still closed the gaps
 * it could; a single close moved nothing. Null when no lock held it.
 */
export function lockedGapMessage(seq: Sequence, report: RippleReport, all: boolean): string | null {
  const names = trackList(seq, report.lockedTrackIds ?? [])
  if (names.length === 0) return null
  const which = names.length === 1 ? 'which is locked' : 'which are locked'
  return all
    ? `Some gaps stayed open: a clip after them is linked to one on ${joined(names)}, ${which}`
    : `The gap stayed open: a clip after it is linked to one on ${joined(names)}, ${which}`
}

/**
 * "Captions kept its timing: something on it sits in the part you cut", or
 * null when every track followed. Track names come from `seq`, the sequence the
 * edit started from, in its own track order, each named once.
 */
export function keptTimingMessage(seq: Sequence, report: RippleReport): string | null {
  const names = trackList(seq, report.heldTrackIds)
  if (names.length === 0) return null
  return names.length === 1
    ? `${joined(names)} kept its timing: something on it sits in the part you cut`
    : `${joined(names)} kept their timing: something on them sits in the part you cut`
}
