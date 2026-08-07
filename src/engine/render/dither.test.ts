import { describe, expect, it } from 'vitest'
import { isHdRaster } from '../export/messages'
import { ditherRaster, frameSeedOf } from './glRenderer'
import { defaultTransform } from '../types'
import type { RenderLayer, RenderOp } from './types'

const transform = { ...defaultTransform(), cropT: 0, cropR: 0, cropB: 0, cropL: 0 }

const layer = (frameSeed: number): RenderLayer => ({
  clipId: 'c1',
  assetId: 'a1',
  sourceTimeS: 0,
  isImage: true,
  speed: 1,
  frameSeed,
  transform,
  opacity: 1,
  blendMode: 'normal',
  effects: [],
})

// The renderer decides the dither per FRAME instead of taking a flag, because
// the preview keeps one renderer per canvas across sequence-format changes. That
// means the gate is written out twice: here and in export/messages.ts. This is
// the fence that stops the two drifting, which matters because a drift downward
// would move the golden 640x360 export's bytes.
describe('the dither gate is the same gate the export path uses', () => {
  const rasters: [number, number][] = [
    [640, 360],
    [854, 480],
    [1280, 720],
    [1920, 1080],
    [1080, 1920],
    [720, 1280],
    [2560, 1440],
    [3840, 2160],
    [1279, 719],
  ]

  it.each(rasters)('agrees with isHdRaster at %ix%i', (w, h) => {
    expect(ditherRaster(w, h)).toBe(isHdRaster(w, h))
  })

  it('leaves the golden SD raster on the untouched legacy path', () => {
    expect(ditherRaster(640, 360)).toBe(false)
  })

  it('covers the raster he actually ships, a 1080x1920 vertical short', () => {
    expect(ditherRaster(1080, 1920)).toBe(true)
  })
})

// The dither is seeded from the resolver frame index so a re-render of the same
// timecode produces the same noise. If this ever returned something that varied
// per call, a paused preview would crawl and preview would stop matching export.
describe('frameSeedOf reads the frame index off whatever op leads the frame', () => {
  it('reads a layer op', () => {
    expect(frameSeedOf([{ type: 'layer', layer: layer(42) }])).toBe(42)
  })

  it('reads a transition op from its outgoing side', () => {
    const ops: RenderOp[] = [{ type: 'transition', kind: 'crossDissolve', progress: 0.5, from: layer(7), to: layer(7) }]
    expect(frameSeedOf(ops)).toBe(7)
  })

  it('reads an adjustment op', () => {
    const ops: RenderOp[] = [{ type: 'adjustment', effects: [], opacity: 1, frameSeed: 13 }]
    expect(frameSeedOf(ops)).toBe(13)
  })

  it('is 0 for an empty frame rather than throwing', () => {
    expect(frameSeedOf([])).toBe(0)
  })

  it('is a pure function of the ops: two calls agree', () => {
    const ops: RenderOp[] = [{ type: 'layer', layer: layer(99) }]
    expect(frameSeedOf(ops)).toBe(frameSeedOf(ops))
  })
})
