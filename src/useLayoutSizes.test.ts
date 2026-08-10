// The right panel's width is a measurement, not a preference, so it gets a test
// that fails with the arithmetic written out rather than a screenshot somebody
// has to squint at.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SIZES, SIZE_LIMITS, fitToWindow, readLayout } from './useLayoutSizes'

// --- the grid the right panel exists to hold ---------------------------------
// MoveShelf draws ten tiles as `repeat(auto-fill, minmax(COL, 1fr))` with a 4px
// gap, where COL is the little picture plus 16, floored at 66. The picture is
// the shape of the sequence (MoveShelf.frameSize): 16:9 gives 78 wide, 9:16
// gives 38. Between the panel edge and the grid sit the scrollbar (10),
// ClipPanel's p-3 (12 + 12) and the shelf's own p-2.5 (10 + 10).
const COL_WIDE = 94
const COL_TALL = 66
const GAP = 4
const PANEL_CHROME = 10 + 12 + 12 + 10 + 10

const gridWidth = (panel: number): number => panel - PANEL_CHROME
const columnsIn = (grid: number, col: number): number => Math.floor((grid + GAP) / (col + GAP))

describe('the right panel is wide enough for the shelf of moves', () => {
  it('shows ten tiles as four complete-ish rows on a 16:9 project', () => {
    // Four across is 4 x 94 + 3 x 4 = 388 of grid, so 442 of panel. Three
    // across is what 372 gave, and it is four ragged rows.
    expect(columnsIn(gridWidth(DEFAULT_SIZES.right), COL_WIDE)).toBe(4)
    expect(columnsIn(gridWidth(372), COL_WIDE)).toBe(3)
  })

  it('shows ten tiles as two rows of five on a 9:16 Short, which is what he shoots', () => {
    expect(columnsIn(gridWidth(DEFAULT_SIZES.right), COL_TALL)).toBe(5)
  })

  it('still gives four across at 9:16 at the narrowest he can drag it', () => {
    expect(columnsIn(gridWidth(SIZE_LIMITS.right[0]), COL_TALL)).toBe(4)
  })

  it('can be dragged to two rows of five on a 16:9 project', () => {
    expect(columnsIn(gridWidth(SIZE_LIMITS.right[1]), COL_WIDE)).toBe(5)
  })
})

// --- the extremes -----------------------------------------------------------
// electron/main.ts opens at minWidth 1024, minHeight 680. Both panels at their
// ceilings come to 1080, so without a window-aware clamp the Inspector, and the
// handle that would drag it back, slide off the right edge with no way home.
const MIN_WIN = { w: 1024, h: 680 }
const HIS_WIN = { w: 1600, h: 900 }
const monitorWidth = (s: { left: number; right: number }, w: number): number =>
  w - 2 - s.left - s.right
const monitorHeight = (s: { bottom: number }, h: number): number => h - 48 - 1 - s.bottom

describe('the panels cannot squeeze the picture out of the window', () => {
  it('leaves the default layout completely alone on a real window', () => {
    expect(fitToWindow(DEFAULT_SIZES, HIS_WIN)).toEqual(DEFAULT_SIZES)
  })

  it('fits the default layout in the smallest window the app opens at', () => {
    expect(fitToWindow(DEFAULT_SIZES, MIN_WIN)).toEqual(DEFAULT_SIZES)
    expect(monitorWidth(DEFAULT_SIZES, MIN_WIN.w)).toBeGreaterThanOrEqual(280)
    expect(monitorHeight(DEFAULT_SIZES, MIN_WIN.h)).toBeGreaterThanOrEqual(200)
  })

  it('keeps the picture and both handles on screen with both panels at their ceilings', () => {
    const greedy = { left: SIZE_LIMITS.left[1], right: SIZE_LIMITS.right[1], bottom: 320 }
    const fitted = fitToWindow(greedy, MIN_WIN)
    expect(monitorWidth(fitted, MIN_WIN.w)).toBeGreaterThanOrEqual(280)
    expect(fitted.left).toBeGreaterThanOrEqual(SIZE_LIMITS.left[0])
    expect(fitted.right).toBeGreaterThanOrEqual(SIZE_LIMITS.right[0])
  })

  it('keeps the monitor row alive with the timeline dragged to its ceiling', () => {
    const tall = { ...DEFAULT_SIZES, bottom: SIZE_LIMITS.bottom[1] }
    const fitted = fitToWindow(tall, MIN_WIN)
    expect(monitorHeight(fitted, MIN_WIN.h)).toBeGreaterThanOrEqual(200)
    expect(fitted.bottom).toBeGreaterThanOrEqual(SIZE_LIMITS.bottom[0])
    // And the guard does not quietly steal the timeline's own ceiling: from a
    // 900px window upward the full 640 is still his to drag to.
    expect(fitToWindow(tall, HIS_WIN).bottom).toBe(SIZE_LIMITS.bottom[1])
  })

  it('squeezes for a small window without forgetting the width he chose', () => {
    const greedy = { left: 520, right: 560, bottom: 320 }
    expect(fitToWindow(greedy, MIN_WIN).right).toBeLessThan(greedy.right)
    // Same preference, roomy window: he gets every pixel back.
    expect(fitToWindow(greedy, { w: 1920, h: 1080 })).toEqual(greedy)
  })
})

// --- what a machine that already has a layout gets ---------------------------

describe('reading the stored layout', () => {
  const v1 = JSON.stringify({ left: 320, right: 300, bottom: 420 })

  it('hands the new right panel to a machine that only has the old key', () => {
    // Raising the default alone never reaches him: he already dragged one. The
    // left panel and the timeline height he tuned come through untouched.
    const s = readLayout(null, v1)
    expect(s.right).toBe(DEFAULT_SIZES.right)
    expect(s.left).toBe(320)
    expect(s.bottom).toBe(420)
  })

  it('leaves a width he chose under the new key exactly where he put it', () => {
    const s = readLayout(JSON.stringify({ left: 300, right: 512, bottom: 300 }), v1)
    expect(s.right).toBe(512)
  })

  it('holds a stored size inside its limits', () => {
    const s = readLayout(JSON.stringify({ left: 9999, right: 12, bottom: 9999 }), null)
    expect(s.left).toBe(SIZE_LIMITS.left[1])
    expect(s.right).toBe(SIZE_LIMITS.right[0])
    expect(s.bottom).toBe(SIZE_LIMITS.bottom[1])
  })

  it('falls back to the defaults on junk rather than throwing a boot', () => {
    expect(readLayout('not json', null)).toEqual(DEFAULT_SIZES)
    expect(readLayout(null, null)).toEqual(DEFAULT_SIZES)
  })
})
