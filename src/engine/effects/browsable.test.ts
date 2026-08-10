// What the Effects browser is allowed to show.
//
// His call, 2026-07-28: "most of the effects I won't ever use. They are just
// stupid. There is a lot of bloat." Fifteen entries, seven of them pro colour
// tools he will never open, is a list he reads past every single time.
//
// The dangerous way to shorten it is to delete the entries. `filtersToEffectStack`
// migrates every project he has ever saved through exposure, lift/gamma/gain,
// white balance and blur, so a deleted type does not tidy the app, it changes how
// his saved work looks. So they are HIDDEN from the pickers and left intact
// everywhere else, and this file is what holds those two facts apart.

import { describe, expect, it } from 'vitest'
import { BROWSABLE_EFFECTS, CANONICAL_ORDER, EFFECTS, getEffect } from './registry'

const types = (list: { type: string }[]): string[] => list.map((e) => e.type)

describe('the Effects browser is short', () => {
  it('offers less than half of what it used to', () => {
    expect(BROWSABLE_EFFECTS.length).toBeLessThan(EFFECTS.length / 2 + 1)
  })

  it('keeps the ones he actually reaches for', () => {
    for (const type of ['autoColor', 'brightness', 'contrast', 'saturation', 'chromaKey', 'glow', 'vignette', 'gaussianBlur']) {
      expect(types(BROWSABLE_EFFECTS)).toContain(type)
    }
  })

  it('drops the pro colour desk and the duplicates', () => {
    // Exposure and white balance overlap Brightness; vibrance overlaps Saturation;
    // lift/gamma/gain and luma key are colourist tools; directional blur is a
    // building block the whip uses, not something to drag onto a clip.
    // brightnessContrast joined them on 2026-08-10: it is the frozen additive
    // version, kept alive only so clips cut before the split still render.
    for (const type of ['exposure', 'colorWheels', 'whiteBalance', 'vibrance', 'lumaKey', 'directionalBlur', 'brightnessContrast']) {
      expect(types(BROWSABLE_EFFECTS)).not.toContain(type)
    }
  })
})

describe('hiding an effect never breaks a project that uses it', () => {
  it('keeps every hidden effect in the registry, renderable', () => {
    for (const def of EFFECTS.filter((e) => e.hidden)) {
      expect(getEffect(def.type)).toBe(def)
      // A hidden effect still has to have its shader, or a clip carrying it would
      // render as nothing at all.
      expect(def.params.length).toBeGreaterThan(0)
    }
  })

  it('keeps every hidden effect in the canonical render order', () => {
    // The order is what makes a migrated project render identically. A type
    // missing from it would silently move in the stack.
    for (const def of EFFECTS.filter((e) => e.hidden)) {
      expect(CANONICAL_ORDER as readonly string[]).toContain(def.type)
    }
  })

  it('hides only effects that already exist', () => {
    expect(EFFECTS.filter((e) => e.hidden).length).toBe(EFFECTS.length - BROWSABLE_EFFECTS.length)
  })
})
