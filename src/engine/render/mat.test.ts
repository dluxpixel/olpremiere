import { describe, expect, it } from 'vitest'
import {
  apply,
  computeQuad,
  cropUV,
  croppedSize,
  fitScale,
  identity,
  multiply,
  pointInQuad,
  rotation,
} from './mat'
import type { ResolvedTransform } from './types'

const NEUTRAL_T: ResolvedTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotationDeg: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  cropT: 0,
  cropR: 0,
  cropB: 0,
  cropL: 0,
}

const tf = (over: Partial<ResolvedTransform>): ResolvedTransform => ({ ...NEUTRAL_T, ...over })

const width = (c: [number, number][]): number => c[1][0] - c[0][0]
const height = (c: [number, number][]): number => c[3][1] - c[0][1]
const centerOf = (c: [number, number][]): [number, number] => [
  (c[0][0] + c[2][0]) / 2,
  (c[0][1] + c[2][1]) / 2,
]

describe('mat3 primitives', () => {
  it('identity leaves a point unchanged', () => {
    expect(apply(identity(), 7, -3)).toEqual([7, -3])
  })
  it('multiply by identity is a no-op', () => {
    const m = rotation(0.7)
    expect(multiply(identity(), m)).toEqual(m)
    expect(multiply(m, identity())).toEqual(m)
  })
  it('rotation is clockwise in +y-down space (90deg maps +x to +y)', () => {
    const [x, y] = apply(rotation(Math.PI / 2), 1, 0)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(1)
  })
})

describe('croppedSize / fitScale', () => {
  it('cropped size shrinks by the inset fractions', () => {
    const { w, h } = croppedSize(1000, 500, 0.1, 0.2, 0.1, 0.2)
    expect(w).toBeCloseTo(1000 * 0.6)
    expect(h).toBeCloseTo(500 * 0.8)
  })
  it('fitScale picks the limiting axis and is 0 for degenerate input', () => {
    expect(fitScale(1920, 1080, 1920, 1080)).toBeCloseTo(1)
    expect(fitScale(1920, 1080, 3840, 1080)).toBeCloseTo(0.5) // width-limited
    expect(fitScale(1920, 1080, 0, 1080)).toBe(0)
  })
})

describe('computeQuad: identity contain-fit', () => {
  it('centers the texture and fits by the limiting axis (wide tex)', () => {
    // 1000x500 tex into 1920x1080: min(1.92, 2.16) = 1.92 → 1920 x 960.
    const { corners } = computeQuad({ frameW: 1920, frameH: 1080, texW: 1000, texH: 500, transform: NEUTRAL_T })
    expect(width(corners)).toBeCloseTo(1920)
    expect(height(corners)).toBeCloseTo(960)
    expect(centerOf(corners)[0]).toBeCloseTo(960)
    expect(centerOf(corners)[1]).toBeCloseTo(540)
    // TL corner sits at the letterbox top offset.
    expect(corners[0][0]).toBeCloseTo(0)
    expect(corners[0][1]).toBeCloseTo((1080 - 960) / 2)
  })
  it('fits by height for a tall texture (pillarbox)', () => {
    // 500x1000 into 1920x1080: min(3.84, 1.08) = 1.08 → 540 x 1080.
    const { corners } = computeQuad({ frameW: 1920, frameH: 1080, texW: 500, texH: 1000, transform: NEUTRAL_T })
    expect(width(corners)).toBeCloseTo(540)
    expect(height(corners)).toBeCloseTo(1080)
    expect(centerOf(corners)).toEqual([expect.closeTo(960), expect.closeTo(540)])
  })
})

describe('computeQuad: scale', () => {
  it('scale=2 doubles the quad about the center, center fixed', () => {
    const base = computeQuad({ frameW: 1920, frameH: 1080, texW: 1000, texH: 500, transform: NEUTRAL_T }).corners
    const scaled = computeQuad({
      frameW: 1920,
      frameH: 1080,
      texW: 1000,
      texH: 500,
      transform: tf({ scale: 2 }),
    }).corners
    expect(width(scaled)).toBeCloseTo(width(base) * 2)
    expect(height(scaled)).toBeCloseTo(height(base) * 2)
    expect(centerOf(scaled)).toEqual([expect.closeTo(960), expect.closeTo(540)])
  })
})

