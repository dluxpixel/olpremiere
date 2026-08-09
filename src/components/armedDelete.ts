/**
 * The safety catch on a delete button that is on screen ALL the time.
 *
 * His call, 2026-08-09: every bin item gets a permanent action box, "and of
 * course the delete thing you'd have to click twice". A destructive button that
 * is always visible is one stray click away from removing an asset AND every
 * clip that uses it, so the first press only ARMS it and the second press is
 * the one that does the work.
 *
 * The part that is easy to get wrong, and the reason this is its own module
 * with its own tests: an armed button must not STAY armed. It disarms itself
 * after a few seconds and whenever focus leaves it, so a delete armed a minute
 * ago can never be completed by a click that was aimed at something else.
 *
 * Pure: no React, no DOM, no store, no toasts. The caller does the deleting and
 * the clock is injected, so the timeout is asserted rather than waited on.
 */

/**
 * How long an armed delete stays armed. Long enough to read the button and
 * click again without hurrying, short enough that it has always gone cold by
 * the time attention comes back to the panel.
 */
export const ARM_WINDOW_MS = 4000

/** Run `fn` after `ms`. Returns the canceller. */
export type Schedule = (fn: () => void, ms: number) => () => void

/** The real clock. Tests pass their own. */
export const timerSchedule: Schedule = (fn, ms) => {
  const handle = window.setTimeout(fn, ms)
  return () => window.clearTimeout(handle)
}

export interface ArmedDeleteOptions {
  /** Fired on every change of armed-ness, INCLUDING the automatic disarm. */
  onChange: (armed: boolean) => void
  windowMs?: number
  schedule?: Schedule
}

export interface ArmedDelete {
  /** True while a second press would really delete. */
  armed: () => boolean
  /**
   * A press of the delete button. 'armed' is the first press and nothing has
   * been deleted; 'confirmed' is the second press inside the window, and the
   * caller must now do the deleting itself (this module never touches the
   * project, so undo, guards and toasts stay in one place).
   */
  press: () => 'armed' | 'confirmed'
  /** Escape, blur, or anything else that puts the safety back on. */
  disarm: () => void
  /** Drop a pending auto-disarm without reporting a change (unmount). */
  dispose: () => void
}

export function createArmedDelete({
  onChange,
  windowMs = ARM_WINDOW_MS,
  schedule = timerSchedule,
}: ArmedDeleteOptions): ArmedDelete {
  // The pending auto-disarm IS the armed flag. There is exactly one, and the
  // button cannot be armed without one running, so the two can never disagree.
  let cancel: (() => void) | null = null

  const clear = (): void => {
    if (cancel) cancel()
    cancel = null
  }

  return {
    armed: () => cancel !== null,

    press() {
      if (cancel) {
        // Second press inside the window. Disarm FIRST so the caller's delete
        // runs against a button that is already back at rest (it is usually
        // about to unmount with the card anyway).
        clear()
        onChange(false)
        return 'confirmed'
      }
      cancel = schedule(() => {
        cancel = null
        onChange(false)
      }, windowMs)
      onChange(true)
      return 'armed'
    },

    disarm() {
      // A resting button reports nothing: blur fires on every pass through the
      // panel, and a re-render per Tab keypress is noise.
      if (!cancel) return
      clear()
      onChange(false)
    },

    dispose() {
      clear()
    },
  }
}
