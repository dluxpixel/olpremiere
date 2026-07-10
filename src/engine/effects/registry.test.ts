import { describe, expect, it } from 'vitest'

import type { ResolvedEffect } from '../render/types'
import type { ClipFilters, EffectInstance } from '../types'
import {
  CANONICAL_ORDER,
  EFFECTS,
  defaultParams,
  filtersToEffectStack,
  getEffect,
  isAnimated,
  isNeutral,
  resolveEffect,
  resolveEffectParams,
  stackSignature,
} from './registry'

const inst = (type: string, params: EffectInstance['params'], enabled = true): EffectInstance => ({
  id: `i_${type}`,
  type,
  params,
  enabled,
})

describe('registry integrity', () => {
  it('has unique effect types', () => {
    const types = EFFECTS.map((e) => e.type)
    expect(new Set(types).size).toBe(types.length)
  })

  it('CANONICAL_ORDER covers every registered effect exactly once', () => {
    expect([...CANONICAL_ORDER].sort()).toEqual(EFFECTS.map((e) => e.type).sort())
  })

  it('every pointwise effect ships GLSL; neighborhood effects do not need it', () => {
    for (const def of EFFECTS) {
      if (def.pass === 'pointwise') expect(def.glsl, `${def.type} must define glsl`).toBeTypeOf('function')
    }
  })

  it('every declared param is actually referenced by its shader body', () => {
    // Catches the silent bug where a param appears in the Inspector, is bound as
    // a uniform, and then does nothing because the GLSL never reads it.
    for (const def of EFFECTS) {
      if (!def.glsl) continue
      const asked = new Set<string>()
      def.glsl((key) => {
        asked.add(key)
        return `u_fx0_${key}`
      })
      for (const param of def.params) {
        expect(asked.has(param.key), `${def.type}.${param.key} is declared but never read by its GLSL`).toBe(true)
      }
    }
  })

  it('every param default sits inside its own min/max range', () => {
    for (const def of EFFECTS) {
      for (const param of def.params) {
        expect(param.default).toBeGreaterThanOrEqual(param.min)
        expect(param.default).toBeLessThanOrEqual(param.max)
      }
    }
  })

  it('getEffect resolves known types and rejects unknown ones', () => {
    expect(getEffect('saturation')?.label).toBe('Saturation')
    expect(getEffect('nope')).toBeUndefined()
  })
})

describe('defaultParams', () => {
  it('returns every param at its neutral value', () => {
    expect(defaultParams(getEffect('colorWheels')!)).toEqual({ lift: 0, gamma: 0, gain: 0 })
    expect(defaultParams(getEffect('gaussianBlur')!)).toEqual({ blur: 0 })
  })
})

describe('resolveEffectParams', () => {
  const wheels = getEffect('colorWheels')!

  it('passes static numbers straight through', () => {
    expect(resolveEffectParams(wheels, inst('colorWheels', { lift: 0.2, gamma: -0.1, gain: 0.5 }), 0)).toEqual({
      lift: 0.2,
      gamma: -0.1,
      gain: 0.5,
    })
  })

  it('falls back to the neutral default for params the instance omits', () => {
    expect(resolveEffectParams(wheels, inst('colorWheels', { lift: 0.2 }), 0)).toEqual({
      lift: 0.2,
      gamma: 0,
      gain: 0,
    })
  })

  it('samples a keyframed param at clip-local time, and holds past the ends', () => {
    const animated = inst('colorWheels', {
      lift: {
        keyframes: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 2, value: 1, ease: 'linear' },
        ],
      },
    })
    expect(resolveEffectParams(wheels, animated, 0).lift).toBeCloseTo(0)
    expect(resolveEffectParams(wheels, animated, 1).lift).toBeCloseTo(0.5)
    expect(resolveEffectParams(wheels, animated, 2).lift).toBeCloseTo(1)
    // Clamps rather than extrapolating.
    expect(resolveEffectParams(wheels, animated, -5).lift).toBeCloseTo(0)
    expect(resolveEffectParams(wheels, animated, 99).lift).toBeCloseTo(1)
  })

  it('drops params the registry does not declare', () => {
    const out = resolveEffectParams(wheels, inst('colorWheels', { lift: 0.2, bogus: 9 }), 0)
    expect(out).not.toHaveProperty('bogus')
  })
})

describe('resolveEffect', () => {
  it('resolves an enabled, known effect', () => {
    expect(resolveEffect(inst('saturation', { saturation: -1 }), 0)).toEqual({
      type: 'saturation',
      params: { saturation: -1 },
    })
  })

  it('returns null for a disabled effect', () => {
    expect(resolveEffect(inst('saturation', { saturation: -1 }, false), 0)).toBeNull()
  })

  it('returns null for an unknown type rather than throwing', () => {
    expect(resolveEffect(inst('timeWarp', {}), 0)).toBeNull()
  })
})

