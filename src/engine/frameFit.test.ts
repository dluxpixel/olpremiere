import { describe, expect, it } from 'vitest'
import { computeQuad } from './render/mat'
import { resolveFrame } from './render/resolve'
import { fillScale, frameFitDims, frameFitOf, withFrameFit, type FrameFitDims } from './frameFit'
import { defaultTitleDef, defaultTransform, type Clip, type Keyframe, type MediaAsset, type Sequence } from './types'

// His ask, 2026-09-29: "make it so when i for example paste in a 4:3clip it
// stretches to 16:9 when i select to". These pin the choice itself: what each of
// the three does to a clip, that a zoom he made rides along, and that the
// renderer then puts the picture's corners on the frame's corners.

const kf = (t: number, value: number): Keyframe => ({ t, value, ease: 'linear' })

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c',
  assetId: 'a',
  startS: 0,
  inS: 0,
  outS: 4,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...over,
})

// A 4:3 clip in his 16:9 project.
const FOUR_THREE_IN_WIDE: FrameFitDims = { srcW: 640, srcH: 480, boxW: 1920, boxH: 1080, seqW: 1920, seqH: 1080 }
// Covering 16:9 with 4:3 grows the fitted 1440x1080 to 1920 wide: 4/3.
const FILL = 4 / 3
// What a pasted 4:3 clip lands as today: filling the frame (fitNewClipToFrame).
const pasted = (): Clip => clip({ transform: { ...defaultTransform(), scale: FILL } })

describe('fillScale is the fill a new clip already lands with', () => {
  it('is cover over contain, 4/3 for a 4:3 picture in 16:9', () => {
    expect(fillScale(FOUR_THREE_IN_WIDE)).toBeCloseTo(FILL, 12)
  })
  it('is 1 when the shapes agree, and 1 when the size is not known yet', () => {
    expect(fillScale({ srcW: 1920, srcH: 1080, boxW: 1920, boxH: 1080 })).toBe(1)
    expect(fillScale({ srcW: 0, srcH: 0, boxW: 1920, boxH: 1080 })).toBe(1)
  })
})

describe('which of the three a clip shows', () => {
  it('reads fit and fill off the scale, because that is where they have always lived', () => {
    expect(frameFitOf(pasted(), FOUR_THREE_IN_WIDE)).toBe('fill')
    expect(frameFitOf(clip(), FOUR_THREE_IN_WIDE)).toBe('fit')
    expect(frameFitOf(clip({ transform: { ...defaultTransform(), scale: 0.5 } }), FOUR_THREE_IN_WIDE)).toBeNull()
  })
  it('reads a punch in by where it rests, its lowest keyframe', () => {
    const punch = pasted()
    punch.keyframes = { scale: [kf(0, FILL), kf(1, FILL * 1.2)] }
    expect(frameFitOf(punch, FOUR_THREE_IN_WIDE)).toBe('fill')
  })
  it('says stretch for a stretched clip', () => {
    expect(frameFitOf(clip({ transform: { ...defaultTransform(), fit: 'stretch' } }), FOUR_THREE_IN_WIDE)).toBe('stretch')
  })
  it('has no answer for a title or an adjustment layer: neither is a picture of a shape', () => {
    expect(frameFitOf(clip({ title: defaultTitleDef(), assetId: '' }), FOUR_THREE_IN_WIDE)).toBeNull()
    expect(frameFitOf(clip({ adjustment: true }), FOUR_THREE_IN_WIDE)).toBeNull()
  })
})

