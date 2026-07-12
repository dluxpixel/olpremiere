import { describe, expect, it } from 'vitest'
import { newTitleClip, defaultTitleDef, type Clip } from '../types'
import { evalChannel } from '../keyframes'
import { resolveChannel } from '../effects/channels'
import {
  APPEARANCE_CHANNELS,
  applyAppearanceToClip,
  buildAppearanceKeyframes,
  ENTRANCE_PRESETS,
  EXIT_PRESETS,
  isEmptyAppearance,
  isEntranceId,
  isExitId,
} from './appearance'

const W = 1920
const H = 1080

/** Every keyframe list an appearance emits must be strictly time-ordered. */
function assertSortedUnique(kfs: { t: number }[]): void {
  for (let i = 1; i < kfs.length; i++) {
    expect(kfs[i].t).toBeGreaterThan(kfs[i - 1].t)
  }
}

describe('appearance presets', () => {
  it('exposes stable ids for every preset', () => {
    expect(ENTRANCE_PRESETS.map((p) => p.id)).toEqual([
      'fadeIn',
      'pop',
      'slideIn',
      'zoomIn',
      'riseUp',
      'spinIn',
      'bounce',
    ])
    expect(EXIT_PRESETS.map((p) => p.id)).toEqual([
      'fadeOut',
      'popOut',
      'slideOut',
      'zoomOut',
      'dropDown',
      'spinOut',
    ])
  })

  it('an entrance settles to base at the window end', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.5 }, 5, W, H)
    expect(kfs.scale).toBeDefined()
    expect(kfs.opacity).toBeDefined()
    assertSortedUnique(kfs.scale!)
    // Starts small, ends at base scale (1) exactly at t=d.
    expect(evalChannel(kfs.scale, 0, 1)).toBeCloseTo(0.3, 5)
    expect(evalChannel(kfs.scale, 0.5, 1)).toBeCloseTo(1, 5)
    // And holds base afterwards.
    expect(evalChannel(kfs.scale, 4, 1)).toBeCloseTo(1, 5)
    // Opacity ramps 0 -> 1 and holds.
    expect(evalChannel(kfs.opacity, 0, 1)).toBeCloseTo(0, 5)
    expect(evalChannel(kfs.opacity, 4, 1)).toBeCloseTo(1, 5)
  })

  it('an exit starts from base and leaves at 0 opacity', () => {
    const D = 5
    const kfs = buildAppearanceKeyframes({ out: 'fadeOut', durS: 0.5 }, D, W, H)
    expect(kfs.opacity).toBeDefined()
    // Holds base (1) until the window, then falls to 0 at the very end.
    expect(evalChannel(kfs.opacity, 0, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D - 0.5, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D, 1)).toBeCloseTo(0, 5)
  })

  it('merges entrance + exit on a shared channel without colliding keyframes', () => {
    // pop (scale, opacity) + zoomOut (scale, opacity) both touch scale + opacity.
    const D = 5
    const kfs = buildAppearanceKeyframes({ in: 'pop', out: 'zoomOut', durS: 0.5 }, D, W, H)
    assertSortedUnique(kfs.scale!)
    assertSortedUnique(kfs.opacity!)
    // Base held in the middle, animates at both ends.
    expect(evalChannel(kfs.scale, 0, 1)).toBeCloseTo(0.3, 5) // pop start
    expect(evalChannel(kfs.scale, 2.5, 1)).toBeCloseTo(1, 5) // settled middle
    expect(evalChannel(kfs.scale, D, 1)).toBeCloseTo(0, 5) // zoomed out
    expect(evalChannel(kfs.opacity, 2.5, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D, 1)).toBeCloseTo(0, 5)
  })

  it('clamps the window so in and out never overlap on a short clip', () => {
    // D = 0.4, requested 0.5 -> d clamps to 0.2; in ends at 0.2, out starts at 0.2.
    const D = 0.4
    const kfs = buildAppearanceKeyframes({ in: 'fadeIn', out: 'fadeOut', durS: 0.5 }, D, W, H)
    assertSortedUnique(kfs.opacity!)
    // No duplicate keyframe at the shared boundary t=0.2.
    const atBoundary = kfs.opacity!.filter((k) => Math.abs(k.t - 0.2) < 1e-4)
    expect(atBoundary.length).toBe(1)
    // Fully visible at the seam, invisible at both ends.
    expect(evalChannel(kfs.opacity, 0, 1)).toBeCloseTo(0, 5)
    expect(evalChannel(kfs.opacity, 0.2, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D, 1)).toBeCloseTo(0, 5)
  })

  it('is base-relative: settled values track the clip base', () => {
    const base = { opacity: 1, scale: 1.5, posX: 100, posY: -40, rotation: 0 }
    const kfs = buildAppearanceKeyframes({ in: 'pop' }, 5, W, H, base)
    // pop settles to base.scale, not neutral 1.
    expect(evalChannel(kfs.scale, 4, base.scale)).toBeCloseTo(1.5, 5)
  })

  it('slide/rise offsets scale to the frame size', () => {
    const kfs = buildAppearanceKeyframes({ in: 'slideIn' }, 5, W, H)
    // starts off to the left by half the frame width, settles at 0.
    expect(evalChannel(kfs.posX, 0, 0)).toBeCloseTo(-W * 0.5, 3)
    expect(evalChannel(kfs.posX, 4, 0)).toBeCloseTo(0, 5)
  })

  it('only emits keyframes for the appearance-owned channels', () => {
    const kfs = buildAppearanceKeyframes({ in: 'spinIn', out: 'dropDown' }, 5, W, H)
    for (const ch of Object.keys(kfs)) {
      expect(APPEARANCE_CHANNELS).toContain(ch)
    }
  })

  it('bounce overshoots bigger than base then settles', () => {
    const kfs = buildAppearanceKeyframes({ in: 'bounce', durS: 0.5 }, 5, W, H)
    // Peaks above base scale mid-window, settles back to base.
    const peak = Math.max(...[0.2, 0.275, 0.35].map((t) => evalChannel(kfs.scale, t, 1)))
    expect(peak).toBeGreaterThan(1.1)
    expect(evalChannel(kfs.scale, 4, 1)).toBeCloseTo(1, 5)
  })

  it('id guards and emptiness', () => {
    expect(isEntranceId('pop')).toBe(true)
    expect(isEntranceId('bounce')).toBe(true)
    expect(isEntranceId('fadeOut')).toBe(false)
    expect(isExitId('fadeOut')).toBe(true)
    expect(isExitId('nope')).toBe(false)
    expect(isEmptyAppearance(undefined)).toBe(true)
    expect(isEmptyAppearance({})).toBe(true)
    expect(isEmptyAppearance({ in: 'bogus' })).toBe(true)
    expect(isEmptyAppearance({ in: 'pop' })).toBe(false)
    expect(buildAppearanceKeyframes({}, 5, W, H)).toEqual({})
  })
})

