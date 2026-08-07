import { describe, expect, it } from 'vitest'

import { defaultTransform, type Clip, type Keyframe } from '../engine/types'
import {
  BADGE_TITLE,
  MAX_PATH_SAMPLES,
  motionBadgeState,
  motionPathDots,
  normalizedAnchor,
  previousMomentT,
  zoomReadout,
} from './MonitorTransformOverlay'

const kf = (t: number, value: number): Keyframe => ({ t, value, ease: 'linear' })

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c',
  assetId: 'a',
  startS: 0,
  inS: 0,
  outS: 20,
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

describe('motionBadgeState', () => {
  it('is hollow and OFF on a clip that animates nothing', () => {
    expect(motionBadgeState(clip(), 2, 30)).toBe('off')
  })

  it('is hollow and BETWEEN when the clip is armed and the playhead is off every moment', () => {
    const c = clip({ keyframes: { scale: [kf(0, 1), kf(1, 1.2)] } })
    expect(motionBadgeState(c, 2, 30)).toBe('between')
  })

  it('is filled ON a moment, within one frame either side', () => {
    const c = clip({ keyframes: { scale: [kf(0, 1), kf(1, 1.2)] } })
    expect(motionBadgeState(c, 1, 30)).toBe('on')
    expect(motionBadgeState(c, 1 + 1 / 30 - 1e-6, 30)).toBe('on')
    // Two frames away is the neighbouring moment's business, not this one's.
    expect(motionBadgeState(c, 1 + 2 / 30, 30)).toBe('between')
  })

  it('is DEAD on a clip carrying an appearance preset, whatever its keyframes say', () => {
    // The preset recompiles its own keyframes on any transform edit, so a curve
    // shaped by hand here would vanish at the next recompile.
    const c = clip({
      keyframes: { scale: [kf(0, 1), kf(1, 1.2)] },
      appearance: { in: 'pop', durS: 0.4 },
    })
    expect(motionBadgeState(c, 1, 30)).toBe('owned')
    expect(motionBadgeState(c, 2, 30)).toBe('owned')
    expect(BADGE_TITLE.owned).toBe('This clip uses an entrance animation, which owns its keyframes.')
  })
})

describe('previousMomentT', () => {
  it('is the head of the clip when it carries no moments', () => {
    expect(previousMomentT(clip(), 4)).toBe(0)
  })

  it('is the last moment STRICTLY before the playhead, not one at it', () => {
    const c = clip({ keyframes: { scale: [kf(0, 1), kf(3.5, 1.2), kf(4, 1.4)] } })
    expect(previousMomentT(c, 4)).toBe(3.5)
    expect(previousMomentT(c, 3.5)).toBe(0)
  })
})

describe('zoomReadout', () => {
  it('names the move in whole percent', () => {
    expect(zoomReadout(1, 1.18)).toBe('Zoom 100 to 118%')
    expect(zoomReadout(1.2, 1)).toBe('Zoom 120 to 100%')
  })
})

describe('motionPathDots', () => {
  it('is empty when nothing animates position', () => {
    expect(motionPathDots(clip({ keyframes: { scale: [kf(0, 1), kf(1, 1.2)] } }), 30, false)).toEqual([])
  })

  it('samples between the first and last position keyframe, ends included', () => {
    const c = clip({ keyframes: { posX: [kf(1, 0), kf(2, 100)] } })
    const dots = motionPathDots(c, 30, false)
    expect(dots).toHaveLength(31)
    expect(dots[0].x).toBeCloseTo(0, 6)
    expect(dots[dots.length - 1].x).toBeCloseTo(100, 6)
    // posY is static, so the path is a straight horizontal run at its base.
    expect(dots.every((d) => d.y === 0)).toBe(true)
  })

  it('caps a long move at 120 dots', () => {
    const c = clip({ keyframes: { posX: [kf(0, 0), kf(19, 400)] } })
    expect(motionPathDots(c, 60, false)).toHaveLength(MAX_PATH_SAMPLES)
  })

  it('is NEVER sampled while the transport runs', () => {
    const c = clip({ keyframes: { posX: [kf(0, 0), kf(19, 400)] } })
    expect(motionPathDots(c, 60, true)).toEqual([])
  })
})

describe('normalizedAnchor', () => {
  it('turns a clicked sequence point into normalized frame coords', () => {
    expect(normalizedAnchor(960, 432, 1920, 1080)).toEqual({ x: 0.5, y: 0.4 })
  })

  it('clamps a click on the black bars back into the frame', () => {
    expect(normalizedAnchor(-40, 2000, 1920, 1080)).toEqual({ x: 0, y: 1 })
  })
})
