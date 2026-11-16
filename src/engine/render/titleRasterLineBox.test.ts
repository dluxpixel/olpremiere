// The TikTok line highlight in the rasterizer: what it asks the canvas to draw,
// where it sits among the other layers, and what it does to the cache and the
// click target. The geometry itself is lineBox.test.ts; this is the wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, type TitleDef } from '../types'
import { clearTitleCache, rasterizeTitle, titleInkBoxUV } from './titleRaster'
import { tiktokLineBox } from './lineBox'

interface Op {
  op: 'fill' | 'fillText' | 'strokeText'
  text: string
  fillStyle: string
  globalAlpha: number
  shadowBlur: number
  /** For a fill: the arcTo corner points and radii, and how many sub paths (moveTo) the path had. */
  arcs: { x: number; y: number; r: number }[]
  subPaths: number
}

let ops: Op[] = []

/** A 2D context that writes down the fills and text it is asked for, in order. Ten px a character. */
function fakeContext(): unknown {
  let arcs: Op['arcs'] = []
  let subPaths = 0
  const ctx = {
    font: '',
    textAlign: 'center',
    textBaseline: 'alphabetic',
    fillStyle: '' as string,
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: '',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    measureText: (s: string) => ({
      width: s.length * 10,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: s.length * 10,
      actualBoundingBoxAscent: 28,
      actualBoundingBoxDescent: 6,
    }),
    beginPath: () => {
      arcs = []
      subPaths = 0
    },
    closePath: () => undefined,
    moveTo: () => void subPaths++,
    arcTo: (x: number, y: number, _x2: number, _y2: number, r: number) => void arcs.push({ x, y, r }),
    stroke: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    fill: () => {
      ops.push({ op: 'fill', text: '', fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, shadowBlur: ctx.shadowBlur, arcs: [...arcs], subPaths })
    },
    fillText: (text: string) => {
      ops.push({ op: 'fillText', text, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, shadowBlur: ctx.shadowBlur, arcs: [], subPaths: 0 })
    },
    strokeText: (text: string) => {
      ops.push({ op: 'strokeText', text, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, shadowBlur: ctx.shadowBlur, arcs: [], subPaths: 0 })
    },
  }
  return ctx
}

class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): unknown {
    return fakeContext()
  }
}

beforeEach(() => {
  ops = []
  clearTitleCache()
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
})
afterEach(() => {
  vi.unstubAllGlobals()
  clearTitleCache()
})

const W = 800
const H = 400
const FONT = 40
const plain = (text: string, over: Partial<TitleDef> = {}): TitleDef => ({
  ...defaultTitleDef(text),
  fontSizePx: FONT,
  shadow: undefined,
  ...over,
})
const fills = (): Op[] => ops.filter((o) => o.op === 'fill')

