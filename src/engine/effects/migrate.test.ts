// What happens to work he has already cut when an effect type splits in two.
//
// The thing this file exists to stop: a migration that silently REGRADES
// footage. If his old shorts open looking different, he has no way to tell which
// ones changed, and the bug is worse than the one being fixed. So the rule is
// narrow and the tests are about what must NOT move.
//
// Traced, not assumed: an effect type the registry no longer knows is dropped
// SILENTLY. resolve.ts asks isNeutral first, and isNeutral returns true for an
// unknown type (registry.ts), so the instance never reaches resolveEffect and
// never reaches the shader. It does not throw and the project still opens. The
// clip simply renders ungraded, with the only evidence a card in the Inspector.
// That is why `brightnessContrast` is kept alive rather than deleted.

import { describe, expect, it } from 'vitest'
import { defaultTransform, type Clip, type EffectInstance, type Keyframe } from '../types'
import { resolveEffect } from './registry'
import { migrateClipEffects } from './migrate'

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

const bc = (params: EffectInstance['params'], id = 'fx_brightnessContrast'): EffectInstance => ({
  id,
  type: 'brightnessContrast',
  params,
  enabled: true,
})

describe('a stored ADDITIVE brightness is never converted', () => {
  // There is no faithful conversion. `in + b == in * g` needs g = 1 + b/in,
  // which depends on the pixel; matching at mid grey alone would give
  // b' = log2(1 + 2b), so 0.3 becomes 0.678, right on one tone and wrong on
  // every other, undefined at b <= -0.5, and it would darken blacks the old
  // maths was lifting to grey. So the value stays put and the legacy effect
  // keeps rendering it.
  it('leaves the instance completely alone, type and value', () => {
    const c = clip({ effects: [bc({ brightness: 0.3, contrast: 0.2 })] })
    const out = migrateClipEffects(c)
    expect(out.effects).toEqual([bc({ brightness: 0.3, contrast: 0.2 })])
  })

  it('hands the renderer the identical resolved effect it did before', () => {
    // resolveEffect IS what resolve.ts feeds the renderer, so equality here is
    // equality of the pixels.
    const inst = bc({ brightness: 0.3, contrast: 0.2 })
    const before = resolveEffect(inst, 0)
    const after = resolveEffect(migrateClipEffects(clip({ effects: [inst] })).effects[0], 0)
    expect(after).toEqual(before)
    expect(after).toEqual({ type: 'brightnessContrast', params: { brightness: 0.3, contrast: 0.2 } })
  })

  it('returns the SAME clip object, so migrateProjectEffects sees no change', () => {
    const c = clip({ effects: [bc({ brightness: 0.3, contrast: 0 })] })
    expect(migrateClipEffects(c)).toBe(c)
  })

  it('never splits a KEYFRAMED brightness, even where it currently reads 0', () => {
    // Same reason isNeutral refuses to treat it as neutral: it leaves 0 later.
    const animated = bc({ brightness: { value: 0, keyframes: [kf(0, 0), kf(2, 0.5)] }, contrast: 0.1 })
    const out = migrateClipEffects(clip({ effects: [animated] }))
    expect(out.effects[0].type).toBe('brightnessContrast')
    expect(out.effects[0]).toEqual(animated)
  })

  it('a keyframed brightness still animates after the migration', () => {
    const animated = bc({ brightness: { value: 0, keyframes: [kf(0, 0), kf(2, 0.5)] }, contrast: 0 })
    const out = migrateClipEffects(clip({ effects: [animated] }))
    expect(resolveEffect(out.effects[0], 1)!.params.brightness).toBeCloseTo(0.25)
    expect(resolveEffect(out.effects[0], 2)!.params.brightness).toBeCloseTo(0.5)
  })
})

