// The work area: an optional in/out range over a sequence (spec §5.6 I / O).
// It scopes export ("render just this bit") and gives the transport somewhere to
// jump to. Pure: no React, no DOM, no store.
//
// Both points are optional and independent. An in point alone means "from here
// to the end"; an out point alone means "from the start to here". The pair is
// always normalised through `workArea()`, so no consumer ever has to reason
// about a half-set, inverted, or out-of-bounds range.

import type { Sequence } from './types'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** Shortest range worth rendering: anything tighter is treated as no range at all. */
const MIN_RANGE_S = 1e-3

export interface WorkArea {
  startS: number
  endS: number
  /** False when the range spans the whole sequence, so callers can label it honestly. */
  active: boolean
}

/**
 * The effective render range. Falls back to the whole sequence when no points
 * are set, when they are inverted, or when they collapse to nothing — a
 * degenerate range must never silently export zero frames.
 */
export function workArea(seq: Sequence): WorkArea {
  const durationS = Math.max(0, seq.durationS)
  const whole: WorkArea = { startS: 0, endS: durationS, active: false }
  if (seq.inPointS === undefined && seq.outPointS === undefined) return whole

  const startS = clamp(seq.inPointS ?? 0, 0, durationS)
  const endS = clamp(seq.outPointS ?? durationS, 0, durationS)
  if (endS - startS < MIN_RANGE_S) return whole
  return { startS, endS, active: startS > 0 || endS < durationS }
}

export const hasWorkArea = (seq: Sequence): boolean => workArea(seq).active

/** Strip both points. Returns the same object when there was nothing to strip. */
export function clearWorkArea(seq: Sequence): Sequence {
  if (seq.inPointS === undefined && seq.outPointS === undefined) return seq
  const next = { ...seq }
  delete next.inPointS
  delete next.outPointS
  return next
}

/**
 * Set the in point at `t`. Dropping it at or past the out point clears the out
 * point rather than producing an inverted range — the same thing Premiere does,
 * and far less surprising than silently swapping the two.
 */
export function setInPoint(seq: Sequence, t: number): Sequence {
  const inPointS = clamp(t, 0, Math.max(0, seq.durationS))
  const next: Sequence = { ...seq, inPointS }
  if (next.outPointS !== undefined && next.outPointS - inPointS < MIN_RANGE_S) delete next.outPointS
  return next
}

/** Set the out point at `t`. At or before the in point, the in point is cleared. */
export function setOutPoint(seq: Sequence, t: number): Sequence {
  const outPointS = clamp(t, 0, Math.max(0, seq.durationS))
  const next: Sequence = { ...seq, outPointS }
  if (next.inPointS !== undefined && outPointS - next.inPointS < MIN_RANGE_S) delete next.inPointS
  return next
}
