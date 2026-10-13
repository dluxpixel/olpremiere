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
import { BROWSABLE_EFFECTS, CANONICAL_ORDER, EFFECTS, LOOK_EFFECTS, TOOL_EFFECTS, getEffect } from './registry'

const types = (list: { type: string }[]): string[] => list.map((e) => e.type)

describe('the Effects browser is short', () => {
  it('still hides the duplicates and the colourist-only tools', () => {
    // His call, 2026-10-10 (gym filters): the list may grow back by exactly the
    // tools a gym edit uses. It is still held to a ceiling, so it cannot drift
    // back to the fifteen it was cut down from on 2026-07-28. The seventeenth is
    // the LUT effect (a .cube file graded in the shared renderer), added with the gym looks.
    const tools = BROWSABLE_EFFECTS.filter((e) => e.category !== 'look')
    expect(tools.length).toBeLessThanOrEqual(17)
  })

  it('keeps the looks off the tools list and on their own shelf', () => {
    expect(types(TOOL_EFFECTS).some((t) => t.startsWith('look'))).toBe(false)
    expect(LOOK_EFFECTS.length).toBeGreaterThanOrEqual(8)
    expect(LOOK_EFFECTS.every((e) => e.category === 'look' && !e.hidden)).toBe(true)
    expect([...types(TOOL_EFFECTS), ...types(LOOK_EFFECTS)].sort()).toEqual(types(BROWSABLE_EFFECTS).sort())
  })

  it('keeps the ones he actually reaches for', () => {
    for (const type of ['autoColor', 'brightness', 'contrast', 'saturation', 'chromaKey', 'glow', 'vignette', 'gaussianBlur']) {
      expect(types(BROWSABLE_EFFECTS)).toContain(type)
    }
  })

  it('offers every gym tool he asked for on 2026-10-10, except Sharpen', () => {
    // Film Grain, Motion Blur, and the skin and highlight colour tools
    // were built and hidden. He said "Yes, show them". Strobe, RGB split and
    // Cinematic bars are new. Sharpen came back with them and left again on
    // 2026-10-12 (next test).
    for (const type of ['grain', 'directionalBlur', 'colorWheels', 'whiteBalance', 'strobe', 'rgbSplit', 'cinematicBars']) {
      expect(types(BROWSABLE_EFFECTS)).toContain(type)
    }
  })

  it('keeps Sharpen off the shelf, but renderable for projects that already carry it', () => {
    // His words, 2026-10-12: "sharpen is a really bad setting that just makes my
    // videos look bad quality". The definition and its render pass stay so a saved
    // project keeps looking the way it did.
    expect(types(BROWSABLE_EFFECTS)).not.toContain('sharpen')
    expect(types(TOOL_EFFECTS)).not.toContain('sharpen')
    expect(getEffect('sharpen')?.hidden).toBe(true)
    expect(CANONICAL_ORDER as readonly string[]).toContain('sharpen')
  })

  it('shows the user facing blur as Motion Blur, and keeps the move derived smear hidden', () => {
    expect(getEffect('directionalBlur')?.label).toBe('Motion Blur')
    expect(getEffect('motionSmear')?.hidden).toBe(true)
    expect(types(BROWSABLE_EFFECTS)).not.toContain('motionSmear')
  })

  it('drops the duplicates the looks and the move smear use internally', () => {
    // Exposure overlaps Brightness; vibrance overlaps Saturation; luma key is a
    // colourist tool. brightnessContrast joined them on 2026-08-10: it is the
    // frozen additive version, kept alive only so clips cut before the split
    // still render. Look Clarity and Look Glow are made by the looks themselves.
    for (const type of ['exposure', 'vibrance', 'lumaKey', 'brightnessContrast', 'motionSmear', 'lookClarity', 'lookGlow']) {
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
