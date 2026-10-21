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

  it('holds the word box, which can sit round any word of the line', () => {
    const wordBox = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }
    const plain = inkBox(title({ outline: undefined, shadow: undefined }))!
    const boxed = inkBox(title({ outline: undefined, shadow: undefined, wordBox }))!
    expect(boxed.u0).toBeLessThan(plain.u0)
    expect(boxed.u1).toBeGreaterThan(plain.u1)
    // The margin above the capitals is taller than the line's own space above them.
    expect(boxed.v0).toBeLessThan(plain.v0)
    // Below the baseline the line's own space already holds the box, so it need not grow.
    expect(boxed.v1).toBeGreaterThanOrEqual(plain.v1)
    // An inverted backdrop draws no box, so it does not make the click target bigger.
    const inverted = inkBox(title({ outline: undefined, shadow: undefined, invertBackdrop: true }))!
    const invertedBoxed = inkBox(title({ outline: undefined, shadow: undefined, invertBackdrop: true, wordBox }))!
    expect(invertedBoxed).toEqual(inverted)
  })

  it('holds the growth of a size pop, which draws a word bigger than the line', () => {
    const base = title({ text: 'Hello there', outline: undefined, shadow: undefined })
    const plain = titleInkBoxUV(base, W, H, measureFor(base), null)!
    const popped = titleInkBoxUV({ ...base, wordPopSize: 1.15 }, W, H, measureFor(base), null)!
    // Never smaller on any side, and bigger on at least one where the text is clear of the frame.
    expect(plain.u0).toBeGreaterThan(0)
    expect(plain.u1).toBeLessThan(1)
    expect(plain.v0).toBeGreaterThan(0)
    expect(popped.u0).toBeLessThanOrEqual(plain.u0)
    expect(popped.u1).toBeGreaterThanOrEqual(plain.u1)
    expect(popped.v0).toBeLessThanOrEqual(plain.v0)
    expect(popped.v1).toBeGreaterThanOrEqual(plain.v1)
    expect(popped.u0).toBeLessThan(plain.u0)
    expect(popped.u1).toBeGreaterThan(plain.u1)
    // A bigger peak reaches further.
    const bigger = titleInkBoxUV({ ...base, wordPopSize: 1.5 }, W, H, measureFor(base), null)!
    expect(bigger.u1 - bigger.u0).toBeGreaterThan(popped.u1 - popped.u0)
    // No pop at all (one or less, or not a number) leaves the box as it was.
    for (const none of [1, 0.9, null, Number.NaN]) {
      expect(titleInkBoxUV({ ...base, wordPopSize: none }, W, H, measureFor(base), null)).toEqual(plain)
    }
  })

  it('a size pop also grows the box round the word and what the ink meter says', () => {
    const base = title({ text: 'Hello there', outline: { color: '#000', widthPx: 10 }, shadow: undefined })
    const wordBox = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }
    const meter = {
      capPx: 0.7 * base.fontSizePx,
      inkOf: (w: string) => ({ left: 0, right: measureFor(base)(w), ascent: base.fontSizePx * 0.9, descent: base.fontSizePx * 0.2 }),
    }
    const boxed = titleInkBoxUV({ ...base, wordBox }, W, H, measureFor(base), meter)!
    const poppedBoxed = titleInkBoxUV({ ...base, wordBox, wordPopSize: 1.15 }, W, H, measureFor(base), meter)!
    expect(poppedBoxed.u0).toBeLessThanOrEqual(boxed.u0)
    expect(poppedBoxed.u1).toBeGreaterThanOrEqual(boxed.u1)
    expect(poppedBoxed.v0).toBeLessThanOrEqual(boxed.v0)
    expect(poppedBoxed.v1).toBeGreaterThanOrEqual(boxed.v1)
    expect(poppedBoxed.u1 - poppedBoxed.u0).toBeGreaterThan(boxed.u1 - boxed.u0)
  })

  it('an inverted title draws no pop, so its box is the same with a pop size', () => {
    const base = title({ text: 'Hello there', outline: undefined, shadow: undefined, invertBackdrop: true })
    const plain = titleInkBoxUV(base, W, H, measureFor(base), null)!
    expect(titleInkBoxUV({ ...base, wordPopSize: 1.15 }, W, H, measureFor(base), null)).toEqual(plain)
    expect(titleInkBoxUV({ ...base, wordPopSize: 1.15 }, W, H, measureFor(base))).toEqual(
      titleInkBoxUV(base, W, H, measureFor(base)),
    )
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
