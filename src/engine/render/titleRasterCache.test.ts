// The raster cache holds SEQUENCE-RESOLUTION canvases (a 1080×1920 Short is
// 8.3 MB each), so its bound has to be real. It is kept honest here rather than
// in titleRaster.test.ts because it needs a canvas; that file is deliberately
// canvas-free.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, type TitleDef } from '../types'

/** Just enough 2D context for rasterizeTitle to run headlessly. */
function stubContext(): unknown {
  return {
    font: '',
    textAlign: 'center',
    textBaseline: 'alphabetic',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
    shadowBlur: 0,
    shadowColor: '',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    fill: vi.fn(),
  }
}

class StubOffscreenCanvas {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext(): unknown {
    return stubContext()
  }
}

vi.stubGlobal('OffscreenCanvas', StubOffscreenCanvas)

const { clearTitleCache, rasterizeTitle, titleCacheBytes } = await import('./titleRaster')

const W = 320
const H = 180
// A 9:16 Shorts raster: 8.3 MB each, so a handful of them exceeds the budget.
const SHORT_W = 1080
const SHORT_H = 1920
const defFor = (text: string): TitleDef => ({ ...defaultTitleDef(text) })

describe('title raster cache', () => {
  beforeEach(() => clearTitleCache())

  it('returns the SAME canvas for the same def object (the per-frame fast path)', () => {
    const def = defFor('hello')
    expect(rasterizeTitle(def, W, H)).toBe(rasterizeTitle(def, W, H))
  })

  it('evicting from the bounded cache also releases the identity entry', () => {
    // The identity WeakMap is keyed by the STORE's own TitleDef objects, which
    // live as long as the project — so an entry left behind after eviction pins
    // its canvas forever. A word-caption timeline is one title clip per word,
    // which is how a 60s caption pass used to retain ~1.2 GB of canvases.
    // Shorts-sized rasters: each is 8.3 MB, so a handful busts the budget.
    const first = defFor('word-0')
    const firstCanvas = rasterizeTitle(first, SHORT_W, SHORT_H)

    for (let i = 1; i <= 12; i++) rasterizeTitle(defFor(`word-${i}`), SHORT_W, SHORT_H)

    // `first` was evicted, so it must RE-RASTERIZE rather than hand back the
    // canvas the identity map was still holding.
    expect(rasterizeTitle(first, SHORT_W, SHORT_H)).not.toBe(firstCanvas)
  })

  it('bounds MEMORY, not a number of entries', () => {
    // The old bound was a count of 32, which is 8 MB of small rasters and
    // 265 MB of Shorts-sized ones — the same number meaning two very different
    // things. Small rasters may now pile up far past 32 while staying cheap.
    for (let i = 0; i < 100; i++) rasterizeTitle(defFor(`small-${i}`), W, H)
    const smallBytes = titleCacheBytes()
    expect(smallBytes).toBeLessThanOrEqual(48 * 1024 * 1024)

    clearTitleCache()
    expect(titleCacheBytes()).toBe(0)

    for (let i = 0; i < 100; i++) rasterizeTitle(defFor(`big-${i}`), SHORT_W, SHORT_H)
    expect(titleCacheBytes()).toBeLessThanOrEqual(48 * 1024 * 1024)
  })

  it('keeps the raster it was just asked for, even if it alone busts the budget', () => {
    const huge = defFor('huge')
    const canvas = rasterizeTitle(huge, 8000, 8000) // 256 MB on its own
    expect(rasterizeTitle(huge, 8000, 8000)).toBe(canvas)
  })

  it('a def still inside the bound keeps its cached canvas', () => {
    const recent = defFor('recent')
    const canvas = rasterizeTitle(recent, W, H)
    for (let i = 0; i < 5; i++) rasterizeTitle(defFor(`other-${i}`), W, H)
    expect(rasterizeTitle(recent, W, H)).toBe(canvas)
  })
})
