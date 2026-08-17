// The two smears the renderer can draw, and the one it cannot, pinned so nobody
// has to reason about which is which from a screenshot.

import { describe, expect, it } from 'vitest'
import { computeQuad } from './mat'
import { BLUR_FLOOR_PX, deriveMotionBlur, shutterSeconds, type Quad } from './motionBlur'

/** A square, centred, so the arithmetic is readable. */
const square = (cx: number, cy: number, half: number): Quad => [
  [cx - half, cy - half],
  [cx + half, cy - half],
  [cx + half, cy + half],
  [cx - half, cy + half],
]

const transform = (over: Partial<Parameters<typeof computeQuad>[0]['transform']> = {}) => ({
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
  ...over,
})

const quadFor = (over: Parameters<typeof transform>[0]) =>
  computeQuad({ frameW: 1920, frameH: 1080, texW: 1920, texH: 1080, transform: transform(over) }).corners

describe('deriveMotionBlur', () => {
  it('a still picture gets no blur at all, which is the whole point of the floor', () => {
    expect(deriveMotionBlur(square(100, 100, 50), square(100, 100, 50))).toBeNull()
  })

  it('a slow push stays sharp: under the floor is nothing, not a little', () => {
    expect(deriveMotionBlur(square(100, 100, 50), square(101, 100, 50))).toBeNull()
    expect(deriveMotionBlur(square(100, 100, 50), square(100, 100, 50.5))).toBeNull()
  })

  it('travelling right smears right, and the length is the travel', () => {
    const b = deriveMotionBlur(square(100, 100, 50), square(140, 100, 50))
    expect(b?.translatePx).toBeCloseTo(40, 5)
    expect(b?.angleDeg).toBeCloseTo(0, 5)
    expect(b?.radialPx).toBe(0) // it did not change size
  })

  it('travelling up reads as a negative angle, matching atan2 and the shader', () => {
    const b = deriveMotionBlur(square(100, 100, 50), square(100, 60, 50))
    expect(b?.angleDeg).toBeCloseTo(-90, 5)
  })

  it('growing smears radially, and the sign says which way', () => {
    const inward = deriveMotionBlur(square(100, 100, 50), square(100, 100, 60))
    expect(inward?.radialPx).toBeGreaterThan(0)
    expect(inward?.translatePx).toBe(0) // it did not move
    const back = deriveMotionBlur(square(100, 100, 60), square(100, 100, 50))
    expect(back?.radialPx).toBeLessThan(0)
  })

  it('⚠️ a pure spin returns null, because there is no angular blur to draw', () => {
    const a = quadFor({ rotationDeg: 0 })
    const b = quadFor({ rotationDeg: 30 })
    expect(deriveMotionBlur(a, b)).toBeNull()
  })

  it('reads a real punch in off computeQuad, both terms at once', () => {
    // A punch that grows AND drifts, which is what every one of his moves does.
    const a = quadFor({ scale: 1, x: 0 })
    const b = quadFor({ scale: 1.08, x: 24 })
    const blur = deriveMotionBlur(a, b)
    expect(blur).not.toBeNull()
    expect(blur!.translatePx).toBeCloseTo(24, 3)
    expect(blur!.radialPx).toBeGreaterThan(BLUR_FLOOR_PX)
    expect(blur!.angleDeg).toBeCloseTo(0, 3)
  })

  it('a malformed quad is not a crash', () => {
    expect(deriveMotionBlur([[0, 0]], square(0, 0, 1))).toBeNull()
  })
})

describe('shutterSeconds', () => {
  it('180 degrees is half a frame, the film standard and the AE default', () => {
    expect(shutterSeconds(180, 30)).toBeCloseTo(1 / 60, 9)
    expect(shutterSeconds(180, 60)).toBeCloseTo(1 / 120, 9)
  })

  it('0 is off, and a negative angle is treated as off rather than as time running backwards', () => {
    expect(shutterSeconds(0, 30)).toBe(0)
    expect(shutterSeconds(-90, 30)).toBe(0)
  })

  it('360 is a full frame, which is the widest a shutter goes', () => {
    expect(shutterSeconds(360, 30)).toBeCloseTo(1 / 30, 9)
  })

  it('no fps is no shutter rather than an infinity', () => {
    expect(shutterSeconds(180, 0)).toBe(0)
  })
})
