import { describe, expect, it } from 'vitest'
import { fitCanvasBox } from './monitorSizing'

const ASPECT_16_9 = 16 / 9

describe('fitCanvasBox', () => {
  it('fits width-constrained and lands on integers at dpr 1', () => {
    // 16:9 in a tall parent: width binds.
    const box = fitCanvasBox(800, 1000, ASPECT_16_9, 1, 1)
    expect(box.cssW).toBe(800)
    expect(box.cssH).toBe(450)
    expect(box.pxW).toBe(800)
    expect(box.pxH).toBe(450)
  })

  it('fits height-constrained without overflowing the parent', () => {
    const box = fitCanvasBox(1000, 400, ASPECT_16_9, 1, 1)
    expect(box.cssH).toBe(400)
    expect(box.cssW).toBeLessThanOrEqual(1000)
    // 400 * 16/9 = 711.11 -> floored to 711 whole device px.
    expect(box.cssW).toBe(711)
  })

  it('snaps the CSS box to whole device pixels at fractional dpr', () => {
    const dpr = 1.25
    const box = fitCanvasBox(777, 543, ASPECT_16_9, dpr, 1)
    // The invariant under test: cssW*dpr and cssH*dpr are integers, so the
    // element spans a whole number of device pixels and is never resampled.
    expect(box.cssW * dpr).toBeCloseTo(Math.round(box.cssW * dpr), 9)
    expect(box.cssH * dpr).toBeCloseTo(Math.round(box.cssH * dpr), 9)
    // And the box still fits.
    expect(box.cssW).toBeLessThanOrEqual(777)
    expect(box.cssH).toBeLessThanOrEqual(543)
  })

  it('matches the backing store to the device-pixel extent at quality 1', () => {
    const dpr = 2
    const box = fitCanvasBox(963.4, 507.7, ASPECT_16_9, dpr, 1)
    expect(box.pxW).toBe(Math.round(box.cssW * dpr))
    expect(box.pxH).toBe(Math.round(box.cssH * dpr))
  })

  it('scales only the raster down at reduced quality, keeping the CSS box', () => {
    const full = fitCanvasBox(800, 1000, ASPECT_16_9, 1, 1)
    const half = fitCanvasBox(800, 1000, ASPECT_16_9, 1, 0.5)
    expect(half.cssW).toBe(full.cssW)
    expect(half.cssH).toBe(full.cssH)
    expect(half.pxW).toBe(400)
    expect(half.pxH).toBe(225)
  })

  it('preserves aspect within one device pixel', () => {
    const box = fitCanvasBox(1234, 567, ASPECT_16_9, 1.5, 1)
    const devW = box.cssW * 1.5
    const devH = box.cssH * 1.5
    // Independent flooring may cost < 1 device px per axis.
    expect(Math.abs(devW - devH * ASPECT_16_9)).toBeLessThan(2)
  })

  it('never returns a raster below 1x1', () => {
    const box = fitCanvasBox(0, 0, ASPECT_16_9, 1, 0.25)
    expect(box.pxW).toBeGreaterThanOrEqual(1)
    expect(box.pxH).toBeGreaterThanOrEqual(1)
  })

  it('degrades safely on degenerate aspect and dpr', () => {
    const box = fitCanvasBox(100, 100, NaN, 0, 1)
    expect(Number.isFinite(box.cssW)).toBe(true)
    expect(Number.isFinite(box.pxH)).toBe(true)
    expect(box.pxW).toBeGreaterThanOrEqual(1)
  })
})