describe('a title with a line highlight', () => {
  it('fills the shape under the text, in its colour at its opacity, and puts the alpha back', () => {
    rasterizeTitle(plain('hello', { lineBox: tiktokLineBox('#ffffff', 0.5) }), W, H)
    expect(fills()).toHaveLength(1)
    const f = fills()[0]!
    expect(f.fillStyle).toBe('#ffffff')
    expect(f.globalAlpha).toBe(0.5)
    // The text is drawn after the box, opaque again.
    const text = ops.find((o) => o.op === 'fillText')!
    expect(ops.indexOf(text)).toBeGreaterThan(ops.indexOf(f))
    expect(text.globalAlpha).toBe(1)
  })

  it('draws the box with no shadow on it, under the text and its outline and shadow', () => {
    const def = plain('hello', {
      lineBox: tiktokLineBox('#000000', 1),
      outline: { color: '#ff0000', widthPx: 4 },
      shadow: { color: 'rgba(0,0,0,0.5)', blurPx: 9, dx: 0, dy: 3 },
    })
    rasterizeTitle(def, W, H)
    const box = fills()[0]!
    expect(box.shadowBlur).toBe(0)
    const firstText = ops.findIndex((o) => o.op !== 'fill')
    expect(ops.indexOf(box)).toBeLessThan(firstText)
    expect(ops.filter((o) => o.op === 'strokeText').length).toBeGreaterThan(0)
  })

  it('rounds every corner with the radius in em of the font size, one shape for joined lines', () => {
    rasterizeTitle(plain('ab\nabcdefgh', { lineBox: tiktokLineBox('#ffffff', 1) }), W, H)
    const f = fills()[0]!
    expect(f.subPaths).toBe(1)
    // Narrow over wide: 8 corners, all at 0.3 em.
    expect(f.arcs).toHaveLength(8)
    for (const a of f.arcs) expect(a.r).toBeCloseTo(0.3 * FONT, 6)
  })

  it('hugs each line: the shape spans the widest line plus the pad, centred', () => {
    rasterizeTitle(plain('ab\nabcdefgh', { lineBox: tiktokLineBox('#ffffff', 1) }), W, H)
    const xs = fills()[0]!.arcs.map((a) => a.x)
    const pad = 0.32 * FONT
    // "abcdefgh" is 80 px wide centred on 400.
    expect(Math.min(...xs)).toBeCloseTo(360 - pad, 6)
    expect(Math.max(...xs)).toBeCloseTo(440 + pad, 6)
    // "ab" is 20 px wide: the narrow line's own edges are in the outline too.
    expect(xs.some((x) => Math.abs(x - (390 - pad)) < 1e-6)).toBe(true)
  })

  it('splits into two shapes at a blank line', () => {
    rasterizeTitle(plain('ab\n\ncd', { lineBox: tiktokLineBox('#ffffff', 1) }), W, H)
    const f = fills()[0]!
    expect(f.subPaths).toBe(2)
    expect(f.arcs).toHaveLength(8)
  })

  it('goes with the other layers rather than replacing them: a block box is drawn too, first', () => {
    const def = plain('hello', {
      box: { color: 'rgba(0,0,0,0.6)', paddingPx: 20, radiusPx: 8 },
      lineBox: tiktokLineBox('#ffffff', 1),
    })
    rasterizeTitle(def, W, H)
    expect(fills().map((f) => f.fillStyle)).toEqual(['rgba(0,0,0,0.6)', '#ffffff'])
  })

  it('is drawn under a size pop title too, which draws its words one at a time', () => {
    const def = plain('one two', {
      wordPopSize: 1.15,
      popWord: { at: 1, word: 'two', scale: 1.1 },
      lineBox: tiktokLineBox('#ffffff', 1),
    })
    rasterizeTitle(def, W, H)
    expect(fills()).toHaveLength(1)
    expect(ops.indexOf(fills()[0]!)).toBe(0)
  })

  it('is left out of an inverted title, which is a stencil and takes no decoration', () => {
    rasterizeTitle(plain('hello', { invertBackdrop: true, lineBox: tiktokLineBox('#ffffff', 1) }), W, H)
    expect(fills()).toHaveLength(0)
  })

  it('draws nothing for no text, and nothing at zero opacity', () => {
    rasterizeTitle(plain('', { lineBox: tiktokLineBox('#ffffff', 1) }), W, H)
    expect(fills()).toHaveLength(0)
    rasterizeTitle(plain('hello', { lineBox: tiktokLineBox('#ffffff', 0) }), W, H)
    expect(fills()).toHaveLength(0)
  })
})

describe('a title without a line highlight', () => {
  it('draws no fill at all, and exactly the text it always drew', () => {
    rasterizeTitle(plain('hello'), W, H)
    expect(fills()).toHaveLength(0)
    expect(ops.map((o) => o.op)).toEqual(['fillText'])
  })

  it('keeps its raster cache key: a def with lineBox undefined is the same entry as one without the field', () => {
    const a = plain('hello')
    const b = { ...plain('hello'), lineBox: undefined }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    const first = rasterizeTitle(a, W, H)
    expect(rasterizeTitle(b, W, H)).toBe(first)
    expect(first.width).toBe(W)
    expect(first.height).toBe(H)
  })

  it('re-rasters when the line highlight is switched on, or its colour or opacity change', () => {
    const base = plain('hello')
    const off = rasterizeTitle(base, W, H)
    const on = rasterizeTitle({ ...base, lineBox: tiktokLineBox('#ffffff', 1) }, W, H)
    expect(on).not.toBe(off)
    const recoloured = rasterizeTitle({ ...base, lineBox: tiktokLineBox('#000000', 1) }, W, H)
    expect(recoloured).not.toBe(on)
    const fainter = rasterizeTitle({ ...base, lineBox: tiktokLineBox('#ffffff', 0.5) }, W, H)
    expect(fainter).not.toBe(on)
    // The same highlight in a new object is the same raster.
    expect(rasterizeTitle({ ...base, lineBox: tiktokLineBox('#ffffff', 1) }, W, H)).toBe(on)
  })
})

describe('the click target of a line highlight', () => {
  const measure = (s: string): number => s.length * 10
  const ink = (def: TitleDef) => titleInkBoxUV(def, W, H, measure, null)

  it('grows to hold the padded boxes, where a plain title is only its text', () => {
    const off = ink(plain('hello'))!
    const on = ink(plain('hello', { lineBox: tiktokLineBox('#ffffff', 1) }))!
    expect(on.u0).toBeLessThan(off.u0)
    expect(on.u1).toBeGreaterThan(off.u1)
    expect(on.v0).toBeLessThan(off.v0)
    expect(on.v1).toBeGreaterThan(off.v1)
    // "hello" is 50 px wide: the box reaches 0.32 em past each end.
    expect(on.u0 * W).toBeCloseTo(375 - 0.32 * FONT, 6)
    expect(on.u1 * W).toBeCloseTo(425 + 0.32 * FONT, 6)
  })

  it('is unchanged by an inverted title, which draws no box', () => {
    const off = ink(plain('hello', { invertBackdrop: true }))
    const on = ink(plain('hello', { invertBackdrop: true, lineBox: tiktokLineBox('#ffffff', 1) }))
    expect(on).toEqual(off)
  })
})
