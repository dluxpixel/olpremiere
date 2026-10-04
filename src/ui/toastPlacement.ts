// Where the toasts stand while a menu is open (2026-10-03).
//
// The stack lives in the bottom right corner, and a right-click menu opened near that corner (a
// track at the right edge, a clip near the bottom) used to be covered by it: the toast sat above
// the menu, hid its last rows and took the clicks meant for them. A menu is what he is using, a
// toast is news, so the news steps aside: the stack moves to the nearest corner the menu is not
// in, and comes back to the bottom right the moment the menu is gone.

export type ToastCorner = 'br' | 'bl' | 'tr' | 'tl'

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Air kept between the stack and the screen edge, and between the stack and a menu. */
export const EDGE = 16
export const MENU_GAP = 8
/** The top corners start below the 48px top bar, so a toast never sits on its buttons. */
export const TOP_OFFSET = 56

/** The corners in the order they are tried: where toasts always are, then the other side, then up. */
const ORDER: ToastCorner[] = ['br', 'bl', 'tr', 'tl']

/** The rectangle a stack of this size would fill in a corner of a window of this size. */
export function stackRect(corner: ToastCorner, size: { w: number; h: number }, vw: number, vh: number): Rect {
  const left = corner === 'br' || corner === 'tr' ? vw - EDGE - size.w : EDGE
  const top = corner === 'br' || corner === 'bl' ? vh - EDGE - size.h : TOP_OFFSET
  return { left, top, right: left + size.w, bottom: top + size.h }
}

const meets = (a: Rect, b: Rect, gap: number): boolean =>
  a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap

export interface ToastPlacement {
  corner: ToastCorner
  /** True when no corner is clear, so the stack stays put and must sit UNDER the menu instead. */
  covered: boolean
}

/** The first corner whose stack would not touch any open menu. */
export function toastPlacement(size: { w: number; h: number }, menus: readonly Rect[], vw: number, vh: number): ToastPlacement {
  for (const corner of ORDER) {
    const at = stackRect(corner, size, vw, vh)
    if (!menus.some((m) => meets(at, m, MENU_GAP))) return { corner, covered: false }
  }
  return { corner: 'br', covered: true }
}

export function cornerClasses(corner: ToastCorner): string {
  switch (corner) {
    case 'br':
      return 'right-4 bottom-4 items-end'
    case 'bl':
      return 'left-4 bottom-4 items-start'
    case 'tr':
      return 'right-4 top-14 items-end'
    case 'tl':
      return 'left-4 top-14 items-start'
  }
}
