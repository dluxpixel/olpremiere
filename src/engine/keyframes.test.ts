import { describe, expect, it } from 'vitest'
import {
  bezierEase,
  duplicateKeyframeAt,
  ease,
  evalChannel,
  removeKeyframeNear,
  scaleKeyframeSpan,
  setSegmentCurve,
  upsertKeyframe,
  upsertKeyframeValue,
} from './keyframes'
import { type Curve, type Keyframe } from './types'

const kf = (t: number, value: number, e: Keyframe['ease'] = 'linear'): Keyframe => ({ t, value, ease: e })

describe('ease', () => {
  it('linear/hold are identity on progress', () => {
    expect(ease('linear', 0.3)).toBeCloseTo(0.3)
    expect(ease('hold', 0.3)).toBeCloseTo(0.3)
  })
  it('easeIn/easeOut are quadratic mirrors', () => {
    expect(ease('easeIn', 0.5)).toBeCloseTo(0.25)
    expect(ease('easeOut', 0.5)).toBeCloseTo(0.75)
  })
  it('easeInOut is symmetric around 0.5', () => {
    expect(ease('easeInOut', 0)).toBeCloseTo(0)
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5)
    expect(ease('easeInOut', 1)).toBeCloseTo(1)
    expect(ease('easeInOut', 0.25) + ease('easeInOut', 0.75)).toBeCloseTo(1)
  })
  it('clamps out-of-range progress', () => {
    expect(ease('linear', -1)).toBe(0)
    expect(ease('linear', 2)).toBe(1)
  })
  it('an unknown stored ease returns x, never undefined', () => {
    // Nothing sanitizes `ease` on load, so a name written by a newer build
    // reaches this switch. Falling off the end returned undefined, which NaNs
    // the transform and renders a black frame. This is the guard for that.
    const unknown = 'springy' as Keyframe['ease']
    expect(ease(unknown, 0.42)).toBe(0.42)
    expect(ease(unknown, 0)).toBe(0)
    expect(ease(unknown, 1)).toBe(1)
    expect(ease(unknown, -1)).toBe(0)
    expect(ease(unknown, 2)).toBe(1)
  })
})

