// HOW BUSY THE MACHINE IS, as a number a timing spec can wait on (see quietBox.ts).
//
// Pure maths over two os.cpus() snapshots, so it is unit tested (scripts/quietBox.test.mjs)
// instead of being trusted because it looked right on one box.
//
// ⛔ THE MEAN ALONE CALLED A BUSY BOX QUIET (2026-10-08). "Below half of all CPU time" on a
// 32 thread machine lets FIFTEEN cores sit at 100% and still read 47% busy: quiet. A timing
// spec does not need the mean, it needs a core nobody else is using, and fifteen pegged
// threads (on 16 physical cores, that is nearly all of them) is exactly the box a
// 1500 ms budget goes red on for no fault of the app. So a box is also busy when a quarter
// of its cores, and never fewer than two, are pegged.
//
// It only ever says WAIT. Nothing here changes a verdict or moves a budget.

import type os from 'node:os'

export type Times = os.CpuInfo['times']

/** Above this share of all CPU time busy, a wall clock number says more about the box than the app. */
export const BUSY_LIMIT = 0.5
/** A core this busy over the window is taken: whatever else runs there is competing for it. */
export const PEGGED_AT = 0.9
/** This share of the cores pegged makes the box busy, whatever the mean says. */
export const PEGGED_SHARE = 0.25
/** And never fewer than this many, so one busy core on a small box is not a busy box. */
export const MIN_PEGGED = 2

export type Reading = {
  /** The share of all CPU time, on every core, that was busy. */
  share: number
  /** How many cores were busy at PEGGED_AT or more. */
  pegged: number
  cores: number
  /** Busy by the mean, or by the cores taken. */
  busy: boolean
}

const total = (t: Times): number => t.user + t.nice + t.sys + t.idle + t.irq

/** How many pegged cores make a box of `cores` busy. */
export const peggedLimit = (cores: number): number => Math.max(MIN_PEGGED, Math.ceil(cores * PEGGED_SHARE))

/** Is a box that was `share` busy, with `pegged` of its `cores` taken, too busy to time anything on? */
export const isBusy = (share: number, pegged: number, cores: number): boolean =>
  share >= BUSY_LIMIT || pegged >= peggedLimit(cores)

/** What the machine did between two snapshots. */
export function readingBetween(a: Times[], b: Times[]): Reading {
  let idle = 0
  let all = 0
  let pegged = 0
  let cores = 0
  b.forEach((t, i) => {
    const s = a[i]
    if (!s) return
    cores += 1
    const coreIdle = t.idle - s.idle
    const coreAll = total(t) - total(s)
    idle += coreIdle
    all += coreAll
    if (coreAll > 0 && 1 - coreIdle / coreAll >= PEGGED_AT) pegged += 1
  })
  const share = all > 0 ? 1 - idle / all : 0
  return { share, pegged, cores, busy: isBusy(share, pegged, cores) }
}
