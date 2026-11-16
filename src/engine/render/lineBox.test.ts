import { describe, expect, it, vi } from 'vitest'
import {
  TIKTOK_LINE_BOX,
  contrastTextColor,
  lineBoxShapes,
  tiktokLineBox,
  traceLineBox,
  type LineBoxShape,
  type LineSpan,
} from './lineBox'

// Round numbers so every corner below can be counted by hand: 40 px line cells,
// 10 px of side pad, 5 px of top and bottom pad, a 10 px radius.
const PAD_X = 10
const PAD_Y = 5
const R = 10

/** Row `row` of text, `left` to `right`, in a 40 px cell. */
const line = (left: number, right: number, row: number): LineSpan => ({ left, right, top: row * 40, bottom: row * 40 + 40 })
const shapesOf = (lines: (LineSpan | null)[], r = R): LineBoxShape[] => lineBoxShapes(lines, PAD_X, PAD_Y, r)
const pts = (s: LineBoxShape): [number, number][] => s.map((c) => [c.x, c.y])

/** The rule that keeps arcs from overlapping: a corner's radius is at most half of each edge it sits on. */
function expectNoArcOverlap(shape: LineBoxShape): void {
  shape.forEach((c, i) => {
    const prev = shape[(i + shape.length - 1) % shape.length]!
    const next = shape[(i + 1) % shape.length]!
    const toPrev = Math.hypot(c.x - prev.x, c.y - prev.y)
    const toNext = Math.hypot(c.x - next.x, c.y - next.y)
    expect(c.r).toBeLessThanOrEqual(Math.min(toPrev, toNext) / 2 + 1e-9)
  })
}

describe('lineBoxShapes', () => {
  it('one line is a plain rounded rectangle, padded on every side', () => {
    const shapes = shapesOf([line(100, 200, 0)])
    expect(shapes).toHaveLength(1)
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 45],
      [90, 45],
      [90, -5],
    ])
    for (const c of shapes[0]!) expect(c.r).toBe(R)
  })

  it('a wide line over a narrow one steps in with an inner corner on each side', () => {
    const shapes = shapesOf([line(0, 200, 0), line(50, 150, 1)])
    expect(shapes).toHaveLength(1)
    // The two bands meet at y 40: no gap and no seam between the lines.
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 40],
      [160, 40],
      [160, 85],
      [40, 85],
      [40, 40],
      [-10, 40],
      [-10, -5],
    ])
    for (const c of shapes[0]!) expect(c.r).toBe(R)
    expectNoArcOverlap(shapes[0]!)
  })

  it('a narrow line over a wide one steps out', () => {
    const shapes = shapesOf([line(50, 150, 0), line(0, 200, 1)])
    expect(shapes).toHaveLength(1)
    expect(pts(shapes[0]!)).toEqual([
      [160, -5],
      [160, 40],
      [210, 40],
      [210, 85],
      [-10, 85],
      [-10, 40],
      [40, 40],
      [40, -5],
    ])
    expectNoArcOverlap(shapes[0]!)
  })

  it('three lines in a zigzag make one shape with an inner corner at every step', () => {
    const shapes = shapesOf([line(0, 200, 0), line(50, 150, 1), line(20, 180, 2)])
    expect(shapes).toHaveLength(1)
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 40],
      [160, 40],
      [160, 80],
      [190, 80],
      [190, 125],
      [10, 125],
      [10, 80],
      [40, 80],
      [40, 40],
      [-10, 40],
      [-10, -5],
    ])
    expectNoArcOverlap(shapes[0]!)
  })

  it('snaps a side that differs by less than twice the radius to the wider line', () => {
    // 4 px apart on each side: a sliver step, so both lines become one rectangle.
    const near = shapesOf([line(0, 200, 0), line(4, 196, 1)])
    expect(near).toHaveLength(1)
    expect(pts(near[0]!)).toEqual([
      [210, -5],
      [210, 85],
      [-10, 85],
      [-10, -5],
    ])
    // The second line is the wider one on the right: the snap goes UP to it.
    const wider = shapesOf([line(0, 196, 0), line(4, 200, 1)])
    expect(pts(wider[0]!)).toEqual([
      [210, -5],
      [210, 85],
      [-10, 85],
      [-10, -5],
    ])
  })

  it('snaps one side and keeps the other when only one is near equal', () => {
    // Left edges are 4 apart (snapped), right edges 50 apart (a real step).
    const shapes = shapesOf([line(0, 200, 0), line(4, 150, 1)])
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 40],
      [160, 40],
      [160, 85],
      [-10, 85],
      [-10, -5],
    ])
  })

  it('snaps below twice the radius and keeps a step of exactly that', () => {
    expect(shapesOf([line(0, 200, 0), line(0, 181, 1)])[0]).toHaveLength(4)
    expect(shapesOf([line(0, 200, 0), line(0, 180, 1)])[0]).toHaveLength(6)
  })

  it('a blank line splits the shape into two', () => {
    const shapes = shapesOf([line(0, 200, 0), null, line(0, 100, 2)])
    expect(shapes).toHaveLength(2)
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 45],
      [-10, 45],
      [-10, -5],
    ])
    expect(pts(shapes[1]!)).toEqual([
      [110, 75],
      [110, 125],
      [-10, 125],
      [-10, 75],
    ])
  })

  it('left aligned text shares the left edge and steps on the right', () => {
    const shapes = shapesOf([line(0, 200, 0), line(0, 100, 1)])
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 40],
      [110, 40],
      [110, 85],
      [-10, 85],
      [-10, -5],
    ])
  })

  it('right aligned text shares the right edge and steps on the left', () => {
    const shapes = shapesOf([line(100, 200, 0), line(0, 200, 1)])
    expect(shapes).toHaveLength(1)
    expect(pts(shapes[0]!)).toEqual([
      [210, -5],
      [210, 85],
      [-10, 85],
      [-10, 40],
      [90, 40],
      [90, -5],
    ])
    expectNoArcOverlap(shapes[0]!)
  })

  it('joins lines whose cells overlap or leave a gap at one shared edge', () => {
    // Padded bands that overlap by 20 and bands that leave 20: both meet at y 40.
    const overlap = shapesOf([
      { left: 0, right: 200, top: 0, bottom: 45 },
      { left: 50, right: 150, top: 35, bottom: 80 },
    ])
    expect(pts(overlap[0]!)[1]).toEqual([210, 40])
    const gap = shapesOf([
      { left: 0, right: 200, top: 0, bottom: 25 },
      { left: 50, right: 150, top: 55, bottom: 80 },
    ])
    expect(pts(gap[0]!)[1]).toEqual([210, 40])
  })

  it('lines that do not overlap sideways are separate shapes', () => {
    const shapes = lineBoxShapes([line(0, 10, 0), line(200, 210, 1)], 0, 0, R)
    expect(shapes).toHaveLength(2)
  })

  it('clamps the radius to half of the shortest edge it sits on', () => {
    // One 40 px line, 5 px of pad top and bottom: 50 px tall, so a 100 px radius becomes 25.
    const one = shapesOf([line(0, 400, 0)], 100)
    for (const c of one[0]!) expect(c.r).toBe(25)
    // Thin lines: the inner corners cannot take more than half a line height.
    const thin = lineBoxShapes(
      [
        { left: 0, right: 200, top: 0, bottom: 10 },
        { left: 50, right: 150, top: 10, bottom: 20 },
      ],
      0,
      0,
      R,
    )
    expectNoArcOverlap(thin[0]!)
    expect(Math.max(...thin[0]!.map((c) => c.r))).toBe(5)
  })

  it('draws nothing for no lines, a zero width line, or a zero height line', () => {
    expect(shapesOf([])).toEqual([])
    expect(shapesOf([null, null])).toEqual([])
    expect(lineBoxShapes([{ left: 5, right: 5, top: 0, bottom: 0 }], 0, 0, R)).toEqual([])
  })
})

