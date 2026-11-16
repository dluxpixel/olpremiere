import { describe, expect, it } from 'vitest'
import { appGuideRegions } from './appGuides'
import { alignShiftX, guideRegionsHit, SAFE_SIDE_MARGIN_PX_AT_1080, safeRect, safeSideMargin, safeSnap } from './safeSnap'

// TikTok text mode keeps a title inside the app's safe area. The snap is pure geometry in
// SEQUENCE px: the title's box at the start of a drag, the move proposed so far, the safe
// rectangle and how close counts as near. It only ever pulls, never holds.

// 1080 x 1920 TikTok: top 150, bottom 440, right 130, so the safe area is x 0..950, y 150..1480.
const SAFE = { x: 0, y: 150, w: 950, h: 1330 }
const regions = appGuideRegions(1080, 1920, 'tiktok')!
/** A 300 x 100 box whose top left corner is at (x, y). */
const box = (x: number, y: number) => ({ minX: x, maxX: x + 300, minY: y, maxY: y + 100 })
const snap = (b: ReturnType<typeof box>, dx: number, dy: number, dist = 12) => safeSnap(b, dx, dy, SAFE, dist, regions)

describe('safeRect', () => {
  it('is the frame minus the guide insets for the app', () => {
    expect(safeRect(1080, 1920, 'tiktok')).toEqual(SAFE)
  })

  it('takes the Phone shape reduced bottom, 212 not 440', () => {
    expect(safeRect(1080, 2112, 'tiktok')).toEqual({ x: 0, y: 150, w: 950, h: 2112 - 150 - 212 })
  })

  it('is the whole frame where the guides do not apply', () => {
    expect(safeRect(1920, 1080, 'tiktok')).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })
})

describe('safeSnap', () => {
  it('sticks a top edge that comes near the safe top', () => {
    // box top starts at 400, the proposed move puts it at 156: 6 below the safe top (150)
    const r = snap(box(300, 400), 0, -244)
    expect(r.dy).toBe(-250)
    expect(r.guideY).toBe(150)
  })

  it('sticks from the other side too: an edge just inside a guide is pulled out to the safe edge', () => {
    const r = snap(box(300, 400), 0, -256) // top at 144, inside the top band by 6
    expect(r.dy).toBe(-250)
    expect(r.overlaps).toEqual([])
  })

  it('sticks the bottom edge to the safe bottom and the right edge to the safe right', () => {
    // box bottom (y 500) moved to 1474, 6 above the safe bottom (1480); right (600) moved to 944, 6 short of 950
    const r = snap(box(300, 400), 344, 974)
    expect(r.dy).toBe(980)
    expect(r.dx).toBe(350)
    expect(r.guideY).toBe(1480)
    expect(r.guideX).toBe(950)
  })

  it('sticks the left edge to the safe left', () => {
    const r = snap(box(300, 400), -295, 0)
    expect(r.dx).toBe(-300)
    expect(r.guideX).toBe(0)
  })

  it('sticks the centre to the safe area centre lines (x 475, y 815)', () => {
    // box centre starts at (450, 450). Moved by (20, 360): centre at (470, 810), 5 off each line.
    const r = snap(box(300, 400), 20, 360)
    expect(r.dx).toBe(25)
    expect(r.dy).toBe(365)
    expect(r.guideX).toBe(475)
    expect(r.guideY).toBe(815)
  })

  it('never blocks: past the snap distance the move is exactly what was asked, and no guide shows', () => {
    // box top proposed at 163: 13 from the safe top, one past a distance of 12
    const r = snap(box(300, 400), 0, -237)
    expect(r.dy).toBe(-237)
    expect(r.guideY).toBeNull()
    expect(r.dx).toBe(0)
    expect(r.guideX).toBeNull()
  })

  it('follows a drag that keeps going: out of the pull as the proposal moves on, with no memory of the hold', () => {
    const b = box(300, 400)
    expect(snap(b, 0, -246).dy).toBe(-250) // 4 away: held
    expect(snap(b, 0, -230).dy).toBe(-230) // 20 away: free
    expect(snap(b, 0, -246).dy).toBe(-250) // and back: held again, nothing stuck
  })

  it('takes the nearest of the lines on an axis', () => {
    // a small safe area, so two lines are in reach: the top edge is 2 from the safe top, the centre 8 from the centre line
    const small = { x: 0, y: 0, w: 100, h: 30 }
    const r = safeSnap({ minX: 0, maxX: 10, minY: 2, maxY: 12 }, 0, 0, small, 12, null)
    expect(r.dy).toBe(-2)
    expect(r.guideY).toBe(0)
  })

  it('a snap distance of zero or less changes nothing', () => {
    const r = snap(box(300, 400), 0, -249, 0)
    expect(r.dy).toBe(-249)
    expect(r.guideY).toBeNull()
  })

  it('on a frame without guides it sticks to the frame edges and its centre', () => {
    const wide = { x: 0, y: 0, w: 1920, h: 1080 }
    const b = box(300, 400)
    const r = safeSnap(b, -295, 0, wide, 12, null)
    expect(r.dx).toBe(-300)
    expect(r.guideX).toBe(0)
    expect(r.overlaps).toEqual([])
    const c = safeSnap(b, 505, 0, wide, 12, null) // centre 450 + 505 = 955, 5 from 960
    expect(c.dx).toBe(510)
  })

  it('uses the Phone shape reduced bottom', () => {
    const phone = safeRect(1080, 2112, 'tiktok')
    const phoneRegions = appGuideRegions(1080, 2112, 'tiktok')!
    // safe bottom is 2112 - 212 = 1900; box bottom proposed at 1895
    const r = safeSnap(box(300, 400), 0, 1395, phone, 12, phoneRegions)
    expect(r.dy).toBe(1400)
    expect(r.guideY).toBe(1900)
  })
})

