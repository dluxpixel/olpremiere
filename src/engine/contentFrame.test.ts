// The picture frame inside the export frame, through every part that is pure.
//
// His ask, 2026-09-04, off a reel: a short is still exported at 9:16 and the
// footage sits in a square inside it. The tests that matter here are the ones
// about what must NOT change: an existing project has to resolve to byte-identical
// numbers, and the blurred backdrop has to stay full-frame or the bands the
// feature creates would be black exactly where the feature is supposed to show.

import { describe, expect, it } from 'vitest'
import { aspectLabel, contentBox, parseAspect } from './contentFrame'
import { computeQuad } from './render/mat'
import { resolveFrame } from './render/resolve'
import {
  activeSequence,
  defaultTitleDef,
  defaultTransform,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from './types'
import type { ResolvedTransform } from './render/types'

describe('contentBox', () => {
  it('centres a square inside a Short', () => {
    // 1080x1920 with a 1:1 inner frame: the square is as wide as the frame and
    // the bands split the leftover height evenly.
    expect(contentBox(1080, 1920, 1)).toEqual({ x: 0, y: 420, w: 1080, h: 1080 })
  })

  it('centres a wide strip inside a Short', () => {
    const box = contentBox(1080, 1920, 16 / 9)!
    expect(box.w).toBe(1080)
    expect(box.h).toBeCloseTo(607.5, 4)
    expect(box.x).toBe(0)
    expect(box.y).toBeCloseTo((1920 - 607.5) / 2, 4)
  })

  it('pillarboxes when the inner frame is taller than the outer one', () => {
    const box = contentBox(1920, 1080, 9 / 16)!
    expect(box.h).toBe(1080)
    expect(box.w).toBeCloseTo(607.5, 4)
    expect(box.y).toBe(0)
    expect(box.x).toBeCloseTo((1920 - 607.5) / 2, 4)
  })

  it('is null when there is no inner frame to speak of', () => {
    // ⛔ NULL IS THE WHOLE BACKWARD-COMPATIBILITY STORY. Null means the renderer
    // takes the path it has always taken, so a project made before this feature
    // is not merely close to identical, it goes through the same arithmetic.
    expect(contentBox(1080, 1920, undefined)).toBeNull()
    expect(contentBox(1080, 1920, 0)).toBeNull()
    expect(contentBox(1080, 1920, -2)).toBeNull()
    expect(contentBox(1080, 1920, Number.NaN)).toBeNull()
    expect(contentBox(0, 0, 1)).toBeNull()
  })

  it('is null when the inner frame is the outer frame typed a different way', () => {
    expect(contentBox(1920, 1080, 16 / 9)).toBeNull()
    expect(contentBox(1920, 1080, 1.7777)).toBeNull()
    expect(contentBox(1080, 1080, 1)).toBeNull()
  })

  it('never leaves the frame, whatever it is handed', () => {
    for (const aspect of [0.2, 0.5, 1, 1.85, 2.39, 7]) {
      const box = contentBox(1080, 1920, aspect)
      if (!box) continue
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(1080 + 1e-9)
      expect(box.y + box.h).toBeLessThanOrEqual(1920 + 1e-9)
      expect(box.w / box.h).toBeCloseTo(aspect, 6)
    }
  })
})

describe('parseAspect', () => {
  it('reads the shapes a person actually types', () => {
    expect(parseAspect('16:9')).toBeCloseTo(16 / 9, 9)
    expect(parseAspect('16/9')).toBeCloseTo(16 / 9, 9)
    expect(parseAspect('2.39:1')).toBeCloseTo(2.39, 9)
    expect(parseAspect(' 4 : 5 ')).toBeCloseTo(0.8, 9)
    expect(parseAspect('1.5')).toBeCloseTo(1.5, 9)
  })

  it('refuses the ones that are not ratios', () => {
    expect(parseAspect('')).toBeNull()
    expect(parseAspect('16:0')).toBeNull()
    expect(parseAspect('0:9')).toBeNull()
    expect(parseAspect('wide')).toBeNull()
    expect(parseAspect('-2')).toBeNull()
  })
})

describe('aspectLabel', () => {
  it('names the presets and falls back to a number', () => {
    expect(aspectLabel(1)).toBe('1:1 Square')
    expect(aspectLabel(16 / 9)).toBe('16:9 Wide')
    expect(aspectLabel(1.23)).toBe('1.23:1')
  })
})

// ---------------------------------------------------------------------------

const tf = (over: Partial<ResolvedTransform> = {}): ResolvedTransform => ({
  ...defaultTransform(),
  x: 0,
  y: 0,
  scale: 1,
  rotationDeg: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  cropT: 0,
  cropR: 0,
  cropB: 0,
  cropL: 0,
  ...over,
})

describe('computeQuad lays the picture out inside the box', () => {
  const src = { frameW: 1080, frameH: 1920, texW: 1920, texH: 1080 }

  it('fits 16:9 footage into a square and centres it', () => {
    const box = contentBox(1080, 1920, 1)!
    const { corners } = computeQuad({ ...src, transform: tf({ frame: box }) })
    const [tl, tr, , bl] = corners
    // Contain-fit of 16:9 into a 1080 square: full width, 607.5 tall.
    expect(tr[0] - tl[0]).toBeCloseTo(1080, 4)
    expect(bl[1] - tl[1]).toBeCloseTo(607.5, 4)
    // And centred on the SQUARE's centre (y 960), which is also the frame's.
    expect((tl[1] + bl[1]) / 2).toBeCloseTo(960, 4)
  })

  it('is byte-identical to the old path when there is no box', () => {
    // ⛔ THE REGRESSION THAT WOULD MATTER MOST. Every project he has ever made
    // goes through this branch.
    const withUndef = computeQuad({ ...src, transform: tf({ frame: undefined }) })
    const asBefore = computeQuad({ ...src, transform: tf() })
    expect(withUndef.corners).toEqual(asBefore.corners)
  })

  it('keeps the user offset relative to the box, not to the frame', () => {
    const box = contentBox(1080, 1920, 1)!
    const a = computeQuad({ ...src, transform: tf({ frame: box }) })
    const b = computeQuad({ ...src, transform: tf({ frame: box, x: 40, y: -25 }) })
    expect(b.corners[0][0] - a.corners[0][0]).toBeCloseTo(40, 6)
    expect(b.corners[0][1] - a.corners[0][1]).toBeCloseTo(-25, 6)
  })

  it('scales about the box centre, so a zoom stays centred in the square', () => {
    const box = contentBox(1080, 1920, 1)!
    const { corners } = computeQuad({ ...src, transform: tf({ frame: box, scale: 2 }) })
    const cx = (corners[0][0] + corners[2][0]) / 2
    const cy = (corners[0][1] + corners[2][1]) / 2
    expect(cx).toBeCloseTo(540, 4)
    expect(cy).toBeCloseTo(960, 4)
  })

  it('cover-fits against the box, not the frame', () => {
    const box = contentBox(1080, 1920, 1)!
    const { corners } = computeQuad({ ...src, transform: tf({ frame: box, fit: 'cover' }) })
    // Cover of 16:9 into a square: the HEIGHT is what runs out, so the picture
    // is a full 1080 tall and wider than the box (the shader clips the spill).
    expect(corners[3][1] - corners[0][1]).toBeCloseTo(1080, 4)
    expect(corners[1][0] - corners[0][0]).toBeGreaterThan(1080)
  })
})

// ---------------------------------------------------------------------------

function seqWith(clips: Clip[], contentAspect?: number): Sequence {
  const seq = activeSequence(newProject())
  return {
    ...seq,
    width: 1080,
    height: 1920,
    durationS: 10,
    ...(contentAspect === undefined ? {} : { contentAspect }),
    tracks: seq.tracks.map((t, i) => (i === 0 ? { ...t, clips } : t)),
  }
}

const videoClip = (): Clip => ({ ...newTitleClip(defaultTitleDef('x'), 0, 5), title: undefined, assetId: 'a1' })

describe('the resolver stamps the box, once', () => {
  it('gives a picture layer the box', () => {
    const ops = resolveFrame(seqWith([videoClip()], 1), 1).ops
    expect(ops).toHaveLength(1)
    const op = ops[0]
    if (op.type !== 'layer') throw new Error('expected a layer op')
    expect(op.layer.transform.frame).toEqual({ x: 0, y: 420, w: 1080, h: 1080 })
  })

  it('leaves a sequence without an inner frame completely untouched', () => {
    const ops = resolveFrame(seqWith([videoClip()]), 1).ops
    const op = ops[0]
    if (op.type !== 'layer') throw new Error('expected a layer op')
    expect(op.layer.transform.frame).toBeUndefined()
  })

  it('leaves TITLES on the full frame', () => {
    // ⛔ DELIBERATE, AND IT IS HALF OF WHY ANYONE USES THIS LOOK. A title is
    // rasterized at the sequence size and drawn as a full-frame quad, so
    // squeezing that quad into the box would shrink the type instead of laying
    // it out inside. Leaving it alone is also what lets him put a caption in the
    // band above or below the square.
    const ops = resolveFrame(seqWith([newTitleClip(defaultTitleDef('HI'), 0, 5)], 1), 1).ops
    const op = ops[0]
    if (op.type !== 'layer') throw new Error('expected a layer op')
    expect(op.layer.transform.frame).toBeUndefined()
  })

  it('⛔ never gives the blurred backdrop a box', () => {
    // The backdrop is the thing that FILLS the bands the content box creates.
    // Confined to the box it would leave them black, which is the feature
    // looking broken in exactly the place it is supposed to show.
    const seq = { ...seqWith([videoClip()], 1), blurBackground: true }
    const ops = resolveFrame(seq, 1).ops
    expect(ops).toHaveLength(2)
    const backdrop = ops[0]
    const picture = ops[1]
    if (backdrop.type !== 'layer' || picture.type !== 'layer') throw new Error('expected layer ops')
    expect(backdrop.layer.effects[0].type).toBe('gaussianBlur')
    expect(backdrop.layer.transform.frame).toBeUndefined()
    expect(backdrop.layer.transform.fit).toBe('cover')
    // ...and the picture in front of it still got one.
    expect(picture.layer.transform.frame).not.toBeUndefined()
  })

  it('stamps the motion-blur sample too, or the smear pulls out of the box', () => {
    const clip: Clip = {
      ...videoClip(),
      keyframes: {
        scale: [
          { t: 0, value: 1, ease: 'linear' as const },
          { t: 4, value: 2, ease: 'linear' as const },
        ],
      },
    }
    const seq = { ...seqWith([clip], 1), shutterAngle: 180 }
    const ops = resolveFrame(seq, 1).ops
    const op = ops[0]
    if (op.type !== 'layer') throw new Error('expected a layer op')
    expect(op.layer.transformAtShutter).toBeDefined()
    expect(op.layer.transformAtShutter!.frame).toEqual(op.layer.transform.frame)
  })
})
