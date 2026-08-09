import { describe, expect, it } from 'vitest'

import { ARM_WINDOW_MS, createArmedDelete, type Schedule } from './armedDelete'

// The arming is the part of the permanent action box that breaks silently: a
// delete that fires on ONE click, or one that stays armed after he has walked
// away, both look exactly like a working button until the day they cost him a
// clip. Every one of those is pinned here.

/** A clock the test drives by hand, so no test ever waits four real seconds. */
function fakeClock() {
  let pending: { fn: () => void; at: number } | null = null
  let now = 0
  const schedule: Schedule = (fn, ms) => {
    pending = { fn, at: now + ms }
    return () => {
      pending = null
    }
  }
  return {
    schedule,
    /** Move time on, firing the pending callback if it has come due. */
    advance(ms: number) {
      now += ms
      const due = pending
      if (due && due.at <= now) {
        pending = null
        due.fn()
      }
    },
    /** Nothing pending means nothing can fire later. */
    isWaiting: () => pending !== null,
  }
}

/** The delete button, wired the way the card wires it. */
function deleteButton(deleted: string[], windowMs = ARM_WINDOW_MS) {
  const clock = fakeClock()
  const changes: boolean[] = []
  const arm = createArmedDelete({
    onChange: (armed) => changes.push(armed),
    windowMs,
    schedule: clock.schedule,
  })
  return {
    clock,
    changes,
    armed: () => arm.armed(),
    /** A click on the button. The card deletes only on 'confirmed'. */
    click() {
      if (arm.press() === 'confirmed') deleted.push('asset-a')
    },
    /** Escape. */
    escape: () => arm.disarm(),
    /** Focus left the button. */
    blur: () => arm.disarm(),
    /** The card went away. */
    unmount: () => arm.dispose(),
  }
}

describe('armedDelete (the two-click delete in the media pool action box)', () => {
  it('deletes nothing on the first click', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    expect(deleted).toEqual([])
    expect(b.armed()).toBe(true)
    expect(b.changes).toEqual([true])
  })

  it('deletes on the second click', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.click()
    expect(deleted).toEqual(['asset-a'])
    expect(b.armed()).toBe(false)
    expect(b.changes).toEqual([true, false])
  })

  it('disarms on its own when the second click never comes', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.clock.advance(ARM_WINDOW_MS)
    expect(b.armed()).toBe(false)
    // The view has to hear about it, or the button keeps SAYING Confirm while
    // the next click only re-arms.
    expect(b.changes).toEqual([true, false])
    expect(deleted).toEqual([])
  })

  it('stays armed for the whole window, not a moment less', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.clock.advance(ARM_WINDOW_MS - 1)
    expect(b.armed()).toBe(true)
    b.click()
    expect(deleted).toEqual(['asset-a'])
  })

  it('re-arms rather than deleting when the click lands after the window', () => {
    // The dangerous one: a click that arrives late must cost nothing.
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.clock.advance(ARM_WINDOW_MS)
    b.click()
    expect(deleted).toEqual([])
    expect(b.armed()).toBe(true)
  })

  it('disarms on Escape, and the click after it only re-arms', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.escape()
    expect(b.armed()).toBe(false)
    expect(b.changes).toEqual([true, false])
    b.click()
    expect(deleted).toEqual([])
    expect(b.armed()).toBe(true)
  })

  it('disarms on blur, so an armed delete is never left waiting on screen', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.blur()
    expect(b.armed()).toBe(false)
    b.click()
    expect(deleted).toEqual([])
  })

  it('reports nothing when a resting button is disarmed', () => {
    // Blur fires every time focus passes through the panel. Re-rendering every
    // card in the bin on each of those is noise.
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.blur()
    b.escape()
    expect(b.changes).toEqual([])
    expect(b.armed()).toBe(false)
  })

  it('leaves no timer running once the delete is confirmed', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.click()
    expect(b.clock.isWaiting()).toBe(false)
    // Whatever the clock does now, the button reports nothing further.
    b.clock.advance(ARM_WINDOW_MS * 2)
    expect(b.changes).toEqual([true, false])
  })

  it('leaves no timer running once it is disarmed', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.escape()
    expect(b.clock.isWaiting()).toBe(false)
    b.clock.advance(ARM_WINDOW_MS * 2)
    expect(b.changes).toEqual([true, false])
  })

  it('drops a pending auto-disarm on unmount, silently', () => {
    // The card is removed while still armed (his own delete, or an undo). The
    // timer must not fire into a component that no longer exists.
    const deleted: string[] = []
    const b = deleteButton(deleted)
    b.click()
    b.unmount()
    expect(b.clock.isWaiting()).toBe(false)
    b.clock.advance(ARM_WINDOW_MS * 2)
    expect(b.changes).toEqual([true])
  })

  it('uses the window it was given', () => {
    const deleted: string[] = []
    const b = deleteButton(deleted, 1000)
    b.click()
    b.clock.advance(999)
    expect(b.armed()).toBe(true)
    b.clock.advance(1)
    expect(b.armed()).toBe(false)
  })
})
