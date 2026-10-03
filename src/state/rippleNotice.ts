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
export const newRippleReport = (): RippleReport => ({ heldTrackIds: [] })

/**
 * "Captions kept its timing: something on it sits in the part you cut", or
 * null when every track followed. Track names come from `seq`, the sequence the
 * edit started from, in its own track order, each named once.
 */
export function keptTimingMessage(seq: Sequence, report: RippleReport): string | null {
  const held = new Set(report.heldTrackIds)
  const names = seq.tracks.filter((t) => held.has(t.id)).map((t) => t.name)
  if (names.length === 0) return null
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return names.length === 1
    ? `${list} kept its timing: something on it sits in the part you cut`
    : `${list} kept their timing: something on them sits in the part you cut`
}
