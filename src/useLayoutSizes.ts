// Panel sizes for the three splitters, persisted, and held inside a window that
// can be smaller than the sum of what he asked for.
//
// WHY THE RIGHT PANEL IS 450 AND NOT A ROUND NUMBER SOMEBODY LIKED.
//
// He said "make the keyframe menu bigger to the sides too", and the panel being
// narrow was never cosmetic: the right panel opens on the shelf of ten moves,
// and how many of those tiles fit across is decided entirely by this number.
//
// Measured, not guessed. A tile's minimum column is the little picture plus
// 16px, and the picture is drawn in the shape of HIS sequence (MoveShelf's
// frameSize):
//
//   16:9   picture 78 wide   ->  column 94px
//   9:16   picture 38 wide   ->  column 66px (the grid's own floor wins)
//
// The grid gaps are 4px. Ten tiles want complete rows, so five across at 9:16
// and four across at 16:9:
//
//   16:9   4 x 94 + 3 x 4 = 388px of grid
//   9:16   5 x 66 + 4 x 4 = 346px of grid
//
// The grid is not the panel. Off the panel width come the scrollbar (10),
// ClipPanel's padding (12 + 12) and the shelf's own padding (10 + 10) = 54px.
// So four across at 16:9 needs 442 and five across at 9:16 needs 400. Take the
// larger, round up for slack: 450. At 450 a 16:9 project shows 4 / 4 / 2 and a
// 9:16 Short shows 5 / 5, which are the best packings ten tiles have at those
// two tile sizes. At the 372 this replaced, a 16:9 project got 318px of grid
// and fell back to THREE columns and four ragged rows, which is the exact thing
// the wider panel was supposed to end.
//
// The second constraint that says 450 is as far as a DEFAULT may go: the app's
// own minimum window is 1024 wide (electron/main.ts). 280 left + 450 right +
// 280 of picture + 2px of splitters = 1012, so the default still fits the
// smallest window the app will ever open at. 470 would not.
//
// A NEW DEFAULT ON ITS OWN WOULD NEVER HAVE REACHED HIM. He already has a
// stored layout, and stored beats default forever. So the storage key steps to
// v2 and the v1 value is read once for its left panel and its timeline height
// only: the two things he tuned survive, the width that predates the shelf does
// not. See readLayout.
//
// THE FLOOR IS 340: the narrowest that still gives four tiles across at 9:16
// (330) with slack. Below that the grid drops to three and the shelf goes four
// ragged rows deep again.
//
// THE CEILING IS 560 because five across at 16:9 needs 540, so a wide-format
// project can be dragged to two clean rows of five. Anything he does with the
// handle is his and is remembered.

import { useCallback, useEffect, useMemo, useState } from 'react'

export interface LayoutSizes {
  left: number
  right: number
  bottom: number
}

const KEY = 'olpremiere.layout.v2'
/**
 * v1 held a `right` chosen before the shelf existed. Read it once so his left
 * panel and his timeline height survive, and take the new `right`: bumping the
 * default alone would never have reached him, because he already has a stored
 * one. Nothing is written here; his first drag writes v2 and that is his again
 * forever.
 */
const LEGACY_KEY = 'olpremiere.layout.v1'

export const DEFAULT_SIZES: LayoutSizes = { left: 280, right: 450, bottom: 320 }

export const SIZE_LIMITS: Record<keyof LayoutSizes, [number, number]> = {
  left: [200, 520],
  right: [340, 560],
  bottom: [160, 640],
}

/**
 * The picture never gets squeezed out of existence. Both panels at their
 * ceilings come to 1080, which is wider than the 1024 minimum window, so
 * without this the Inspector (and the handle that would drag it back) simply
 * slid off the right edge with no way to recover it.
 */
const MONITOR_MIN_W = 280
/**
 * 200, deliberately not more: at 900px of window the timeline's own 640 ceiling
 * is still reachable, so this guard only ever bites on a window near the 680
 * minimum, where the timeline would otherwise take the entire screen.
 */
const MONITOR_MIN_H = 200
/** Chrome above the monitor row, and the 1px splitters between the regions. */
const TOPBAR_H = 48
const SPLITTER_PX = 1

const clampLimits = (key: keyof LayoutSizes, v: number): number =>
  Math.min(SIZE_LIMITS[key][1], Math.max(SIZE_LIMITS[key][0], v))

