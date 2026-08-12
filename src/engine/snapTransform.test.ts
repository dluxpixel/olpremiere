import { describe, expect, it } from 'vitest'
import { boxFromQuad, snapTransformMove, type SnapBox } from './snapTransform'

// A 1920x1080 frame with a half-size clip sitting dead centre: its box runs
// 480..1440 across and 270..810 down, and its transform offsets are 0,0.
const W = 1920
const H = 1080
const CENTRED: SnapBox = { minX: 480, maxX: 1440, minY: 270, maxY: 810 }
const TOL = 10

const snap = (x: number, y: number, box: SnapBox = CENTRED) => snapTransformMove(x, y, 0, 0, box, W, H, TOL)

describe('snapTransformMove', () => {
  it('leaves a move alone when it is nowhere near anything', () => {
    const r = snap(200, 130)
    expect(r.x).toBe(200)
    expect(r.y).toBe(130)
    expect(r.guideX).toBeNull()
    expect(r.guideY).toBeNull()
  })

  it('still snaps to the frame centre, which it always did', () => {
    const r = snap(4, -3)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.guideX).toBe(W / 2)
    expect(r.guideY).toBe(H / 2)
  })

  // Dragging left: the clip's left edge is at 480, so it reaches the frame's
  // left edge when x has travelled -480.
  it('catches the left edge', () => {
    const r = snap(-475, 500)
    expect(r.x).toBe(-480)
    expect(r.guideX).toBe(0)
  })

  it('catches the right edge', () => {
    const r = snap(477, 500)
    expect(r.x).toBe(480)
    expect(r.guideX).toBe(W)
  })

  it('catches the top and bottom edges', () => {
    expect(snap(900, -265).y).toBe(-270)
    expect(snap(900, 274).y).toBe(270)
  })

  // ⛔ THE ONE HE ASKED FOR. A corner is not special cased anywhere: it is the
  // left edge and the top edge both catching in the same move.
  it('fits to a corner, because both axes catch at once', () => {
    const r = snap(-476, -268)
    expect(r.x).toBe(-480)
    expect(r.y).toBe(-270)
    expect(r.guideX).toBe(0)
    expect(r.guideY).toBe(0)
    // And it really is the corner: the box lands flush on both edges.
    expect(CENTRED.minX + (r.x - 0)).toBe(0)
    expect(CENTRED.minY + (r.y - 0)).toBe(0)
  })

  it('snaps one axis without dragging the other along', () => {
    const r = snap(-478, 133)
    expect(r.x).toBe(-480)
    expect(r.y).toBe(133)
    expect(r.guideY).toBeNull()
  })

  // A clip larger than the frame still has edges, and they are the ones that
  // matter: this is how a blown-up clip is pinned flush rather than by eye.
  it('works for a clip bigger than the frame', () => {
    const big: SnapBox = { minX: -300, maxX: 2220, minY: -200, maxY: 1280 }
    const r = snapTransformMove(295, 0, 0, 0, big, W, H, TOL)
    expect(r.x).toBe(300) // left edge -300 travels to 0
    expect(r.guideX).toBe(0)
  })

  // The box is measured ONCE at drag start, so the maths has to work from a
  // start offset that is not zero. This is the case that breaks if a caller
  // re-reads the box from an already-moved position.
  it('is correct when the drag started away from the origin', () => {
    // Box already sitting 100 right of centre, start offset 100.
    const moved: SnapBox = { minX: 580, maxX: 1540, minY: 270, maxY: 810 }
    const r = snapTransformMove(-476, 0, 100, 0, moved, W, H, TOL)
    // left edge 580 reaches 0 when x has travelled another -580 from 100.
    expect(r.x).toBe(-480)
    expect(r.guideX).toBe(0)
  })

  it('takes the nearest target when two are in range', () => {
    // A clip exactly frame-sized: its left edge and its centre coincide, and
    // whichever is nearer must win rather than whichever is listed first.
    const tall: SnapBox = { minX: 0, maxX: W, minY: 0, maxY: H }
    expect(snapTransformMove(3, 0, 0, 0, tall, W, H, TOL).x).toBe(0)
  })
})

describe('boxFromQuad', () => {
  it('takes the extents, so a rotated clip still gets an upright box', () => {
    expect(boxFromQuad([[100, 50], [300, 90], [280, 210], [80, 170]])).toEqual({
      minX: 80,
      maxX: 300,
      minY: 50,
      maxY: 210,
    })
  })
})
