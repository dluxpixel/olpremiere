import { describe, expect, it } from 'vitest'
import { EDGE, TOP_OFFSET, stackRect, toastPlacement, type Rect } from './toastPlacement'

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