describe('a brightnessContrast with NO brightness becomes the standalone Contrast', () => {
  // Provably free: the new Contrast shader is the legacy one's second line
  // character for character (pinned in brightness.test.ts), and `c += 0.0` is
  // the identity on every finite float, so no pixel can move.
  it('rewrites the type and keeps the contrast value', () => {
    const out = migrateClipEffects(clip({ effects: [bc({ brightness: 0, contrast: 0.1 })] }))
    expect(out.effects).toEqual([{ id: 'fx_brightnessContrast', type: 'contrast', params: { contrast: 0.1 }, enabled: true }])
  })

  it('keeps the instance id and its index in the stack', () => {
    // Pointwise bodies are concatenated in stack order, so moving it would
    // change the math order; the id is what every Inspector row, undo entry and
    // selection points at.
    const other: EffectInstance = { id: 'sat', type: 'saturation', params: { saturation: 0.13 }, enabled: true }
    const out = migrateClipEffects(clip({ effects: [bc({ brightness: 0, contrast: 0.1 }, 'keepme'), other] }))
    expect(out.effects.map((e) => e.id)).toEqual(['keepme', 'sat'])
    expect(out.effects.map((e) => e.type)).toEqual(['contrast', 'saturation'])
  })

  it('treats an ABSENT brightness as no brightness', () => {
    const out = migrateClipEffects(clip({ effects: [bc({ contrast: -0.4 })] }))
    expect(out.effects[0]).toMatchObject({ type: 'contrast', params: { contrast: -0.4 } })
  })

  it('carries KEYFRAMED contrast through verbatim, so it still animates', () => {
    const kfs = [kf(0, 0), kf(2, 0.6)]
    const out = migrateClipEffects(clip({ effects: [bc({ brightness: 0, contrast: { value: 0, keyframes: kfs } })] }))
    expect(out.effects[0].type).toBe('contrast')
    expect(resolveEffect(out.effects[0], 1)!.params.contrast).toBeCloseTo(0.3)
  })

  it('carries `enabled: false` through, so a muted grade stays muted', () => {
    const off = { ...bc({ brightness: 0, contrast: 0.1 }), enabled: false }
    expect(migrateClipEffects(clip({ effects: [off] })).effects[0].enabled).toBe(false)
  })

  it('is idempotent: a second pass changes nothing and returns the same object', () => {
    const once = migrateClipEffects(clip({ effects: [bc({ brightness: 0, contrast: 0.1 })] }))
    expect(migrateClipEffects(once)).toBe(once)
  })

  // This is the case the punch grade deposits on every clip it has ever
  // touched. Without the rewrite, hasJettismGrade (lookActions.ts) stops
  // recognising those clips and a second click stacks the grade twice.
  it('turns the punch grade signature into the one jettismGradeEffects emits today', () => {
    const graded = clip({
      effects: [
        { id: 'e', type: 'exposure', params: { exposure: 0.1 }, enabled: true },
        bc({ brightness: 0, contrast: 0.1 }),
        { id: 's', type: 'saturation', params: { saturation: 0.13 }, enabled: true },
      ],
    })
    const out = migrateClipEffects(graded)
    expect(out.effects.map((e) => e.type)).toEqual(['exposure', 'contrast', 'saturation'])
    expect(JSON.stringify(out.effects[1].params)).toBe(JSON.stringify({ contrast: 0.1 }))
  })
})

describe('the ancient `filters` bag still lands on the ADDITIVE effect', () => {
  // THE TRAP THIS GUARDS. `filters.brightness` was written for the pre-registry
  // shader, where it ADDED. The live `brightness` channel now addresses the
  // multiplicative effect, where the same 0.3 means a 1.23x gain instead of a
  // +0.3 lift. If migrate.ts ever sources its addresses from CHANNEL_EFFECT
  // again, every project he saved before the effect stack existed is silently
  // regraded, and this test is what catches it.
  it('routes a static additive brightness to brightnessContrast, not to brightness', () => {
    const out = migrateClipEffects(clip({ filters: { brightness: 0.3 } }))
    expect(out.effects).toHaveLength(1)
    expect(out.effects[0].type).toBe('brightnessContrast')
    expect(out.effects[0].params.brightness).toBe(0.3)
    expect(out.filters).toBeUndefined()
  })

  it('routes animated brightness keyframes there too, and sheds the channel', () => {
    const out = migrateClipEffects(clip({ keyframes: { brightness: [kf(0, 0), kf(2, 0.4)] } }))
    expect(out.effects[0].type).toBe('brightnessContrast')
    expect(resolveEffect(out.effects[0], 1)!.params.brightness).toBeCloseTo(0.2)
    expect(out.keyframes?.brightness).toBeUndefined()
  })

  it('gives an ancient contrast-only bag a clean modern Contrast card', () => {
    // The filters pass produces brightnessContrast { brightness: 0, contrast },
    // and the split then rewrites it. Free, by the same shader identity.
    const out = migrateClipEffects(clip({ filters: { contrast: 0.25 } }))
    expect(out.effects).toEqual([{ id: 'fx_brightnessContrast', type: 'contrast', params: { contrast: 0.25 }, enabled: true }])
  })

  it('leaves the rest of the bag routed exactly where it always went', () => {
    const out = migrateClipEffects(clip({ filters: { exposure: 0.5, gain: 0.2, saturation: -0.3, blur: 4 } }))
    expect(out.effects.map((e) => e.type)).toEqual(['exposure', 'colorWheels', 'saturation', 'gaussianBlur'])
  })

  it('a clip with no colour state at all comes back untouched, by identity', () => {
    const c = clip()
    expect(migrateClipEffects(c)).toBe(c)
  })
})