describe('traceLineBox', () => {
  it('starts mid edge and rounds every corner with arcTo, then closes', () => {
    const calls: unknown[][] = []
    const ctx = {
      moveTo: (...a: number[]) => void calls.push(['moveTo', ...a]),
      arcTo: (...a: number[]) => void calls.push(['arcTo', ...a]),
      closePath: () => void calls.push(['closePath']),
    }
    traceLineBox(ctx, shapesOf([line(100, 200, 0)]))
    expect(calls).toEqual([
      ['moveTo', 150, -5],
      ['arcTo', 210, -5, 210, 45, 10],
      ['arcTo', 210, 45, 90, 45, 10],
      ['arcTo', 90, 45, 90, -5, 10],
      ['arcTo', 90, -5, 210, -5, 10],
      ['closePath'],
    ])
  })

  it('traces each shape on its own sub path', () => {
    const ctx = { moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn() }
    traceLineBox(ctx, shapesOf([line(0, 100, 0), null, line(0, 100, 2)]))
    expect(ctx.moveTo).toHaveBeenCalledTimes(2)
    expect(ctx.closePath).toHaveBeenCalledTimes(2)
    expect(ctx.arcTo).toHaveBeenCalledTimes(8)
  })
})

describe('the TikTok constants', () => {
  it('are the decided numbers, in em, and flagged as not yet measured', () => {
    expect(TIKTOK_LINE_BOX).toEqual({ padXEm: 0.32, padYEm: 0.1, radiusEm: 0.3 })
  })

  it('tiktokLineBox builds a TitleLineBox from them', () => {
    expect(tiktokLineBox('#ffffff', 1)).toEqual({ color: '#ffffff', opacity: 1, padXEm: 0.32, padYEm: 0.1, radiusEm: 0.3 })
  })
})

describe('contrastTextColor', () => {
  it('puts black text on a light box and white text on a dark one', () => {
    expect(contrastTextColor('#ffffff')).toBe('#000000')
    expect(contrastTextColor('#FFD400')).toBe('#000000')
    expect(contrastTextColor('#000000')).toBe('#ffffff')
    expect(contrastTextColor('#1a1a1a')).toBe('#ffffff')
    expect(contrastTextColor('#c02749')).toBe('#ffffff')
  })

  it('reads short hex and rgb() forms, and takes white for what it cannot read', () => {
    expect(contrastTextColor('#fff')).toBe('#000000')
    expect(contrastTextColor('rgba(255,255,255,0.5)')).toBe('#000000')
    expect(contrastTextColor('rgb(0, 0, 0)')).toBe('#ffffff')
    expect(contrastTextColor('not a colour')).toBe('#ffffff')
  })
})