describe('which guide regions the box overlaps', () => {
  it('names the top band while the box dips into it', () => {
    expect(snap(box(300, 400), 0, -330).overlaps).toEqual(['top']) // top at 70
  })

  it('names the bottom band and the right column', () => {
    expect(snap(box(300, 400), 0, 1200).overlaps).toEqual(['bottom']) // top at 1600
    expect(snap(box(300, 400), 700, 0).overlaps).toEqual(['right']) // x 1000..1300, y 400..500
  })

  it('names two at once in a corner', () => {
    expect(snap(box(300, 400), 700, -330).overlaps).toEqual(['top', 'right'])
  })

  it('says nothing for a box inside the safe area, or one touching the edge', () => {
    expect(snap(box(300, 400), 0, 0).overlaps).toEqual([])
    expect(guideRegionsHit({ minX: 0, maxX: 950, minY: 150, maxY: 1480 }, regions)).toEqual([])
  })

  it('says nothing where there are no guides', () => {
    expect(guideRegionsHit(box(0, 0), null)).toEqual([])
  })

  it('reports the box where it ends up after the snap', () => {
    // proposed top at 146 (inside the band by 4) snaps out to 150, so no overlap is reported
    expect(snap(box(300, 400), 0, -254).overlaps).toEqual([])
  })
})

// The align button of the TikTok bar: the title is moved sideways in the same edit so its drawn
// box (highlight padding included) sits inside the safe area with a side margin.
describe('safeSideMargin', () => {
  it('is 48 px on a 1080 wide frame and scales with the frame width', () => {
    expect(SAFE_SIDE_MARGIN_PX_AT_1080).toBe(48)
    expect(safeSideMargin(1080)).toBe(48)
    expect(safeSideMargin(540)).toBe(24)
    expect(safeSideMargin(2160)).toBe(96)
  })
})

describe('alignShiftX', () => {
  /** A 400 wide box with its left edge at x. */
  const wide = (x: number) => ({ minX: x, maxX: x + 400, minY: 700, maxY: 800 })
  const after = (b: ReturnType<typeof wide>, dx: number) => ({ minX: b.minX + dx, maxX: b.maxX + dx })

  it('left puts the left edge at the safe left plus the margin', () => {
    const b = wide(300)
    expect(after(b, alignShiftX(b, SAFE, 'left', 1080)).minX).toBe(48)
  })

  it('right puts the right edge at the safe right minus the margin, clear of the Buttons column', () => {
    const b = wide(300)
    expect(after(b, alignShiftX(b, SAFE, 'right', 1080)).maxX).toBe(950 - 48)
  })

  it('centre puts the box centre on the safe area centre, not the frame centre', () => {
    const b = wide(10)
    const a = after(b, alignShiftX(b, SAFE, 'center', 1080))
    expect((a.minX + a.maxX) / 2).toBe(475)
  })

  it('moves nothing that already sits there', () => {
    expect(alignShiftX(wide(48), SAFE, 'left', 1080)).toBe(0)
    expect(alignShiftX(wide(950 - 48 - 400), SAFE, 'right', 1080)).toBe(0)
    expect(alignShiftX(wide(275), SAFE, 'center', 1080)).toBe(0)
  })

  it('works on the Phone shape, where only the bottom band differs, so the sides are the same', () => {
    const safe = safeRect(1080, 2112, 'tiktok')
    const b = wide(300)
    expect(after(b, alignShiftX(b, safe, 'left', 1080)).minX).toBe(48)
    expect(after(b, alignShiftX(b, safe, 'right', 1080)).maxX).toBe(902)
  })

  it('on a frame without guides the safe area is the whole frame and the margin scales with it', () => {
    const safe = safeRect(1920, 1080, 'tiktok')
    const margin = (48 * 1920) / 1080
    const b = wide(700)
    expect(after(b, alignShiftX(b, safe, 'left', 1920)).minX).toBeCloseTo(margin, 9)
    expect(after(b, alignShiftX(b, safe, 'right', 1920)).maxX).toBeCloseTo(1920 - margin, 9)
    const c = after(b, alignShiftX(b, safe, 'center', 1920))
    expect((c.minX + c.maxX) / 2).toBe(960)
  })

  it('a box wider than the room still has its left edge on the margin for left, its right edge for right', () => {
    const b = { minX: 100, maxX: 1000, minY: 0, maxY: 10 } // 900 wide, the room is 854
    expect(after(b, alignShiftX(b, SAFE, 'left', 1080)).minX).toBe(48)
    expect(after(b, alignShiftX(b, SAFE, 'right', 1080)).maxX).toBe(902)
  })
})
