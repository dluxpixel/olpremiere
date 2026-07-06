import { describe, expect, it } from 'vitest'
import { apply, computeQuad, cropUV, croppedSize, fitScale, identity, multiply, rotation } from './mat'
import { NEUTRAL_FILTERS } from './types'
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

// Silence unused import in a place that also documents the neutral filter set.
void NEUTRAL_FILTERS

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

describe('computeQuad — identity contain-fit', () => {
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

describe('computeQuad — scale', () => {
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

describe('computeQuad — position', () => {
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

describe('computeQuad — rotation about anchor', () => {
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

describe('computeQuad — crop drives the fitted size', () => {
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
