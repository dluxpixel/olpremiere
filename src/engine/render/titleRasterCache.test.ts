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

const { clearTitleCache, rasterizeTitle } = await import('./titleRaster')

const W = 320
const H = 180
const defFor = (text: string): TitleDef => ({ ...defaultTitleDef(text) })

describe('title raster cache', () => {
  beforeEach(() => clearTitleCache())

  it('returns the SAME canvas for the same def object (the per-frame fast path)', () => {
    const def = defFor('hello')
    expect(rasterizeTitle(def, W, H)).toBe(rasterizeTitle(def, W, H))
  })

  it('evicting from the bounded list also releases the identity entry', () => {
    // The identity WeakMap is keyed by the STORE's own TitleDef objects, which
    // live as long as the project — so an entry left behind after eviction pins
    // its canvas forever. A word-caption timeline is one title clip per word,
    // which is how a 60s caption pass used to retain ~1.2 GB of canvases.
    const first = defFor('word-0')
    const firstCanvas = rasterizeTitle(first, W, H)

    // Push strictly more than CACHE_LIMIT (32) distinct defs through.
    for (let i = 1; i <= 40; i++) rasterizeTitle(defFor(`word-${i}`), W, H)

    // `first` was evicted, so it must RE-RASTERIZE rather than hand back the
    // canvas the identity map was still holding.
    expect(rasterizeTitle(first, W, H)).not.toBe(firstCanvas)
  })

  it('a def still inside the bound keeps its cached canvas', () => {
    const recent = defFor('recent')
    const canvas = rasterizeTitle(recent, W, H)
    for (let i = 0; i < 5; i++) rasterizeTitle(defFor(`other-${i}`), W, H)
    expect(rasterizeTitle(recent, W, H)).toBe(canvas)
  })
})