describe('computeQuad: position', () => {
  it('x/y offset the whole quad in seq px', () => {
    const base = computeQuad({ frameW: 1920, frameH: 1080, texW: 1000, texH: 500, transform: NEUTRAL_T }).corners
    const moved = computeQuad({
      frameW: 1920,
      frameH: 1080,
      texW: 1000,
      texH: 500,
      transform: tf({ x: 100, y: -40 }),
    }).corners
    moved.forEach(([mx, my], i) => {
      expect(mx).toBeCloseTo(base[i][0] + 100)
      expect(my).toBeCloseTo(base[i][1] - 40)
    })
  })
})

describe('computeQuad: rotation about anchor', () => {
  it('rotationDeg=90 about center rotates corners clockwise, center fixed', () => {
    const { corners } = computeQuad({
      frameW: 1920,
      frameH: 1080,
      texW: 1000,
      texH: 500,
      transform: tf({ rotationDeg: 90 }),
    })
    // Fitted 1920x960 rect, TL at (0,60), pivot (960,540). TL vector (-960,-480)
    // under a +90deg (clockwise, +y down) turn -> (480,-960) => (1440,-420).
    expect(corners[0][0]).toBeCloseTo(1440)
    expect(corners[0][1]).toBeCloseTo(-420)
    expect(centerOf(corners)).toEqual([expect.closeTo(960), expect.closeTo(540)])
  })
  it('anchor at top-left pivots rotation about the quad corner', () => {
    // Base fitted rect for 1000x500 is 1920x960 with TL at (0,60).
    // Anchor (0,0) => pivot at TL corner; a 180deg rotation keeps TL fixed.
    const { corners } = computeQuad({
      frameW: 1920,
      frameH: 1080,
      texW: 1000,
      texH: 500,
      transform: tf({ rotationDeg: 180, anchorX: 0, anchorY: 0 }),
    })
    expect(corners[0][0]).toBeCloseTo(0)
    expect(corners[0][1]).toBeCloseTo(60)
    // BR, which was diagonally opposite, lands mirrored through the TL pivot.
    expect(corners[2][0]).toBeCloseTo(-1920)
    expect(corners[2][1]).toBeCloseTo(60 - 960)
  })
})

describe('computeQuad: crop drives the fitted size', () => {
  it('cropping the width narrows the cropped source, changing the fit', () => {
    // 1000x500 tex, crop 25% off L and R => cropped 500x500 (square).
    // Into 1920x1080: fit = min(3.84, 2.16) = 2.16 => 1080 x 1080.
    const { corners } = computeQuad({
      frameW: 1920,
      frameH: 1080,
      texW: 1000,
      texH: 500,
      transform: tf({ cropL: 0.25, cropR: 0.25 }),
    })
    expect(width(corners)).toBeCloseTo(1080)
    expect(height(corners)).toBeCloseTo(1080)
    expect(centerOf(corners)).toEqual([expect.closeTo(960), expect.closeTo(540)])
  })
})

describe('cropUV', () => {
  it('maps crop fractions to the sampled UV rectangle (v down)', () => {
    const uv = cropUV(0.1, 0.2, 0.3, 0.05)
    expect(uv).toEqual({ u0: 0.05, v0: 0.1, u1: 0.8, v1: 0.7 })
  })
  it('neutral crop samples the full [0,1] square', () => {
    expect(cropUV(0, 0, 0, 0)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 })
  })
})

describe('pointInQuad', () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  it('detects inside vs outside', () => {
    expect(pointInQuad(5, 5, square)).toBe(true)
    expect(pointInQuad(15, 5, square)).toBe(false)
    expect(pointInQuad(5, 15, square)).toBe(false)
    expect(pointInQuad(-1, 5, square)).toBe(false)
  })
  it('works for a rotated quad (diamond)', () => {
    const diamond: [number, number][] = [
      [5, 0],
      [10, 5],
      [5, 10],
      [0, 5],
    ]
    expect(pointInQuad(5, 5, diamond)).toBe(true) // center
    expect(pointInQuad(1, 1, diamond)).toBe(false) // corner region cut off
  })
})