export interface Viewport {
  w: number
  h: number
}

function viewport(): Viewport {
  if (typeof window === 'undefined') return { w: Infinity, h: Infinity }
  return { w: window.innerWidth || Infinity, h: window.innerHeight || Infinity }
}

/**
 * The widest/tallest this region may actually DRAW at, given what the window
 * has left. Never returns less than the region's own floor: on a window too
 * small for everything, something has to overflow, and a floor below the floor
 * would invert the clamp and give a negative size.
 */
function ceilingFor(key: keyof LayoutSizes, otherPanel: number, vp: Viewport): number {
  const room =
    key === 'bottom'
      ? vp.h - TOPBAR_H - SPLITTER_PX - MONITOR_MIN_H
      : vp.w - 2 * SPLITTER_PX - MONITOR_MIN_W - otherPanel
  return Math.max(SIZE_LIMITS[key][0], Math.min(SIZE_LIMITS[key][1], room))
}

/**
 * What he asked for, made to fit the window he currently has. The stored
 * preference is NOT changed by this: shrinking the window must not make him
 * forget the width he chose, so the squeeze is applied on the way to the screen
 * and undone the moment there is room again.
 */
export function fitToWindow(pref: LayoutSizes, vp: Viewport): LayoutSizes {
  // Left is settled first so the pair can never both claim the same pixels; the
  // second one then sees what the first actually took.
  const left = Math.min(pref.left, ceilingFor('left', pref.right, vp))
  const right = Math.min(pref.right, ceilingFor('right', left, vp))
  const bottom = Math.min(pref.bottom, ceilingFor('bottom', 0, vp))
  return { left, right, bottom }
}

/**
 * The stored layout, given whatever the two keys hold. Pure, so the migration
 * and the clamps can be tested without a browser.
 */
export function readLayout(stored: string | null, legacy: string | null): LayoutSizes {
  const parse = (raw: string | null): Partial<LayoutSizes> | null => {
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as unknown
      return p && typeof p === 'object' ? (p as Partial<LayoutSizes>) : null
    } catch {
      return null
    }
  }
  const current = parse(stored)
  if (current) {
    return {
      left: clampLimits('left', Number(current.left) || DEFAULT_SIZES.left),
      right: clampLimits('right', Number(current.right) || DEFAULT_SIZES.right),
      bottom: clampLimits('bottom', Number(current.bottom) || DEFAULT_SIZES.bottom),
    }
  }
  const old = parse(legacy)
  if (old) {
    return {
      left: clampLimits('left', Number(old.left) || DEFAULT_SIZES.left),
      right: DEFAULT_SIZES.right,
      bottom: clampLimits('bottom', Number(old.bottom) || DEFAULT_SIZES.bottom),
    }
  }
  return { ...DEFAULT_SIZES }
}

function load(): LayoutSizes {
  try {
    return readLayout(localStorage.getItem(KEY), localStorage.getItem(LEGACY_KEY))
  } catch {
    // Unreadable or unavailable storage is not worth failing a boot over.
    return { ...DEFAULT_SIZES }
  }
}

/** Panel sizes for the three splitters; persisted to localStorage. */
export function useLayoutSizes() {
  // `pref` is what he chose. `sizes` is that, made to fit today's window.
  const [pref, setPref] = useState<LayoutSizes>(load)
  const [vp, setVp] = useState<Viewport>(viewport)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = (): void => setVp(viewport())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const sizes = useMemo(() => fitToWindow(pref, vp), [pref, vp])

  const adjust = useCallback(
    (key: keyof LayoutSizes, deltaPx: number) => {
      // The delta lands on what he can SEE, not on the stored preference: while a
      // small window is squeezing the panel, a drag that started from the stored
      // value would jump before it moved.
      setPref((prev) => {
        const shown = fitToWindow(prev, vp)
        const next = { ...prev, [key]: clampLimits(key, shown[key] + deltaPx) }
        if (next[key] === prev[key]) return prev
        try {
          localStorage.setItem(KEY, JSON.stringify(next))
        } catch {
          // localStorage full/unavailable, so layout just won't persist
        }
        return next
      })
    },
    [vp],
  )

  return { sizes, adjust }
}