describe('isNeutral', () => {
  it('is true when every param sits at its default', () => {
    expect(isNeutral(inst('brightnessContrast', { brightness: 0, contrast: 0 }))).toBe(true)
    expect(isNeutral(inst('brightnessContrast', {}))).toBe(true)
  })

  it('is false as soon as one param moves', () => {
    expect(isNeutral(inst('brightnessContrast', { brightness: 0, contrast: 0.01 }))).toBe(false)
  })

  it('is false for a keyframed param even when it currently reads neutral', () => {
    expect(isNeutral(inst('brightnessContrast', { brightness: { keyframes: [{ t: 0, value: 0, ease: 'linear' }] } }))).toBe(
      false,
    )
  })

  it('treats an unknown effect as neutral so it cannot affect the render', () => {
    expect(isNeutral(inst('timeWarp', { amount: 5 }))).toBe(true)
  })
})

describe('filtersToEffectStack', () => {
  it('returns an empty stack for undefined or fully-neutral filters', () => {
    expect(filtersToEffectStack(undefined)).toEqual([])
    expect(filtersToEffectStack({})).toEqual([])
    const neutral: ClipFilters = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, blur: 0 }
    expect(filtersToEffectStack(neutral)).toEqual([])
  })

  it('emits only the effects whose params actually moved', () => {
    const stack = filtersToEffectStack({ saturation: -1 })
    expect(stack).toHaveLength(1)
    expect(stack[0]).toEqual({ id: 'fx_saturation', type: 'saturation', params: { saturation: -1 }, enabled: true })
  })

  it('routes each legacy key to the right effect and param', () => {
    const stack = filtersToEffectStack({ lift: 0.1, gamma: 0.2, gain: 0.3 })
    expect(stack).toHaveLength(1)
    expect(stack[0].type).toBe('colorWheels')
    expect(stack[0].params).toEqual({ lift: 0.1, gamma: 0.2, gain: 0.3 })
  })

  it('fills an effect\'s untouched siblings with their neutral value', () => {
    const stack = filtersToEffectStack({ brightness: 0.5 })
    expect(stack[0].params).toEqual({ brightness: 0.5, contrast: 0 })
  })

  it('preserves the frozen LAYER_FS math order', () => {
    const all: ClipFilters = {
      brightness: 0.1,
      contrast: 0.1,
      saturation: 0.1,
      exposure: 0.1,
      blur: 4,
      lift: 0.1,
      gamma: 0.1,
      gain: 0.1,
      temperature: 0.1,
      tint: 0.1,
    }
    expect(filtersToEffectStack(all).map((e) => e.type)).toEqual([
      'exposure',
      'colorWheels',
      'whiteBalance',
      'brightnessContrast',
      'saturation',
      'gaussianBlur',
    ])
  })

  it('is deterministic: same filters in, byte-identical stack out', () => {
    const f: ClipFilters = { exposure: 0.5, blur: 2 }
    expect(filtersToEffectStack(f)).toEqual(filtersToEffectStack(f))
    expect(filtersToEffectStack(f).map((e) => e.id)).toEqual(['fx_exposure', 'fx_gaussianBlur'])
  })

  it('never emits a neutral effect, so a migrated stack is identity-free', () => {
    for (const e of filtersToEffectStack({ exposure: 0.5, blur: 0, saturation: 0 })) {
      expect(isNeutral(e)).toBe(false)
    }
  })
})

describe('isAnimated', () => {
  it('discriminates keyframed params from static numbers', () => {
    expect(isAnimated(0.5)).toBe(false)
    expect(isAnimated(undefined)).toBe(false)
    expect(isAnimated(null)).toBe(false)
    expect(isAnimated({ keyframes: [] })).toBe(true)
  })
})

describe('stackSignature', () => {
  it('keys on type and order, not on param values', () => {
    const a: ResolvedEffect[] = [
      { type: 'exposure', params: { exposure: 0.1 } },
      { type: 'saturation', params: { saturation: 0.2 } },
    ]
    const b: ResolvedEffect[] = [
      { type: 'exposure', params: { exposure: 0.9 } },
      { type: 'saturation', params: { saturation: 0.8 } },
    ]
    expect(stackSignature(a)).toBe(stackSignature(b))
    expect(stackSignature([...a].reverse())).not.toBe(stackSignature(a))
    expect(stackSignature([])).toBe('')
  })
})