// The blurred backdrop's whole job is to have no bars on it, so it fits the
// other way round from every other layer: grow until the frame is full and let
// the overflow fall off the edges.
describe('cover fit, for the blurred backdrop', () => {
  const tf = (over: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
    x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5,
    cropT: 0, cropR: 0, cropB: 0, cropL: 0, ...over,
  })

  it('16:9 gameplay in a 9:16 frame CONTAINS with bars, which is the bug he sees', () => {
    const { corners } = computeQuad({ frameW: 1080, frameH: 1920, texW: 1920, texH: 1080, transform: tf() })
    const top = Math.min(...corners.map((c) => c[1]))
    const bottom = Math.max(...corners.map((c) => c[1]))
    // Fills the width, leaves a band above and below: the black bars.
    expect(bottom - top).toBeCloseTo(1080 * (1080 / 1920), 3)
    expect(top).toBeGreaterThan(0)
  })

  it("and COVERS the same frame with nothing left over", () => {
    const { corners } = computeQuad({
      frameW: 1080, frameH: 1920, texW: 1920, texH: 1080, transform: tf({ fit: 'cover' }),
    })
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    // Reaches or passes every edge: no bar anywhere.
    expect(Math.min(...xs)).toBeLessThanOrEqual(0)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(1080)
    expect(Math.min(...ys)).toBeLessThanOrEqual(0)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(1920)
  })

  it('covers a 9:16 source in a 16:9 frame too, the other way round', () => {
    const { corners } = computeQuad({
      frameW: 1920, frameH: 1080, texW: 1080, texH: 1920, transform: tf({ fit: 'cover' }),
    })
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    expect(Math.min(...xs)).toBeLessThanOrEqual(0)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(1920)
    expect(Math.min(...ys)).toBeLessThanOrEqual(0)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(1080)
  })

  it('leaves a matching source alone: cover and contain agree when shapes match', () => {
    const opts = { frameW: 1080, frameH: 1920, texW: 1080, texH: 1920 }
    const contain = computeQuad({ ...opts, transform: tf() }).corners
    const cover = computeQuad({ ...opts, transform: tf({ fit: 'cover' }) }).corners
    expect(cover).toEqual(contain)
  })
})