describe('applyAppearanceToClip', () => {
  const titleClip = (): Clip => newTitleClip(defaultTitleDef('Hi'), 0, 5)

  it('writes appearance-owned keyframes and stamps the spec', () => {
    const out = applyAppearanceToClip(titleClip(), { in: 'pop' }, W, H)
    expect(out.appearance).toEqual({ in: 'pop' })
    expect(out.keyframes?.scale?.length).toBeGreaterThan(0)
    expect(out.keyframes?.opacity?.length).toBeGreaterThan(0)
    // Invisible at the first frame, base by the settle point.
    expect(resolveChannel(out, 'opacity', 0)).toBeCloseTo(0, 5)
    expect(resolveChannel(out, 'scale', 4)).toBeCloseTo(1, 5)
  })

  it('an empty spec clears the keyframes and drops the field', () => {
    const withAnim = applyAppearanceToClip(titleClip(), { in: 'pop', out: 'fadeOut' }, W, H)
    const cleared = applyAppearanceToClip(withAnim, {}, W, H)
    expect(cleared.appearance).toBeUndefined()
    expect(cleared.keyframes?.scale).toBeUndefined()
    expect(cleared.keyframes?.opacity).toBeUndefined()
  })

  it('is base-relative: re-applying after a scale change re-derives from the new base', () => {
    const base = { ...titleClip(), transform: { ...titleClip().transform, scale: 2 } }
    const out = applyAppearanceToClip(base, { in: 'pop' }, W, H)
    // pop settles to the clip's (new) base scale of 2, not neutral 1.
    expect(resolveChannel(out, 'scale', 4)).toBeCloseTo(2, 5)
  })
})