describe('picking one', () => {
  it('Stretch to fill: the pasted 4:3 clip goes from filled to stretched at its resting size', () => {
    const out = withFrameFit(pasted(), 'stretch', FOUR_THREE_IN_WIDE)
    expect(out.transform.fit).toBe('stretch')
    expect(out.transform.scale).toBe(1)
    // And the renderer, handed that clip, puts its corners on the frame's corners.
    const layer = resolveFrame(seqWith(out), 1).ops[0]
    if (layer?.type !== 'layer') throw new Error('expected one layer')
    const { corners } = computeQuad({ frameW: 1920, frameH: 1080, texW: 640, texH: 480, transform: layer.layer.transform })
    const want = [[0, 0], [1920, 0], [1920, 1080], [0, 1080]]
    corners.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(want[i][0], 9)
      expect(y).toBeCloseTo(want[i][1], 9)
    })
  })

  it('and Fill and crop takes it straight back to what it was, the same object shape', () => {
    const back = withFrameFit(withFrameFit(pasted(), 'stretch', FOUR_THREE_IN_WIDE), 'fill', FOUR_THREE_IN_WIDE)
    expect(back).toEqual(pasted())
    // The key is gone, not left behind as undefined, so the saved file is the old one.
    expect('fit' in back.transform).toBe(false)
  })

  it('Fit inside shows the whole picture: scale 1, nothing stretched', () => {
    const out = withFrameFit(pasted(), 'fit', FOUR_THREE_IN_WIDE)
    expect(out.transform.scale).toBe(1)
    expect('fit' in out.transform).toBe(false)
  })

  it('picking what it already shows changes nothing, so it costs no undo step', () => {
    const p = pasted()
    expect(withFrameFit(p, 'fill', FOUR_THREE_IN_WIDE)).toBe(p)
    const s = withFrameFit(p, 'stretch', FOUR_THREE_IN_WIDE)
    expect(withFrameFit(s, 'stretch', FOUR_THREE_IN_WIDE)).toBe(s)
    // A 16:9 clip in 16:9: fit and fill are the same picture, so neither is an edit.
    const wide: FrameFitDims = { ...FOUR_THREE_IN_WIDE, srcW: 1920, srcH: 1080 }
    const same = clip()
    expect(withFrameFit(same, 'fit', wide)).toBe(same)
    expect(withFrameFit(same, 'fill', wide)).toBe(same)
  })

  it('leaves position, rotation, anchor and crop exactly as he set them', () => {
    const placed = clip({
      transform: { x: 120, y: -40, scale: FILL, rotationDeg: 7, anchorX: 0.3, anchorY: 0.6, crop: { t: 0.1, r: 0, b: 0.05, l: 0.2 } },
    })
    const out = withFrameFit(placed, 'stretch', FOUR_THREE_IN_WIDE)
    expect(out.transform).toEqual({ ...placed.transform, scale: 1, fit: 'stretch' })
  })

  it('a punch in keeps its shape, measured from the new rest', () => {
    // A 20% punch on the filled clip is a 20% punch on the stretched one.
    const punch = pasted()
    punch.keyframes = { scale: [kf(0, FILL), kf(1, FILL * 1.2), kf(2, FILL)], posX: [kf(0, 0), kf(2, 50)] }
    const out = withFrameFit(punch, 'stretch', FOUR_THREE_IN_WIDE)
    expect(out.keyframes!.scale!.map((k) => k.value)).toEqual([1, expect.closeTo(1.2, 12), 1])
    // Every other channel he animated is the very same list.
    expect(out.keyframes!.posX).toBe(punch.keyframes.posX)
    expect(out.keyframes!.scale!.map((k) => k.t)).toEqual([0, 1, 2])
  })

  it('a zoom that passes through 0 has no rest to measure from, and is left as he drew it', () => {
    const grow = clip({ keyframes: { scale: [kf(0, 0), kf(1, 1)] } })
    const out = withFrameFit(grow, 'stretch', FOUR_THREE_IN_WIDE)
    expect(out.transform.fit).toBe('stretch')
    expect(out.keyframes!.scale).toBe(grow.keyframes!.scale)
  })

  it('a title or an adjustment layer comes back untouched', () => {
    const title = clip({ title: defaultTitleDef(), assetId: '' })
    const adj = clip({ adjustment: true })
    expect(withFrameFit(title, 'stretch', FOUR_THREE_IN_WIDE)).toBe(title)
    expect(withFrameFit(adj, 'stretch', FOUR_THREE_IN_WIDE)).toBe(adj)
  })

  it('a 4:3 clip in a 9:16 short stretches tall the same way', () => {
    const tall: FrameFitDims = { srcW: 640, srcH: 480, boxW: 1080, boxH: 1920, seqW: 1080, seqH: 1920 }
    // It landed filled: 1080x1920 covered by a 4:3 picture is 2.37x the fit.
    const filled = clip({ transform: { ...defaultTransform(), scale: fillScale(tall) } })
    expect(frameFitOf(filled, tall)).toBe('fill')
    const out = withFrameFit(filled, 'stretch', tall)
    const { corners } = computeQuad({
      frameW: 1080, frameH: 1920, texW: 640, texH: 480,
      transform: { x: 0, y: 0, scale: out.transform.scale, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5, cropT: 0, cropR: 0, cropB: 0, cropL: 0, fit: 'stretch' },
    })
    expect(corners.map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([[0, 0], [1080, 0], [1080, 1920], [0, 1920]])
  })
})

describe('the sizes come from the box the renderer lays the clip out in', () => {
  const asset = { id: 'a', width: 640, height: 480 } as MediaAsset
  it('the whole frame, normally', () => {
    expect(frameFitDims(seqWith(clip()), asset)).toEqual(FOUR_THREE_IN_WIDE)
  })
  it('the inner content box when the sequence has one', () => {
    const square = { ...seqWith(clip()), width: 1080, height: 1920, contentAspect: 1 }
    expect(frameFitDims(square, asset)).toMatchObject({ boxW: 1080, boxH: 1080, seqW: 1080, seqH: 1920 })
  })
  it('a missing picture has no size, so fill stays at 1 rather than a guess', () => {
    const d = frameFitDims(seqWith(clip()), undefined)
    expect(d.srcW).toBe(0)
    expect(fillScale(d)).toBe(1)
  })
})

function seqWith(c: Clip): Sequence {
  return {
    id: 's',
    name: 'S',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 4,
    markers: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', height: 64, muted: false, solo: false, locked: false, volumeDb: 0, pan: 0, clips: [c] },
    ],
  }
}
