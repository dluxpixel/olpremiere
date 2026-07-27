import { describe, expect, it } from 'vitest'
import { computeQuad, pointInQuad, subQuad } from './mat'
import { titleInkBoxUV } from './titleRaster'
import { defaultTitleDef, defaultTransform, type TitleDef } from '../types'
import type { ResolvedTransform } from './types'

const W = 1920
const H = 1080

const title = (over: Partial<TitleDef> = {}): TitleDef => ({ ...defaultTitleDef('Hello'), ...over })

// Deterministic measurer (node has no canvas): every glyph is 0.6em wide, which
// is close enough to a real font for the geometry these tests assert.
const measureFor =
  (def: TitleDef) =>
  (s: string): number =>
    s.length * def.fontSizePx * 0.6

const inkBox = (def: TitleDef, w = W, h = H) => titleInkBoxUV(def, w, h, measureFor(def))

const resolved = (over: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
  ...defaultTransform(),
  ...{ x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5, cropT: 0, cropR: 0, cropB: 0, cropL: 0 },
  ...over,
})

describe('titleInkBoxUV', () => {
  it('is a small part of the frame, not the whole frame', () => {
    const uv = inkBox(title())!
    expect(uv).not.toBeNull()
    const area = (uv.u1 - uv.u0) * (uv.v1 - uv.v0)
    expect(area).toBeLessThan(0.5) // the bug was area === 1
    expect(uv.u0).toBeGreaterThanOrEqual(0)
    expect(uv.v0).toBeGreaterThanOrEqual(0)
    expect(uv.u1).toBeLessThanOrEqual(1)
    expect(uv.v1).toBeLessThanOrEqual(1)
    expect(uv.u1).toBeGreaterThan(uv.u0)
    expect(uv.v1).toBeGreaterThan(uv.v0)
  })

  it('follows the vertical alignment', () => {
    const top = inkBox(title({ vAlign: 'top' }))!
    const bottom = inkBox(title({ vAlign: 'bottom' }))!
    expect(top.v0).toBeLessThan(bottom.v0)
  })

  it('grows with the font size', () => {
    const small = inkBox(title({ fontSizePx: 40 }))!
    const big = inkBox(title({ fontSizePx: 160 }))!
    expect((big.u1 - big.u0) * (big.v1 - big.v0)).toBeGreaterThan((small.u1 - small.u0) * (small.v1 - small.v0))
  })

  it('includes the outline and the drop shadow', () => {
    const plain = inkBox(title())!
    const outlined = inkBox(title({ outline: { color: '#000', widthPx: 40 } }))!
    expect(outlined.v0).toBeLessThan(plain.v0)

    const shadowed = inkBox(title({ shadow: { color: '#000', dx: 0, dy: 60, blurPx: 0 } }))!
    expect(shadowed.v1).toBeGreaterThan(plain.v1)
  })

  it('uses the background box when there is one', () => {
    const plain = inkBox(title())!
    const boxed = inkBox(title({ box: { color: '#000', paddingPx: 50, radiusPx: 0 } }))!
    expect(boxed.u0).toBeLessThan(plain.u0)
    expect(boxed.v0).toBeLessThan(plain.v0)
  })

  it('is null when the title draws nothing at all', () => {
    expect(inkBox(title({ text: '' }))).toBeNull()
    expect(inkBox(title({ fontSizePx: 0 }))).toBeNull()
  })

  it('a shape with no text is still hittable', () => {
    const uv = inkBox(title({ text: '', box: { color: '#000', paddingPx: 20, radiusPx: 0 } }))
    expect(uv).not.toBeNull()
  })
})

describe('a caption does not swallow every click in the monitor', () => {
  const quadOf = (def: TitleDef, tf = resolved()) => {
    const corners = computeQuad({ frameW: W, frameH: H, texW: W, texH: H, transform: tf }).corners
    const uv = inkBox(def)!
    return subQuad(corners, uv)
  }

  it('a bottom caption is hit on the caption and MISSED in the middle of the frame', () => {
    // A Shorts caption: bottom third, one short word.
    const def = title({ text: 'GO', vAlign: 'bottom', fontSizePx: 96 })
    const q = quadOf(def)
    const uv = inkBox(def)!

    const midX = ((uv.u0 + uv.u1) / 2) * W
    const midY = ((uv.v0 + uv.v1) / 2) * H
    expect(pointInQuad(midX, midY, q)).toBe(true)

    // The gameplay clip underneath is reachable. That is the whole point.
    expect(pointInQuad(W / 2, H * 0.25, q)).toBe(false)
    expect(pointInQuad(W * 0.05, H * 0.5, q)).toBe(false)
  })

  it('follows the clip transform, so a moved caption is hit where it now is', () => {
    const def = title({ text: 'GO', vAlign: 'bottom', fontSizePx: 96 })
    const uv = inkBox(def)!
    const midX = ((uv.u0 + uv.u1) / 2) * W
    const midY = ((uv.v0 + uv.v1) / 2) * H

    const shifted = quadOf(def, resolved({ x: 400 }))
    expect(pointInQuad(midX, midY, shifted)).toBe(false)
    expect(pointInQuad(midX + 400, midY, shifted)).toBe(true)
  })
})

describe('subQuad', () => {
  it('the full 0..1 rectangle is the quad itself', () => {
    const corners = computeQuad({ frameW: W, frameH: H, texW: W, texH: H, transform: resolved() }).corners
    const same = subQuad(corners, { u0: 0, v0: 0, u1: 1, v1: 1 })
    same.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(corners[i][0], 6)
      expect(y).toBeCloseTo(corners[i][1], 6)
    })
  })

  it('stays inside a rotated quad', () => {
    const corners = computeQuad({
      frameW: W,
      frameH: H,
      texW: W,
      texH: H,
      transform: resolved({ rotationDeg: 30 }),
    }).corners
    const inner = subQuad(corners, { u0: 0.4, v0: 0.4, u1: 0.6, v1: 0.6 })
    for (const [x, y] of inner) expect(pointInQuad(x, y, corners)).toBe(true)
  })
})
