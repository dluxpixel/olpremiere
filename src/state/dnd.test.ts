import { describe, expect, it } from 'vitest'

import { ASSET_MIME, EFFECT_MIME, TRANSITION_MIME, dragHasType, edgeForOffset } from './dnd'

describe('drag MIME types', () => {
  it('are distinct, so a drop target can tell them apart mid-drag', () => {
    expect(new Set([ASSET_MIME, EFFECT_MIME, TRANSITION_MIME]).size).toBe(3)
  })

  it('dragHasType matches only the exact type', () => {
    expect(dragHasType([EFFECT_MIME], EFFECT_MIME)).toBe(true)
    expect(dragHasType([ASSET_MIME], EFFECT_MIME)).toBe(false)
    expect(dragHasType([], EFFECT_MIME)).toBe(false)
  })
})

describe('edgeForOffset', () => {
  it('splits a clip at its midpoint', () => {
    expect(edgeForOffset(10, 100)).toBe('in')
    expect(edgeForOffset(49.9, 100)).toBe('in')
    expect(edgeForOffset(50, 100)).toBe('out')
    expect(edgeForOffset(90, 100)).toBe('out')
  })

  it('handles a degenerate zero-width clip without dividing by surprise', () => {
    expect(edgeForOffset(0, 0)).toBe('out')
  })
})
