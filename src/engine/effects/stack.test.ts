import { describe, expect, it } from 'vitest'

import { NEUTRAL_FILTERS, type ResolvedFilters } from '../render/types'
import { resolvedFiltersToStack, stackSignature } from './registry'

const f = (over: Partial<ResolvedFilters> = {}): ResolvedFilters => ({ ...NEUTRAL_FILTERS, ...over })

describe('resolvedFiltersToStack', () => {
  it('an ungraded clip compiles to the identity stack (one program, no effects)', () => {
    expect(resolvedFiltersToStack(NEUTRAL_FILTERS)).toEqual([])
    expect(stackSignature(resolvedFiltersToStack(NEUTRAL_FILTERS))).toBe('')
  })

  it('emits only the effects whose sampled value left neutral', () => {
    expect(resolvedFiltersToStack(f({ saturation: -1 }))).toEqual([
      { type: 'saturation', params: { saturation: -1 } },
    ])
  })

  it('holds the frozen LAYER_FS math order regardless of which filters moved', () => {
    const all = f({
      exposure: 0.1,
      lift: 0.1,
      gamma: 0.1,
      gain: 0.1,
      temperature: 0.1,
      tint: 0.1,
      brightness: 0.1,
      contrast: 0.1,
      saturation: 0.1,
      blur: 4,
    })
    expect(stackSignature(resolvedFiltersToStack(all))).toBe(
      'exposure|colorWheels|whiteBalance|brightnessContrast|saturation|gaussianBlur',
    )
  })

  it('groups multi-param effects rather than emitting one effect per filter key', () => {
    // lift+gamma+gain are ONE ASC-CDL op, not three: splitting them would change
    // the math (each would re-apply the power curve).
    const stack = resolvedFiltersToStack(f({ lift: 0.2, gamma: -0.3, gain: 0.1 }))
    expect(stack).toHaveLength(1)
    expect(stack[0]).toEqual({ type: 'colorWheels', params: { lift: 0.2, gamma: -0.3, gain: 0.1 } })
  })

  it('carries an effect whose sibling params stay neutral', () => {
    expect(resolvedFiltersToStack(f({ contrast: 0.5 }))).toEqual([
      { type: 'brightnessContrast', params: { brightness: 0, contrast: 0.5 } },
    ])
  })

  it('routes blur to the neighborhood pass and never into the color chain', () => {
    const stack = resolvedFiltersToStack(f({ blur: 8, saturation: 0.5 }))
    expect(stack.map((e) => e.type)).toEqual(['saturation', 'gaussianBlur'])
    // blur is always last: it must see the fully graded pixels.
    expect(stack[stack.length - 1].type).toBe('gaussianBlur')
  })

  it('a negative sampled value still counts as non-neutral', () => {
    expect(resolvedFiltersToStack(f({ exposure: -0.001 })).map((e) => e.type)).toEqual(['exposure'])
  })

  it('is pure: the same sampled filters always yield the same stack', () => {
    const x = f({ gain: 0.4, blur: 2 })
    expect(resolvedFiltersToStack(x)).toEqual(resolvedFiltersToStack(x))
  })
})
