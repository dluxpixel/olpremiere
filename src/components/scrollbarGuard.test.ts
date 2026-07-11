import { describe, expect, it } from 'vitest'

import { pointOnScrollbar } from './scrollbarGuard'

// A 800×400 element at (100,50) whose content area is 780×384 (a 20px horizontal
// scrollbar band at the bottom, a 20px vertical band at the right).
const rect = { left: 100, top: 50 }
const CW = 780
const CH = 384

describe('pointOnScrollbar', () => {
  it('is false for a click well inside the content area', () => {
    expect(pointOnScrollbar(rect, CW, CH, 400, 200)).toBe(false)
  })

  it('is true for a click on the horizontal scrollbar band (below the content)', () => {
    // clientY past top + clientHeight (50 + 384 = 434)
    expect(pointOnScrollbar(rect, CW, CH, 400, 440)).toBe(true)
  })

  it('is true for a click on the vertical scrollbar band (right of the content)', () => {
    // clientX past left + clientWidth (100 + 780 = 880)
    expect(pointOnScrollbar(rect, CW, CH, 890, 200)).toBe(true)
  })

  it('is false right at the content edge (boundary belongs to the content)', () => {
    expect(pointOnScrollbar(rect, CW, CH, 100 + CW, 50 + CH)).toBe(false)
  })
})
