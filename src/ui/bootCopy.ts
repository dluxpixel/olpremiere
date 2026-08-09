// The words and the two view rules that the in-app loading card and the desktop
// splash window BOTH need, in one module with no dependencies at all.
//
// Why it is its own file: the splash page must not import `bootProgress.ts`. That
// module builds the zustand ledger at its top level, so any value taken from it
// drags a store into the one page whose entire job is to be on screen before the
// editor's bundle has been read off disk. Same reason the splash keeps its own
// copy of the stylesheet. The words and the cursor rule still have to agree
// between the two cards, so they live here and are imported by both rather than
// being typed out twice and left to drift.

import type { BootStepState } from './bootProgress'

/** The glyph in a row's left column, one per state. */
export const MARK: Record<BootStepState, string> = { done: '✓', failed: '!', active: '›', pending: '·' }

/** Over the rows that hold the app shut. */
export const GATING_TITLE = 'Starting up'

/**
 * Over the rows that do NOT. Said out loud, because the app really does open
 * without waiting for them, and a card that shows twelve rows under a bar that
 * counts eight is measuring something other than what is drawn beneath it.
 */
export const BACKGROUND_TITLE = 'Continues in the background'

/** The one line under the bar, unchanged from the day the card shipped. */
export const LEGAL_LINE = 'Local-first · your media never leaves this machine'

/**
 * Split any row list into the rows that gate the boot and the rows that carry on
 * after it. One predicate, used by the card (over specs) and by the splash window
 * (over the flattened rows that came in over IPC), so the two can never draw a
 * different line between the groups.
 */
export function splitRows<T extends { optional?: boolean }>(rows: readonly T[]): { gating: T[]; background: T[] } {
  return {
    gating: rows.filter((r) => !r.optional),
    background: rows.filter((r) => r.optional === true),
  }
}

/**
 * Which row the eye should land on: the newest one to have moved.
 *
 * Nine identical green ticks and three grey rows is an audit log, not a moment.
 * Exactly one row is bright at a time and it walks down the list as the work
 * lands, so there is one place to look and the list reads as something happening
 * rather than something already filed.
 *
 * Derived from the states ALONE, because the splash window only ever receives
 * states over IPC and must pick the same row as the in-app card. The rows are
 * revealed strictly top to bottom (see bootReveal.ts), so the last row that is
 * not pending is the frontier.
 *
 * Returns -1 when nothing should be lit: before anything has moved, and once the
 * whole list has landed, where the footer says "Ready" and a row still shouting
 * would be claiming to be busy. A row that is genuinely still ACTIVE stays lit
 * even when it is the last one, because it really is what is happening.
 */
export function cursorIndex(states: readonly BootStepState[]): number {
  let last = -1
  for (let i = 0; i < states.length; i++) if (states[i] !== 'pending') last = i
  if (last < 0) return -1
  if (states[last] === 'active') return last
  return last === states.length - 1 ? -1 : last
}
