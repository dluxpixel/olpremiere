// How the loading card PACES itself.
//
// His call, 2026-07-28: the startup should last 4 to 8 seconds, randomised, with
// the ticks landing at scattered moments rather than all at once ("one after 1
// second, one after 1.5, one after 4, one after 4.5, stuff like that").
//
// The pacing is theatre and that is fine. What stays true is every tick: a row is
// only ever REVEALED on its slot, and what it reveals is whatever the real work
// actually did. If a step has not finished by its moment, the row keeps waiting
// rather than showing a tick it did not earn. So the card looks staged and still
// cannot claim work that never happened.
//
// The schedule is module state, computed once per app load, so the in-app card,
// the phase machine and the desktop splash window all pace identically without
// having to pass timers around.

import { useEffect, useState } from 'react'
import { statusOf, type BootStatuses, type BootStepSpec } from './bootProgress'

/** Randomised total, 4 to 8 seconds. */
export function bootDurationMs(rnd: () => number = Math.random): number {
  return Math.round(4000 + rnd() * 4000)
}

/**
 * Scattered reveal times across the run, sorted, never bunched and never all at
 * the end: each slot lands in its own jittered band so the ticks feel like work
 * arriving rather than a progress bar dividing a line into equal pieces.
 */
export function revealSchedule(count: number, totalMs: number, rnd: () => number = Math.random): number[] {
  if (count <= 0) return []
  // Leave a beat at the start (the card fades in) and at the end (the last tick
  // should be readable before the card leaves).
  const first = totalMs * 0.12
  const last = totalMs * 0.88
  const band = (last - first) / count
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    // Somewhere inside this row's own band, so two ticks can be close together
    // but never out of order.
    times.push(Math.round(first + band * (i + rnd())))
  }
  return times.sort((a, b) => a - b)
}

/** Milliseconds since this module loaded, which is as close to app start as it gets. */
const START = typeof performance !== 'undefined' ? performance.now() : 0

export const BOOT_DURATION_MS = bootDurationMs()

let schedule: number[] = []
/** Build the schedule the first time something asks, then keep it stable. */
export function scheduleFor(count: number): number[] {
  if (schedule.length !== count) schedule = revealSchedule(count, BOOT_DURATION_MS)
  return schedule
}

/** How many rows have earned their slot by now. */
export function revealedCount(count: number, now = typeof performance !== 'undefined' ? performance.now() : 0): number {
  const times = scheduleFor(count)
  const elapsed = now - START
  let n = 0
  for (const t of times) if (elapsed >= t) n++
  return n
}

/** True once every row has been revealed, which the boot gate also waits for. */
export function allRevealed(count: number): boolean {
  return revealedCount(count) >= count
}

// --- React glue -------------------------------------------------------------

/** Re-renders as each slot lands, and stops once every row has been revealed. */
export function useRevealed(count: number): number {
  const [n, setN] = useState(() => revealedCount(count))
  useEffect(() => {
    if (revealedCount(count) >= count) {
      setN(count)
      return
    }
    const timer = window.setInterval(() => {
      const next = revealedCount(count)
      setN(next)
      if (next >= count) window.clearInterval(timer)
    }, 60)
    return () => window.clearInterval(timer)
  }, [count])
  return n
}

/**
 * Hide the rows whose moment has not come yet.
 *
 * The work is often all finished inside 300ms; this is what spreads the ticks
 * across the run he asked for. A hidden row reads as pending, never as done, so
 * the card still cannot show a tick for work that has not actually landed.
 */
export function maskStatuses(
  specs: readonly BootStepSpec[],
  statuses: BootStatuses,
  revealed: number,
): BootStatuses {
  const out: BootStatuses = {}
  specs.forEach((spec, i) => {
    out[spec.id] = i < revealed ? statusOf(statuses, spec.id) : { state: 'pending' }
  })
  return out
}
