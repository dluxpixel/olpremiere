import { describe, expect, it } from 'vitest'

import { computeQuad } from './render/mat'
import { INNER_ZOOM, cropForZoom, isSymmetricCrop, zoomFromCrop } from './innerZoom'
import { defaultTransform } from './types'

describe('cropForZoom', () => {
  it('touches nothing at 1', () => {
    expect(cropForZoom(1)).toBe(0)
    expect(cropForZoom(0.5)).toBe(0)
  })

  it('keeps 1/zoom of each axis, split evenly across the two sides', () => {
    // At 2x, half the picture is kept, so a quarter comes off each edge.
    expect(cropForZoom(2)).toBeCloseTo(0.25, 10)
    expect(cropForZoom(4)).toBeCloseTo(0.375, 10)
    expect(cropForZoom(1.25)).toBeCloseTo(0.1, 10)
  })

  it('round-trips through zoomFromCrop', () => {
    for (const z of [1, 1.1, 1.5, 2, 3, 4]) {
      const c = cropForZoom(z)
      expect(zoomFromCrop(c, c)).toBeCloseTo(z, 10)
    }
  })

  it('never reads back past the envelope', () => {
    expect(zoomFromCrop(0.5, 0.5)).toBe(INNER_ZOOM.max)
    expect(zoomFromCrop(0, 0)).toBe(1)
  })
})

describe('isSymmetricCrop', () => {
  it('recognises what the zoom writes', () => {
    const c = cropForZoom(1.8)
    expect(isSymmetricCrop(c, c, c, c)).toBe(true)
  })

  it('refuses a crop set one edge at a time', () => {
    expect(isSymmetricCrop(0.2, 0.2, 0.1, 0.2)).toBe(false)
    expect(isSymmetricCrop(0.2, 0.1, 0.2, 0.1)).toBe(false)
  })
})

// ⛔ THE CLAIM THE WHOLE FEATURE RESTS ON. If a symmetric crop moved the
// rectangle, this would be Scale with extra steps and the blurred bands would
// change size behind it, which is the exact thing he asked it not to do.
describe('the picture does not move', () => {
  const quad = (zoom: number) =>
    computeQuad({
      frameW: 1080,
      frameH: 1920,
      texW: 1920,
      texH: 1080,
      transform: {
        ...defaultTransform(),
        cropT: cropForZoom(zoom),
        cropR: cropForZoom(zoom),
        cropB: cropForZoom(zoom),
        cropL: cropForZoom(zoom),
        fit: 'contain',
      },
    }).corners

  it('lands on the same four corners at every zoom', () => {
    const at1 = quad(1)
    for (const z of [1.25, 1.6, 2, 3.5]) {
      const at = quad(z)
      at.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(at1[i][0], 6)
        expect(y).toBeCloseTo(at1[i][1], 6)
      })
    }
  })

  it('still fills the frame width of a 9:16 short, so no new bars appear', () => {
    const [tl, tr] = quad(2)
    expect(tl[0]).toBeCloseTo(0, 6)
    expect(tr[0]).toBeCloseTo(1080, 6)
  })
})
