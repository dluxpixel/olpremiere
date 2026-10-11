// The LUT effect as the registry sees it: what it is called, when it counts as
// doing nothing, what it carries into a render, and what happens to a copy of it.

import { describe, expect, it } from 'vitest'

import type { EffectInstance } from '../types'
import { copyEffects } from './presets'
import { addMenuRows } from './addMenu'
import { BROWSABLE_EFFECTS, CANONICAL_ORDER, EFFECTS, TOOL_EFFECTS, getEffect, isNeutral, resolveEffect, resolveStack, stackSignature } from './registry'
import { MAX_LUTS_PER_CLIP } from './lutShader'

const lutFx = (lut: string | undefined, amount: number | null = 1, enabled = true, id = `fx_${lut ?? 'none'}`): EffectInstance => ({
  id,
  type: 'lut',
  enabled,
  params: amount === null ? {} : { amount },
  ...(lut !== undefined ? { lut } : {}),
})

describe('the LUT effect', () => {
  it('is a pointwise colour effect with one Amount slider from 0 to 1', () => {
    const def = getEffect('lut')
    expect(def?.pass).toBe('pointwise')
    expect(def?.category).toBe('color')
    expect(def?.lut).toBe(true)
    expect(def?.params.map((p) => p.key)).toEqual(['amount'])
    expect(def?.params[0].min).toBe(0)
    expect(def?.params[0].max).toBe(1)
  })

  it('goes on at full strength when it is added, but a bare instance does nothing', () => {
    expect(getEffect('lut')?.initialParams).toEqual({ amount: 1 })
    expect(getEffect('lut')?.params[0].default).toBe(0)
  })

  it('has a place in the canonical order, after the colour fixes', () => {
    expect(CANONICAL_ORDER).toContain('lut')
    expect(CANONICAL_ORDER.indexOf('lut')).toBeGreaterThan(CANONICAL_ORDER.indexOf('vibrance'))
    expect(EFFECTS.filter((e) => e.type === 'lut')).toHaveLength(1)
  })

  it('reads its table through the four uniforms the renderer binds, and Amount mixes it in', () => {
    const asked: string[] = []
    const body = getEffect('lut')?.glsl?.((k) => {
      asked.push(k)
      return `U_${k}`
    })
    expect(asked).toEqual(expect.arrayContaining(['lut', 'lutInfo', 'lutMin', 'lutMax', 'amount']))
    expect(body).toContain('olpLut(U_lut, U_lutInfo, U_lutMin, U_lutMax, c)')
    expect(body).toContain('mix(c, lutOut, clamp(U_amount, 0.0, 1.0))')
  })

  it('shows in the Effects tab and the add menu like the other colour effects', () => {
    expect(getEffect('lut')?.hidden).toBeFalsy()
    expect(TOOL_EFFECTS.map((e) => e.type)).toContain('lut')
    expect(BROWSABLE_EFFECTS.map((e) => e.type)).toContain('lut')
    expect(addMenuRows('lut', []).some((r) => r.type === 'lut' && r.label === 'LUT')).toBe(true)
  })

  it('ships the lookup function once as a helper', () => {
    expect(getEffect('lut')?.glslHelpers?.[0]).toContain('vec3 olpLut(')
  })
})

describe('Amount 0 and no table', () => {
  it('Amount 0 is neutral, so it is left out and the picture passes through', () => {
    expect(isNeutral(lutFx('lut_a', 0))).toBe(true)
    expect(resolveStack([lutFx('lut_a', 0)], 0)).toEqual([])
  })

  it('an instance that never had an Amount is neutral too', () => {
    expect(isNeutral(lutFx('lut_a', null))).toBe(true)
  })

  it('any Amount above 0 draws', () => {
    expect(isNeutral(lutFx('lut_a', 0.01))).toBe(false)
    expect(resolveStack([lutFx('lut_a', 0.01)], 0)).toHaveLength(1)
  })

  it('a LUT with no table has nothing to draw and is dropped, however strong', () => {
    expect(resolveEffect(lutFx(undefined, 1), 0)).toBeNull()
    expect(resolveStack([lutFx(undefined, 1)], 0)).toEqual([])
  })

  it('a disabled LUT is dropped', () => {
    expect(resolveEffect(lutFx('lut_a', 1, false), 0)).toBeNull()
  })
})

describe('what a LUT carries into a render', () => {
  it('its table id and its Amount, and nothing else', () => {
    expect(resolveEffect(lutFx('lut_a', 0.4), 0)).toEqual({ type: 'lut', params: { amount: 0.4 }, lut: 'lut_a' })
  })

  it('an effect that is not a LUT carries no table field at all', () => {
    const r = resolveEffect({ id: 'e', type: 'exposure', enabled: true, params: { exposure: 1 } }, 0)
    expect(r).toEqual({ type: 'exposure', params: { exposure: 1 } })
    expect('lut' in (r ?? {})).toBe(false)
  })

  it('Amount can be keyframed and is read at the clip time', () => {
    const fx: EffectInstance = {
      ...lutFx('lut_a'),
      params: {
        amount: {
          value: 1,
          keyframes: [
            { t: 0, value: 0, ease: 'linear' },
            { t: 2, value: 1, ease: 'linear' },
          ],
        },
      },
    }
    expect(resolveEffect(fx, 1)?.params.amount).toBeCloseTo(0.5, 5)
  })

  it('two different tables make the same program, so a different LUT does not recompile', () => {
    const a = resolveStack([lutFx('lut_a')], 0)
    const b = resolveStack([lutFx('lut_b')], 0)
    expect(stackSignature(a)).toBe(stackSignature(b))
    expect(stackSignature(a)).toContain('lut')
  })

  it('a clip reads at most the cap of LUTs; the first ones win', () => {
    const many = Array.from({ length: MAX_LUTS_PER_CLIP + 3 }, (_, i) => lutFx(`lut_${i}`, 1, true, `fx${i}`))
    const stack = resolveStack(many, 0)
    expect(stack).toHaveLength(MAX_LUTS_PER_CLIP)
    expect(stack.map((fx) => fx.lut)).toEqual(many.slice(0, MAX_LUTS_PER_CLIP).map((fx) => fx.lut))
  })

  it('the cap counts LUTs only: other effects around them all stay', () => {
    const mixed: EffectInstance[] = []
    for (let i = 0; i < MAX_LUTS_PER_CLIP + 2; i++) {
      mixed.push(lutFx(`lut_${i}`, 1, true, `l${i}`))
      mixed.push({ id: `e${i}`, type: 'exposure', enabled: true, params: { exposure: 0.1 } })
    }
    const stack = resolveStack(mixed, 0)
    expect(stack.filter((fx) => fx.type === 'lut')).toHaveLength(MAX_LUTS_PER_CLIP)
    expect(stack.filter((fx) => fx.type === 'exposure')).toHaveLength(MAX_LUTS_PER_CLIP + 2)
  })
})

describe('copying a LUT effect', () => {
  it('copyEffects keeps the table, so a pasted clip or an applied preset still has its LUT', () => {
    let n = 0
    const copy = copyEffects([lutFx('lut_a', 0.7)], () => `new${n++}`)
    expect(copy).toHaveLength(1)
    expect(copy[0].lut).toBe('lut_a')
    expect(copy[0].id).toBe('new0')
    expect(copy[0].params).toEqual({ amount: 0.7 })
  })

  it('leaves no lut field on a copy of an effect that has none', () => {
    const copy = copyEffects([{ id: 'e', type: 'exposure', enabled: true, params: { exposure: 1 } }], () => 'x')
    expect('lut' in copy[0]).toBe(false)
  })
})
