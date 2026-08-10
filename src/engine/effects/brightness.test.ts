// Brightness is a GAIN, not an offset.
//
// HIS REPORT, 2026-08-10: "instead of actually putting the brightness up, it
// just makes the screen whiter." He was right, and the effect's own description
// said so out loud: "Additive brightness". `c += b` lifts black to grey, crushes
// every ratio in the picture, and clips everything above 1 - b to one flat
// white. That is a fade to white.
//
// The shader is one line, so these tests model it on the CPU. The model and the
// real GLSL are pinned against each other in the first block below, which is
// what stops them drifting: an edit to the shader that the model does not follow
// fails here rather than in his footage.

import { describe, expect, it } from 'vitest'
import { BROWSABLE_EFFECTS, EFFECT_BY_TYPE } from './registry'

/** Name uniforms predictably so the emitted GLSL can be compared as text. */
const u = (key: string): string => `U_${key}`

/** The final clamp glRenderer.ts applies after the whole pointwise chain. */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** The model of `c *= pow(2.0, brightness)`, pinned to the shader below. */
const brighten = (c: number, b: number): number => clamp01(c * Math.pow(2, b))

/** The model of what it replaced, `c += brightness`. Here to be argued against. */
const oldBrighten = (c: number, b: number): number => clamp01(c + b)

describe('the model IS the shader', () => {
  it('brightness emits exactly one multiply', () => {
    expect(EFFECT_BY_TYPE.brightness.glsl!(u).trim()).toBe('c *= pow(2.0, U_brightness);')
  })

  it('contrast IS the legacy contrast line, character for character', () => {
    // This identity is what lets migrate.ts rewrite an old brightnessContrast
    // whose brightness sits at a static 0 onto the new Contrast type without a
    // single pixel moving. If someone edits one of these two shaders and not the
    // other, that migration silently starts regrading his old projects, and this
    // is the only place that would notice.
    const line = (src: string, i: number): string => src.trim().split('\n')[i].trim()
    const legacy = EFFECT_BY_TYPE.brightnessContrast.glsl!(u)
    expect(line(legacy, 0)).toBe('c += U_brightness;')
    expect(line(legacy, 1)).toBe(line(EFFECT_BY_TYPE.contrast.glsl!(u), 0))
  })

  it('keeps the slider a brightness slider: -1 to 1, neutral at 0', () => {
    const param = EFFECT_BY_TYPE.brightness.params[0]
    expect([param.key, param.min, param.max, param.default]).toEqual(['brightness', -1, 1, 0])
  })
})

describe('brightness at 0 is a true no-op', () => {
  // pow(x, y) is exp2(y * log2(x)), and log2(2.0) is exactly 1.0 in IEEE, so
  // pow(2.0, 0.0) is exactly 1.0 and `c *= 1.0` is bit-exact. It has to be: a
  // STATIC zero never reaches the shader (isNeutral drops the effect), but a
  // KEYFRAMED brightness passes through zero mid-animation, and a pixel that
  // shifted there would pop.
  it('returns every sample unchanged, exactly', () => {
    for (const c of [0, 0.001, 0.18, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(brighten(c, 0)).toBe(c)
    }
  })

  it('is exact, not close: pow(2, 0) is 1', () => {
    expect(Math.pow(2, 0)).toBe(1)
    expect(0.37 * Math.pow(2, 0)).toBe(0.37)
  })
})

describe('a mid grey pixel gets brighter without a bright pixel clipping flat', () => {
  const b = 0.3 // the kind of setting he actually reaches for

  it('lifts mid grey', () => {
    expect(brighten(0.5, b)).toBeCloseTo(0.6156, 4)
    expect(brighten(0.5, b)).toBeGreaterThan(0.5)
  })

  it('leaves a bright pixel BELOW white, where the old maths clipped it', () => {
    expect(brighten(0.8, b)).toBeCloseTo(0.9849, 4)
    expect(brighten(0.8, b)).toBeLessThan(1)
    expect(oldBrighten(0.8, b)).toBe(1) // the bug: flat white
  })

  it('keeps highlight detail that the old maths flattened into one white', () => {
    // Two neighbouring highlights stay two different numbers.
    expect(brighten(0.8, b)).not.toBe(brighten(0.75, b))
    // Additively they were both crushed to the same pure white, and the
    // difference between them was gone for good.
    expect(oldBrighten(0.8, b)).toBe(oldBrighten(0.75, b))
  })

  it('leaves black BLACK, which is the whole complaint', () => {
    expect(brighten(0, b)).toBe(0)
    expect(oldBrighten(0, b)).toBeCloseTo(0.3, 6) // the grey veil over the frame
  })

  it('preserves the ratio between a dark and a light pixel', () => {
    // "Whiter" is what a lost ratio looks like. A gain keeps 5:1 at 5:1; an
    // offset compresses it toward 1:1, which reads as milky and flat.
    expect(brighten(0.5, b) / brighten(0.1, b)).toBeCloseTo(5, 6)
    expect(oldBrighten(0.5, b) / oldBrighten(0.1, b)).toBeCloseTo(2, 6)
  })
})

describe('the two ends are symmetrical', () => {
  it('equal and opposite settings are exactly reciprocal gains', () => {
    for (const b of [0.1, 0.25, 0.5, 1]) {
      expect(Math.pow(2, b) * Math.pow(2, -b)).toBeCloseTo(1, 12)
    }
  })

  it('round-trips an unclipped pixel back to itself', () => {
    for (const b of [0.2, 0.5, 1]) {
      expect(brighten(brighten(0.4, b), -b)).toBeCloseTo(0.4, 10)
    }
  })

  it('neither end is a wipe: full travel still leaves a picture', () => {
    // The old slider blew the whole frame to white at +1 and to black at -1, so
    // most of its travel was unusable. Both ends have to stay gradeable.
    expect(brighten(0.2, 1)).toBeCloseTo(0.4, 6) // a dark pixel at FULL bright is not white
    expect(brighten(0.8, -1)).toBeCloseTo(0.4, 6) // a light pixel at FULL dark is not black
    expect(oldBrighten(0.2, 1)).toBe(1)
    expect(oldBrighten(0.8, -1)).toBe(0)
  })

  it('moves mid grey the same distance in stops at each end', () => {
    // Symmetry that means something: the light ratio at +b is the reciprocal of
    // the one at -b, so the slider feels even rather than dead at one end.
    expect(brighten(0.5, 1) / 0.5).toBeCloseTo(0.5 / brighten(0.5, -1), 6)
  })
})

describe('both effects are on the shelf, on their own', () => {
  // HIS INSTRUCTION, 2026-08-10: "do brightness and contrast as a separate
  // effect. I don't know why you have to pack them together."
  const shelf = BROWSABLE_EFFECTS.map((e) => e.type)

  it('offers Brightness and Contrast as two entries', () => {
    expect(shelf).toContain('brightness')
    expect(shelf).toContain('contrast')
  })

  it('each carries exactly one param, so neither drags the other along', () => {
    expect(EFFECT_BY_TYPE.brightness.params.map((p) => p.key)).toEqual(['brightness'])
    expect(EFFECT_BY_TYPE.contrast.params.map((p) => p.key)).toEqual(['contrast'])
  })

  it('takes the packed one off the shelf without deleting it', () => {
    expect(shelf).not.toContain('brightnessContrast')
    // Still in the registry, still renderable, or every project he cut before
    // the split would open with its grade silently gone.
    expect(EFFECT_BY_TYPE.brightnessContrast).toBeDefined()
    expect(EFFECT_BY_TYPE.brightnessContrast.glsl).toBeDefined()
  })
})
