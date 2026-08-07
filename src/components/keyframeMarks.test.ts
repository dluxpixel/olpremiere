import { describe, expect, it } from 'vitest'
import { diamondColor, dragTargetT, friendly, segmentIndexAt } from './keyframeMarks'
import type { Keyframe } from '../engine/types'

const kf = (t: number, value: number): Keyframe => ({ t, value, ease: 'linear' })

// The punch he actually fires: 100 to 120 over 5 frames at 30fps, then a hold.
const PUNCH: Keyframe[] = [kf(1, 1), kf(1 + 5 / 30, 1.2), kf(4, 1.2)]

describe('dragTargetT', () => {
  it('carries a diamond by the zoom the press landed on', () => {
    // 240 px/s: 24 px right is a tenth of a second, however long the clip is.
    expect(dragTargetT(1, 24, 240)).toBeCloseTo(1.1, 9)
    expect(dragTargetT(1, -24, 240)).toBeCloseTo(0.9, 9)
    // Zoomed in ten times, the same 24 px is a tenth of the distance.
    expect(dragTargetT(1, 24, 2400)).toBeCloseTo(1.01, 9)
  })

  it('holds still rather than flying off on an unmeasured rail', () => {
    expect(dragTargetT(1, 24, 0)).toBe(1)
  })
})

describe('segmentIndexAt', () => {
  it('names a segment by the keyframe it leaves', () => {
    expect(segmentIndexAt(PUNCH, 1.1)).toBe(0)
    expect(segmentIndexAt(PUNCH, 2)).toBe(1)
  })

  it('has nothing to shape before the first diamond or after the last', () => {
    expect(segmentIndexAt(PUNCH, 0.5)).toBe(-1)
    expect(segmentIndexAt(PUNCH, 9)).toBe(-1)
    expect(segmentIndexAt([kf(1, 1)], 1)).toBe(-1)
    expect(segmentIndexAt([], 0)).toBe(-1)
  })

  it('counts the ends of a segment as part of it', () => {
    expect(segmentIndexAt(PUNCH, 1)).toBe(0)
    expect(segmentIndexAt(PUNCH, 4)).toBe(1)
  })
})

describe('diamondColor', () => {
  it('reads a zoom in as amber and a zoom out as blue', () => {
    const kfs = [kf(0, 1), kf(1, 1.2), kf(2, 1)]
    expect(diamondColor('scale', kfs, 1, false)).toBe('var(--color-ember)')
    expect(diamondColor('scale', kfs, 2, false)).toBe('var(--color-clip-video-bd)')
  })

  it('leaves the first diamond and a flat hold neutral', () => {
    const kfs = [kf(0, 1.2), kf(1, 1.2)]
    expect(diamondColor('scale', kfs, 0, false)).toBe('var(--color-text-secondary)')
    expect(diamondColor('scale', kfs, 1, false)).toBe('var(--color-text-secondary)')
  })

  it('colours only the Zoom lane', () => {
    const kfs = [kf(0, 0), kf(1, 40)]
    expect(diamondColor('posX', kfs, 1, false)).toBe('var(--color-text-secondary)')
  })

  it('lets the selection win over the zoom tell', () => {
    const kfs = [kf(0, 1), kf(1, 1.2)]
    expect(diamondColor('scale', kfs, 1, true)).toBe('var(--color-accent)')
  })
})

describe('friendly', () => {
  it('calls scale what he calls it', () => {
    expect(friendly('scale')).toBe('Zoom')
    expect(friendly('posX')).toBe('Position X')
  })
})