// His ask, 2026-09-29: "make it so when i for example paste in a 4:3clip it
// stretches to 16:9 when i select to". Stretch is the one framing no uniform
// scale can reach, so it lives in the quad itself: the picture's four corners
// go onto the frame's four corners, each axis scaled on its own.
describe('stretch fit, only when he picks it', () => {
  const tf = (over: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
    x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5,
    cropT: 0, cropR: 0, cropB: 0, cropL: 0, ...over,
  })
  const FRAME_CORNERS = (w: number, h: number): [number, number][] => [[0, 0], [w, 0], [w, h], [0, h]]
  const expectCorners = (got: [number, number][], want: [number, number][]) => {
    expect(got).toHaveLength(4)
    got.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(want[i][0], 9)
      expect(y).toBeCloseTo(want[i][1], 9)
    })
  }

  it('a 4:3 clip in a 16:9 frame lands with its corners on the frame corners', () => {
    const { corners } = computeQuad({ frameW: 1920, frameH: 1080, texW: 640, texH: 480, transform: tf({ fit: 'stretch' }) })
    expectCorners(corners, FRAME_CORNERS(1920, 1080))
  })

  it('and the same 4:3 clip fills a 9:16 frame exactly too, any shape into any shape', () => {
    const { corners } = computeQuad({ frameW: 1080, frameH: 1920, texW: 640, texH: 480, transform: tf({ fit: 'stretch' }) })
    expectCorners(corners, FRAME_CORNERS(1080, 1920))
  })

  it('a 16:9 clip in a 9:16 short fills it with nothing cropped', () => {
    const { corners } = computeQuad({ frameW: 1080, frameH: 1920, texW: 1920, texH: 1080, transform: tf({ fit: 'stretch' }) })
    expectCorners(corners, FRAME_CORNERS(1080, 1920))
  })

  it('leaves the default alone: without stretch the 4:3 clip still fits inside with bars', () => {
    const { corners } = computeQuad({ frameW: 1920, frameH: 1080, texW: 640, texH: 480, transform: tf() })
    // 640x480 x 2.25 = 1440x1080, centred: 240 px of bar each side.
    expectCorners(corners, [[240, 0], [1680, 0], [1680, 1080], [240, 1080]])
  })

  it('a matching shape is drawn the same whichever fit it has', () => {
    const opts = { frameW: 1920, frameH: 1080, texW: 1920, texH: 1080 }
    const contain = computeQuad({ ...opts, transform: tf() }).corners
    const stretch = computeQuad({ ...opts, transform: tf({ fit: 'stretch' }) }).corners
    expectCorners(stretch, contain)
  })

  it('scale, position and rotation still work on top of the stretched picture', () => {
    const { corners } = computeQuad({
      frameW: 1920, frameH: 1080, texW: 640, texH: 480,
      transform: tf({ fit: 'stretch', scale: 0.5, x: 100, y: -50 }),
    })
    // Half the frame, centred, then moved.
    expectCorners(corners, [[480 + 100, 270 - 50], [1440 + 100, 270 - 50], [1440 + 100, 810 - 50], [480 + 100, 810 - 50]])
    const turned = computeQuad({
      frameW: 1920, frameH: 1080, texW: 640, texH: 480, transform: tf({ fit: 'stretch', rotationDeg: 90 }),
    }).corners
    // A quarter turn about the centre: the 1920 wide picture now stands 1920 tall.
    expect(Math.hypot(turned[1][0] - turned[0][0], turned[1][1] - turned[0][1])).toBeCloseTo(1920, 6)
    expect(turned[0][0]).toBeCloseTo(960 + 540, 6)
    expect(turned[0][1]).toBeCloseTo(540 - 960, 6)
  })

  it('the anchor is a point on the STRETCHED picture, so a zoom grows from the corner he picked', () => {
    const { corners } = computeQuad({
      frameW: 1920, frameH: 1080, texW: 640, texH: 480,
      transform: tf({ fit: 'stretch', scale: 2, anchorX: 0, anchorY: 0 }),
    })
    // Grows from the frame's top left corner, which stays put.
    expectCorners(corners, [[0, 0], [3840, 0], [3840, 2160], [0, 2160]])
  })

  it('a crop picks the part of the picture, and that part is what gets stretched to the frame', () => {
    // A symmetric crop is the Zoom inside field: the picture keeps its place and
    // the shot gets closer, exactly as it does on a fitted clip.
    const zoomed = computeQuad({
      frameW: 1920, frameH: 1080, texW: 640, texH: 480,
      transform: tf({ fit: 'stretch', cropT: 0.25, cropR: 0.25, cropB: 0.25, cropL: 0.25 }),
    }).corners
    expectCorners(zoomed, FRAME_CORNERS(1920, 1080))
    // A crop off one side keeps the frame filled too: nothing goes black.
    const oneSide = computeQuad({
      frameW: 1920, frameH: 1080, texW: 640, texH: 480, transform: tf({ fit: 'stretch', cropL: 0.5 }),
    }).corners
    expectCorners(oneSide, FRAME_CORNERS(1920, 1080))
  })

  it('stretches into the inner content box, not the whole frame, when the sequence has one', () => {
    const box = { x: 0, y: 420, w: 1080, h: 1080 }
    const { corners } = computeQuad({
      frameW: 1080, frameH: 1920, texW: 640, texH: 480, transform: tf({ fit: 'stretch', frame: box }),
    })
    expectCorners(corners, [[0, 420], [1080, 420], [1080, 1500], [0, 1500]])
  })

  it('draws nothing for a picture with no size, rather than a frame filling smear', () => {
    const { corners } = computeQuad({ frameW: 1920, frameH: 1080, texW: 0, texH: 0, transform: tf({ fit: 'stretch' }) })
    expectCorners(corners, [[960, 540], [960, 540], [960, 540], [960, 540]])
  })
})
