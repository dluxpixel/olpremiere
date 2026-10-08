import { describe, expect, it } from 'vitest'
import { EDGE, MENU_GAP, TOP_OFFSET, bottomOffset, stackRect, toastPlacement, type Rect } from './toastPlacement'

const VW = 1280
const VH = 720
const stack = { w: 300, h: 120 }

const menu = (left: number, top: number, w = 220, h = 300): Rect => ({ left, top, right: left + w, bottom: top + h })

describe('toastPlacement', () => {
  it('stays in the bottom right corner with no menu open', () => {
    expect(toastPlacement(stack, [], VW, VH)).toEqual({ corner: 'br', covered: false })
  })

  it('stays there for a menu on the other side of the screen', () => {
    expect(toastPlacement(stack, [menu(100, 100)], VW, VH)).toEqual({ corner: 'br', covered: false })
  })

  it('steps to the bottom left when a menu is in the bottom right', () => {
    const inCorner = menu(VW - 260, VH - 340)
    expect(toastPlacement(stack, [inCorner], VW, VH)).toEqual({ corner: 'bl', covered: false })
  })

  it('goes up when both bottom corners are taken, a menu with its flyout across the window', () => {
    // 1024px wide: a menu at the left and its flyout reaching the right leave neither bottom corner free.
    const wide = menu(40, VH - 340, 940, 330)
    expect(toastPlacement(stack, [wide], 1024, VH)).toEqual({ corner: 'tr', covered: false })
  })

  it('keeps the gap: a menu a few pixels from the stack still counts as touching it', () => {
    const at = stackRect('br', stack, VW, VH)
    const close = { left: at.left - 4, top: at.top - 200, right: at.left - 4 + 10, bottom: at.top - 4 }
    expect(toastPlacement(stack, [close], VW, VH).corner).toBe('bl')
  })

  it('reports covered when no corner is clear, which is the stack sitting under the menu', () => {
    const everywhere = menu(0, 0, VW, VH)
    expect(toastPlacement(stack, [everywhere], VW, VH)).toEqual({ corner: 'br', covered: true })
  })

  it('puts the top corners below the top bar', () => {
    expect(stackRect('tr', stack, VW, VH).top).toBe(TOP_OFFSET)
    expect(stackRect('tl', stack, VW, VH).left).toBe(EDGE)
    expect(stackRect('br', stack, VW, VH)).toEqual({ left: VW - EDGE - 300, top: VH - EDGE - 120, right: VW - EDGE, bottom: VH - EDGE })
  })
})

// 2026-10-08: in full screen the bar under the picture is the bottom of the screen, and the stack in
// its usual corner sat on Exit full screen and the tools at the bar's right end.
describe('the bottom corners in full screen', () => {
  const FS_W = 1920
  const FS_H = 1080
  const bar = (h: number): Rect => ({ left: 0, top: FS_H - h, right: FS_W, bottom: FS_H })
  const wide = { w: 420, h: 120 }

  it('stand the usual 16px up in a window', () => {
    expect(bottomOffset(null, FS_H)).toBe(EDGE)
  })

  for (const h of [44, 80]) {
    it(`stand above a ${h}px bar, with air between, and never touch it`, () => {
      const lift = bottomOffset(FS_H - h, FS_H)
      expect(lift).toBe(h + MENU_GAP)
      for (const corner of ['br', 'bl'] as const) {
        const at = stackRect(corner, wide, FS_W, FS_H, lift)
        expect(at.bottom).toBeLessThanOrEqual(bar(h).top - MENU_GAP)
      }
    })
  }

  it('a menu in the lifted corner still sends the stack to the other side', () => {
    const lift = bottomOffset(FS_H - 44, FS_H)
    const overLifted = menu(FS_W - 300, FS_H - 44 - 200, 280, 190)
    expect(toastPlacement(wide, [overLifted], FS_W, FS_H, lift).corner).toBe('bl')
  })
})