describe('evalChannel', () => {
  it('returns fallback for empty channels', () => {
    expect(evalChannel(undefined, 1, 42)).toBe(42)
    expect(evalChannel([], 1, 42)).toBe(42)
  })
  it('single keyframe holds everywhere', () => {
    expect(evalChannel([kf(2, 7)], 0, 0)).toBe(7)
    expect(evalChannel([kf(2, 7)], 5, 0)).toBe(7)
  })
  it('clamps before first and after last', () => {
    const ch = [kf(1, 10), kf(3, 30)]
    expect(evalChannel(ch, 0, 0)).toBe(10)
    expect(evalChannel(ch, 9, 0)).toBe(30)
  })
  it('linear-interpolates between keyframes', () => {
    const ch = [kf(1, 10), kf(3, 30)]
    expect(evalChannel(ch, 2, 0)).toBeCloseTo(20)
    expect(evalChannel(ch, 1.5, 0)).toBeCloseTo(15)
  })
  it('applies the LEFT keyframe easing to the segment', () => {
    const ch = [kf(0, 0, 'easeIn'), kf(2, 100)]
    expect(evalChannel(ch, 1, 0)).toBeCloseTo(25) // easeIn(0.5)=0.25
  })
  it('hold easing steps at the left value across the whole segment', () => {
    const ch = [kf(0, 10, 'hold'), kf(2, 20)]
    expect(evalChannel(ch, 0.1, 0)).toBe(10)
    expect(evalChannel(ch, 1.99, 0)).toBe(10)
    expect(evalChannel(ch, 2, 0)).toBe(20)
  })
  it('handles many keyframes via the segment search', () => {
    const ch = [kf(0, 0), kf(1, 10), kf(2, 5), kf(3, 25)]
    expect(evalChannel(ch, 0.5, 0)).toBeCloseTo(5)
    expect(evalChannel(ch, 1.5, 0)).toBeCloseTo(7.5)
    expect(evalChannel(ch, 2.5, 0)).toBeCloseTo(15)
  })
  it('an unknown ease interpolates instead of NaNing the frame', () => {
    const ch = [kf(0, 0, 'springy' as Keyframe['ease']), kf(2, 100)]
    expect(evalChannel(ch, 1, 0)).toBe(50)
    expect(evalChannel(ch, 0.5, 0)).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// Curves. The bezier path is new; the named-ease path must not have moved a bit.
// ---------------------------------------------------------------------------

const NAMED_EASES: Keyframe['ease'][] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']

/**
 * Frozen copy of ease() exactly as it stood before the curve field existed.
 * Comparing against a reimplementation rather than against pinned decimals is
 * the point: every project already on disk renders through the named eases, and
 * a version that is merely CLOSE would shift thousands of frames by a hair that
 * nobody sees until a side-by-side export.
 */
const legacyEase = (kind: Keyframe['ease'], p: number): number => {
  const x = p < 0 ? 0 : p > 1 ? 1 : p
  switch (kind) {
    case 'linear':
    case 'hold':
      return x
    case 'easeIn':
      return x * x
    case 'easeOut':
      return 1 - (1 - x) * (1 - x)
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
  }
}

describe('named eases are byte-identical when curve is absent', () => {
  it('ease() matches the pre-curve implementation exactly', () => {
    for (const name of NAMED_EASES) {
      for (let i = -5; i <= 105; i++) {
        const p = i / 100
        expect(ease(name, p)).toBe(legacyEase(name, p))
      }
    }
  })
  it('evalChannel over a curve-free channel is exact, not close', () => {
    for (const name of NAMED_EASES) {
      const ch = [kf(1, 10, name), kf(3, 30)]
      for (let i = 0; i < 200; i++) {
        const t = 1 + (i / 200) * 2
        const p = (t - 1) / 2
        const want = name === 'hold' ? 10 : 10 + 20 * legacyEase(name, p)
        expect(evalChannel(ch, t, 0)).toBe(want)
      }
    }
  })
})

describe('bezierEase', () => {
  // Solved offline to machine precision by 200-step bisection on x(t), then
  // evaluating y(t). The six named curves are the MOTION_CURVES defaults.
  const KNOWN: { name: string; curve: Curve; at: [number, number][] }[] = [
    // CSS `ease`, the one value everybody can check against a browser.
    {
      name: 'css ease',
      curve: [0.25, 0.1, 0.25, 1],
      at: [
        [0.1, 0.09479631],
        [0.25, 0.40851059],
        [0.5, 0.80240339],
        [0.75, 0.96045898],
        [0.9, 0.99431648],
      ],
    },
    {
      name: 'snapIn',
      curve: [0.16, 1, 0.3, 1],
      at: [
        [0.1, 0.49439062],
        [0.25, 0.8256223],
        [0.5, 0.97177911],
      ],
    },
    {
      name: 'settle',
      curve: [0.23, 1, 0.32, 1],
      at: [
        [0.25, 0.77538166],
        [0.5, 0.96598256],
      ],
    },
    {
      name: 'smooth',
      curve: [0.37, 0, 0.63, 1],
      at: [
        [0.25, 0.14467318],
        [0.5, 0.5],
        [0.75, 0.85532682],
      ],
    },
    {
      name: 'windUp',
      curve: [0.5, 0, 1, 1],
      at: [
        [0.25, 0.07540222],
        [0.5, 0.27806614],
        [0.9, 0.81983665],
      ],
    },
    {
      name: 'easyEase',
      curve: [0.33, 0, 0.67, 1],
      at: [
        [0.25, 0.15730467],
        [0.5, 0.5],
        [0.75, 0.84269533],
      ],
    },
    {
      name: 'overshoot',
      curve: [0.34, 1.56, 0.64, 1],
      at: [
        [0.25, 0.8162892],
        [0.5, 1.08740067],
        [0.9, 1.01261558],
      ],
    },
  ]

  it('matches known cubic-bezier values within 1e-4', () => {
    for (const { curve, at } of KNOWN) {
      for (const [x, y] of at) expect(bezierEase(curve, x)).toBeCloseTo(y, 4)
    }
  })

  it('pins both endpoints and clamps progress outside 0..1', () => {
    for (const { curve } of KNOWN) {
      expect(bezierEase(curve, 0)).toBe(0)
      expect(bezierEase(curve, 1)).toBe(1)
      expect(bezierEase(curve, -3)).toBe(0)
      expect(bezierEase(curve, 4)).toBe(1)
    }
  })

  it('cubic-bezier(0, 0, 1, 1) is the identity, to the solver epsilon', () => {
    for (let i = 0; i <= 100; i++) {
      const x = i / 100
      expect(bezierEase([0, 0, 1, 1], x)).toBeCloseTo(x, 5)
    }
  })

  it('clamps x1 and x2 into 0..1 so time stays a function of time', () => {
    // Same y handles, wild x handles: the clamp must make these the same curve.
    for (let i = 0; i <= 100; i++) {
      const x = i / 100
      expect(bezierEase([-2, 0, 3, 1], x)).toBe(bezierEase([0, 0, 1, 1], x))
      expect(bezierEase([9, 0.2, -9, 0.8], x)).toBe(bezierEase([1, 0.2, 0, 0.8], x))
    }
  })

  it('x stays monotonic under clamping, including where the slope collapses', () => {
    // [1, y1, 0, y2] is the pathological one: x(t) is flat at t=0.5, which is
    // the case Newton-Raphson cannot step off and the bisection fallback owns.
    const curves: Curve[] = [
      [1, 0, 0, 1],
      [-2, 0, 3, 1],
      [9, 0.2, -9, 0.8],
      [0.16, 1, 0.3, 1],
      [0.5, 0, 1, 1],
    ]
    for (const curve of curves) {
      let prev = -Infinity
      for (let i = 0; i <= 500; i++) {
        const y = bezierEase(curve, i / 500)
        expect(Number.isFinite(y)).toBe(true)
        expect(y).toBeGreaterThanOrEqual(prev)
        prev = y
      }
    }
  })

  it('leaves y unclamped so overshoot survives', () => {
    const overshoot: Curve = [0.34, 1.56, 0.64, 1]
    let peak = 0
    for (let i = 0; i <= 1000; i++) peak = Math.max(peak, bezierEase(overshoot, i / 1000))
    expect(peak).toBeGreaterThan(1.09)
    expect(bezierEase(overshoot, 0.5)).toBeGreaterThan(1)
    // And it comes back: the whole move still lands exactly on its target.
    expect(bezierEase(overshoot, 1)).toBe(1)
  })

  it('allows undershoot below 0 for a wind-up', () => {
    expect(bezierEase([0.36, -0.6, 0.66, 1], 0.2)).toBeLessThan(0)
  })
})

describe('evalChannel with a curve', () => {
  const curved = (t: number, value: number, curve: Curve): Keyframe => ({ t, value, ease: 'linear', curve })

  it('runs the bezier on the segment LEAVING the keyframe that carries it', () => {
    const ch = [curved(0, 0, [0.33, 0, 0.67, 1]), kf(2, 100)]
    expect(evalChannel(ch, 1, 0)).toBeCloseTo(50, 4) // easyEase is symmetric
    expect(evalChannel(ch, 0.5, 0)).toBeCloseTo(15.730467, 3)
  })

  it('the curve wins over the named ease on that keyframe', () => {
    // Same keyframe, easeIn by name, an identity curve attached: curve decides.
    const ch: Keyframe[] = [{ t: 0, value: 0, ease: 'easeIn', curve: [0, 0, 1, 1] }, kf(2, 100)]
    expect(evalChannel(ch, 1, 0)).toBeCloseTo(50, 4)
    expect(evalChannel([kf(0, 0, 'easeIn'), kf(2, 100)], 1, 0)).toBe(25)
  })

  it('only the segment that carries the curve is curved', () => {
    const ch = [kf(0, 0), curved(2, 100, [0.33, 0, 0.67, 1]), kf(4, 200)]
    expect(evalChannel(ch, 1, 0)).toBe(50) // first segment still plain linear
    expect(evalChannel(ch, 3, 0)).toBeCloseTo(150, 4)
  })

  it('hold still holds, curve or not', () => {
    const ch: Keyframe[] = [{ t: 0, value: 10, ease: 'hold', curve: [0.16, 1, 0.3, 1] }, kf(2, 20)]
    expect(evalChannel(ch, 1.99, 0)).toBe(10)
  })

  it('carries overshoot past the target value', () => {
    const ch = [curved(0, 100, [0.34, 1.56, 0.64, 1]), kf(1, 120)]
    expect(evalChannel(ch, 0.57, 0)).toBeGreaterThan(120)
    expect(evalChannel(ch, 1, 0)).toBe(120)
  })
})

describe('setSegmentCurve', () => {
  const snap: Curve = [0.16, 1, 0.3, 1]

  it('writes the curve on the keyframe the segment leaves from', () => {
    const ch = setSegmentCurve([kf(0, 0), kf(2, 100)], 0, snap)
    expect(ch[0].curve).toEqual(snap)
    expect(ch[1].curve).toBeUndefined()
  })
  it('clears back to the named ease when given undefined', () => {
    const ch = setSegmentCurve([{ t: 0, value: 0, ease: 'easeIn', curve: snap }, kf(2, 100)], 0, undefined)
    expect(ch[0].curve).toBeUndefined()
    expect(ch[0].ease).toBe('easeIn')
    expect(evalChannel(ch, 1, 0)).toBe(25)
  })
  it('matches within a moment, and returns the same ref when nothing sits there', () => {
    const ch = [kf(0, 0), kf(2, 100)]
    expect(setSegmentCurve(ch, 2.00001, snap)[1].curve).toEqual(snap)
    expect(setSegmentCurve(ch, 1, snap)).toBe(ch)
    expect(setSegmentCurve(undefined, 0, snap)).toEqual([])
  })
})

describe('scaleKeyframeSpan', () => {
  it('stretches around the anchor and keeps the spacing', () => {
    const ch = scaleKeyframeSpan([kf(1, 0), kf(2, 50), kf(3, 100)], 1, 2, 10)
    expect(ch.map((k) => k.t)).toEqual([1, 3, 5])
  })
  it('squashes around an anchor that is not a keyframe', () => {
    const ch = scaleKeyframeSpan([kf(0, 0), kf(4, 100)], 2, 0.5, 10)
    expect(ch.map((k) => k.t)).toEqual([1, 3])
  })
  it('clamps inside the clip without reordering', () => {
    const ch = scaleKeyframeSpan([kf(1, 0), kf(2, 50), kf(3, 100)], 2, 4, 5)
    expect(ch.map((k) => k.t)).toEqual([0, 2, 5])
    expect(ch.map((k) => k.value)).toEqual([0, 50, 100])
  })
  it('keeps values, eases and curves', () => {
    const snap: Curve = [0.16, 1, 0.3, 1]
    const ch = scaleKeyframeSpan([{ t: 1, value: 7, ease: 'easeIn', curve: snap }, kf(2, 9)], 0, 2, 10)
    expect(ch[0]).toEqual({ t: 2, value: 7, ease: 'easeIn', curve: snap })
    expect(ch[1].t).toBe(4)
  })
  it('is a no-op for factor 1 and refuses to fold the move', () => {
    const ch = [kf(1, 0), kf(2, 100)]
    expect(scaleKeyframeSpan(ch, 0, 1, 10)).toBe(ch)
    expect(scaleKeyframeSpan(ch, 0, 0, 10)).toBe(ch)
    expect(scaleKeyframeSpan(ch, 0, -2, 10)).toBe(ch)
    expect(scaleKeyframeSpan(ch, 0, NaN, 10)).toBe(ch)
  })
})

describe('duplicateKeyframeAt', () => {
  const snap: Curve = [0.16, 1, 0.3, 1]

  it('copies value, ease and curve to the new time', () => {
    const src: Keyframe = { t: 1, value: 42, ease: 'easeOut', curve: snap }
    const ch = duplicateKeyframeAt([src, kf(3, 0)], 1, 2)
    expect(ch.map((k) => k.t)).toEqual([1, 2, 3])
    expect(ch[1]).toEqual({ t: 2, value: 42, ease: 'easeOut', curve: snap })
    expect(ch[0]).toBe(src) // the original is untouched
  })
  it('lands sorted and replaces an existing keyframe at the target time', () => {
    const ch = duplicateKeyframeAt([kf(0, 5, 'easeIn'), kf(2, 99)], 0, 2)
    expect(ch).toHaveLength(2)
    expect(ch[1]).toEqual({ t: 2, value: 5, ease: 'easeIn' })
  })
  it('returns the same ref when there is no keyframe at t', () => {
    const ch = [kf(0, 0), kf(2, 100)]
    expect(duplicateKeyframeAt(ch, 1, 3)).toBe(ch)
    expect(duplicateKeyframeAt(undefined, 0, 1)).toEqual([])
  })
})

// Channel resolution moved to effects/channels.ts (it needs the registry); its
// tests live in effects/channels.test.ts. This module is pure math now.

describe('upsertKeyframe / removeKeyframeNear', () => {
  it('inserts sorted', () => {
    let ch = upsertKeyframe(undefined, kf(2, 20))
    ch = upsertKeyframe(ch, kf(0, 0))
    ch = upsertKeyframe(ch, kf(1, 10))
    expect(ch.map((k) => k.t)).toEqual([0, 1, 2])
  })
  it('replaces at an existing (near-exact) time', () => {
    const ch = upsertKeyframe([kf(1, 10)], kf(1, 99))
    expect(ch).toHaveLength(1)
    expect(ch[0].value).toBe(99)
  })
  it('removes the nearest within tolerance, else no-op', () => {
    const ch = [kf(0, 0), kf(1, 10), kf(2, 20)]
    expect(removeKeyframeNear(ch, 1.0001, 0.01).map((k) => k.t)).toEqual([0, 2])
    expect(removeKeyframeNear(ch, 5, 0.01)).toBe(ch)
  })
})

/**
 * ⛔ A NUMBER HE TYPES CHANGES THE NUMBER, NEVER THE SHAPE HE DREW.
 *
 * Both write paths used to stamp the shelf's current curve onto every write, so
 * shaping a segment by hand and then correcting the value at the same moment
 * threw the hand-drawn curve away. Audit item 4, 2026-08-14.
 */
describe('upsertKeyframeValue', () => {
  const shaped = { t: 1, value: 10, ease: 'easeOut' as const, curve: [0.2, 0, 0, 1] as const }
  const preference = { ease: 'easeIn' as const, curve: [0.9, 0, 1, 1] as Curve }

  it('keeps the ease AND the curve already at that moment', () => {
    const ch = upsertKeyframeValue([{ ...shaped, curve: [...shaped.curve] as Curve }], 1, 99, preference)
    expect(ch).toHaveLength(1)
    expect(ch[0].value).toBe(99)
    expect(ch[0].ease).toBe('easeOut')
    expect(ch[0].curve).toEqual([0.2, 0, 0, 1])
  })

  it('gives a BRAND NEW moment the shape it was handed', () => {
    const ch = upsertKeyframeValue([{ ...shaped, curve: [...shaped.curve] as Curve }], 3, 20, preference)
    expect(ch.map((k) => k.t)).toEqual([1, 3])
    expect(ch[1].ease).toBe('easeIn')
    expect(ch[1].curve).toEqual([0.9, 0, 1, 1])
  })

  /**
   * ⛔ THE PLACEHOLDER IS NOT A DECISION, AND THIS COST A SHIP TO LEARN.
   *
   * Arming a clip from the gizmo writes the landed keyframe as linear with no
   * curve, and the very next write of the same drag is what gives it the snap
   * curve. Reading that placeholder as something he chose turned every armed
   * gizmo drag back into a linear move.
   */
  it('UPGRADES a moment still carrying the neutral placeholder', () => {
    const ch = upsertKeyframeValue([{ t: 1, value: 10, ease: 'linear' }], 1, 42, preference)
    expect(ch).toHaveLength(1)
    expect(ch[0].value).toBe(42)
    expect(ch[0].ease).toBe('easeIn')
    expect(ch[0].curve).toEqual([0.9, 0, 1, 1])
  })

  it('keeps a named ease he chose even with no curve on it', () => {
    const ch = upsertKeyframeValue([{ t: 1, value: 10, ease: 'hold' }], 1, 42, preference)
    expect(ch[0].ease).toBe('hold')
    expect(ch[0].curve).toBeUndefined()
  })

  it('does not invent a curve when neither the moment nor the shape has one', () => {
    const ch = upsertKeyframeValue([kf(1, 10)], 1, 5, { ease: 'linear' })
    expect(ch[0].curve).toBeUndefined()
    expect(ch[0].ease).toBe('linear')
  })

  it('works from nothing at all', () => {
    expect(upsertKeyframeValue(undefined, 2, 7, { ease: 'linear' })).toEqual([{ t: 2, value: 7, ease: 'linear' }])
  })
})
