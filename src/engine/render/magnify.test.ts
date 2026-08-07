import { describe, expect, it } from 'vitest'
import { isHdRaster } from '../export/messages'
import { BICUBIC_MIN_SCALE, bicubicLayer } from './glRenderer'
import { computeQuad, cropUV, quadScale } from './mat'
import { defaultTransform } from '../types'
import type { ResolvedTransform } from './types'

const tf = (over: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
  ...defaultTransform(),
  cropT: 0,
  cropR: 0,
  cropB: 0,
  cropL: 0,
  ...over,
})

/** The scale the renderer would compute for this layer, via the real quad maths. */
function scaleOf(frameW: number, frameH: number, texW: number, texH: number, transform = tf()): number {
  const { corners } = computeQuad({ frameW, frameH, texW, texH, transform })
  const uv = cropUV(transform.cropT, transform.cropR, transform.cropB, transform.cropL)
  return quadScale(corners, uv, texW, texH)
}

/** The extra user scale a COVER fit needs on top of the renderer's contain fit. */
const coverScale = (texW: number, texH: number, frameW: number, frameH: number): number =>
  Math.max(frameW / texW, frameH / texH) / Math.min(frameW / texW, frameH / texH)

// The layer shader magnifies with a clamped Catmull-Rom instead of plain
// bilinear, and this is the arithmetic that decides which layers get it. It has
// to be exact at 1.0 in particular: gl.TEXTURE_MAG_FILTER = gl.LINEAR is the
// byte-stable path every golden export was recorded on, and a scale that came
// back as 1.0000001 would quietly move those bytes.
describe('quadScale: destination pixels per source texel', () => {
  it('is EXACTLY 1 when a clip fills a frame of its own size', () => {
    expect(scaleOf(1920, 1080, 1920, 1080)).toBe(1)
  })

  it('is exactly 1 for the golden SD raster too', () => {
    expect(scaleOf(640, 360, 640, 360)).toBe(1)
  })

  it('reports the cover magnification for his vertical short, 1920x1080 into 1080x1920', () => {
    const s = scaleOf(1080, 1920, 1920, 1080, tf({ scale: coverScale(1920, 1080, 1080, 1920) }))
    // 1920/1080: the frame is 1.7778x the height of the fitted footage.
    expect(s).toBeCloseTo(16 / 9, 10)
  })

  it('reports MINIFICATION when 4K footage is cut into the same vertical short', () => {
    const s = scaleOf(1080, 1920, 3840, 2160, tf({ scale: coverScale(3840, 2160, 1080, 1920) }))
    expect(s).toBeCloseTo(8 / 9, 10)
    expect(s).toBeLessThan(1)
  })

  it('is unchanged by rotation: an edge LENGTH is the size it covers', () => {
    const straight = scaleOf(1080, 1920, 1920, 1080, tf({ scale: 2 }))
    const turned = scaleOf(1080, 1920, 1920, 1080, tf({ scale: 2, rotationDeg: 37 }))
    expect(turned).toBeCloseTo(straight, 10)
  })

  it('divides by the CROPPED texel span, not the whole texture', () => {
    // A 100px quad over the middle HALF of a 200-texel source is 100 destination
    // pixels for 100 texels, which is 1:1. Dividing by the full 200 would call it
    // 0.5 and quietly leave a magnified crop on the soft path.
    const corners: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]
    expect(quadScale(corners, { u0: 0.25, v0: 0.25, u1: 0.75, v1: 0.75 }, 200, 200)).toBe(1)
  })

  it('reads a crop-in as the magnification it really is', () => {
    // The renderer CONTAIN-fits, so cropping 25% off each side re-fits 960
    // surviving columns across the frame's full 1080. Those columns really are
    // being enlarged, so 1.125 is the honest answer and the bicubic path is the
    // right one for it.
    const full = scaleOf(1080, 1920, 1920, 1080)
    const cropped = scaleOf(1080, 1920, 1920, 1080, tf({ cropL: 0.25, cropR: 0.25 }))
    expect(full).toBeCloseTo(0.5625, 10)
    expect(cropped).toBeCloseTo(1.125, 10)
    expect(bicubicLayer(full, 1080, 1920)).toBe(false)
    expect(bicubicLayer(cropped, 1080, 1920)).toBe(true)
  })

  it('is 0 for a degenerate source rather than dividing by zero', () => {
    const corners: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]
    expect(quadScale(corners, cropUV(0, 0, 0, 0), 0, 0)).toBe(0)
    expect(quadScale(corners, { u0: 0.5, v0: 0, u1: 0.5, v1: 1 }, 1920, 1080)).toBe(0)
  })

  it('is 0 for an empty corner list rather than throwing', () => {
    expect(quadScale([], cropUV(0, 0, 0, 0), 1920, 1080)).toBe(0)
  })
})

// Two gates, and the second one is a fence around the golden export. The bicubic
// path is a different resampler, so a layer that reaches it produces different
// bytes by design; sub-HD must never reach it, exactly as with the dither.
describe('bicubicLayer: only magnified layers, and only above SD', () => {
  const HIS_SHORT = 16 / 9

  it('takes the bicubic path for his 1.78x vertical short', () => {
    expect(bicubicLayer(HIS_SHORT, 1080, 1920)).toBe(true)
  })

  it('leaves the identity case on the byte-stable LINEAR path', () => {
    expect(bicubicLayer(1, 1920, 1080)).toBe(false)
  })

  it('leaves MINIFICATION alone: that is the mipmap path, not this one', () => {
    expect(bicubicLayer(8 / 9, 1080, 1920)).toBe(false)
    expect(bicubicLayer(0.25, 3840, 2160)).toBe(false)
  })

  it('never fires below HD, however hard the layer is magnified', () => {
    expect(bicubicLayer(4, 640, 360)).toBe(false)
    expect(bicubicLayer(1000, 854, 480)).toBe(false)
  })

  it('uses the same HD fence the export path draws, so the two cannot drift', () => {
    const rasters: [number, number][] = [
      [640, 360],
      [854, 480],
      [1280, 720],
      [1920, 1080],
      [1080, 1920],
      [720, 1280],
      [3840, 2160],
      [1279, 719],
    ]
    for (const [w, h] of rasters) expect(bicubicLayer(HIS_SHORT, w, h)).toBe(isHdRaster(w, h))
  })

  it('holds a hair above 1.0, so a zoom hovering at 1:1 cannot flicker between filters', () => {
    expect(BICUBIC_MIN_SCALE).toBeGreaterThan(1)
    expect(bicubicLayer(BICUBIC_MIN_SCALE, 1080, 1920)).toBe(false)
    expect(bicubicLayer(BICUBIC_MIN_SCALE + 1e-6, 1080, 1920)).toBe(true)
    // Still small enough that his real magnification is nowhere near it.
    expect(BICUBIC_MIN_SCALE).toBeLessThan(1.01)
  })

  it('rejects a degenerate scale instead of magnifying nothing', () => {
    expect(bicubicLayer(0, 1080, 1920)).toBe(false)
  })
})
