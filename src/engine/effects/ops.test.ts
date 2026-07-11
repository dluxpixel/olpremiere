import { describe, expect, it } from 'vitest'

import { defaultTransform, type Clip, type EffectInstance, type Keyframe } from '../types'
import {
  addEffect,
  addEffectParamKeyframe,
  isParamAnimated,
  moveEffect,
  paramBase,
  paramKeyframes,
  removeEffect,
  removeEffectParamKeyframe,
  resetEffect,
  resolveParam,
  setEffectParam,
  setEffectParamEase,
  toggleEffect,
  toggleEffectParamAnimation,
} from './ops'

const kf = (t: number, value: number, e: Keyframe['ease'] = 'linear'): Keyframe => ({ t, value, ease: e })

const clip = (effects: EffectInstance[] = []): Clip => ({
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
  effects,
})

const types = (c: Clip): string[] => c.effects.map((e) => e.type)

describe('addEffect', () => {
  it('applies an effect at its neutral defaults', () => {
    const c = addEffect(clip(), 'gaussianBlur', 'e1')
    expect(c.effects).toEqual([{ id: 'e1', type: 'gaussianBlur', params: { blur: 0 }, enabled: true }])
  })

  it('does NOT evaporate a user-applied effect that sits at its defaults', () => {
    // The channel adapter drops neutral effects; an explicit apply must not.
    expect(addEffect(clip(), 'saturation', 'e1').effects).toHaveLength(1)
  })

  it('rejects an unknown effect type rather than storing it', () => {
    expect(addEffect(clip(), 'timeWarp', 'e1').effects).toEqual([])
  })

  it('seeds initialParams so Auto Color applies visibly on drop, but resets to identity', () => {
    const c = addEffect(clip(), 'autoColor', 'e1')
    const inst = c.effects[0]
    expect(inst.params).toEqual({ amount: 0.6 }) // applied at strength, not neutral 0
    // Reset returns it to the neutral default (identity), not the applied value.
    expect(resetEffect(c, 'e1').effects[0].params).toEqual({ amount: 0 })
  })

  it('inserts canonical effects in frozen math order whatever the apply order', () => {
    let c = clip()
    c = addEffect(c, 'gaussianBlur', 'e1')
    c = addEffect(c, 'exposure', 'e2')
    c = addEffect(c, 'saturation', 'e3')
    c = addEffect(c, 'colorWheels', 'e4')
    expect(types(c)).toEqual(['exposure', 'colorWheels', 'saturation', 'gaussianBlur'])
  })

  it('allows the same effect twice, with distinct ids', () => {
    let c = addEffect(clip(), 'gaussianBlur', 'e1')
    c = addEffect(c, 'gaussianBlur', 'e2')
    expect(types(c)).toEqual(['gaussianBlur', 'gaussianBlur'])
    expect(c.effects.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('does not mutate the input clip', () => {
    const c = clip()
    addEffect(c, 'saturation', 'e1')
    expect(c.effects).toEqual([])
  })
})

describe('removeEffect / toggleEffect', () => {
  it('removes by id and returns the same object when nothing matched', () => {
    const c = addEffect(clip(), 'saturation', 'e1')
    expect(removeEffect(c, 'e1').effects).toEqual([])
    expect(removeEffect(c, 'nope')).toBe(c)
  })

  it('toggles enabled without touching params', () => {
    const c = toggleEffect(addEffect(clip(), 'saturation', 'e1'), 'e1')
    expect(c.effects[0].enabled).toBe(false)
    expect(c.effects[0].params).toEqual({ saturation: 0 })
    expect(toggleEffect(c, 'e1').effects[0].enabled).toBe(true)
  })
})

describe('moveEffect', () => {
  const stacked = (): Clip => {
    let c = addEffect(clip(), 'exposure', 'a')
    c = addEffect(c, 'saturation', 'b')
    c = addEffect(c, 'gaussianBlur', 'c')
    return c
  }

  it('moves an effect one slot each way', () => {
    expect(types(moveEffect(stacked(), 'b', -1))).toEqual(['saturation', 'exposure', 'gaussianBlur'])
    expect(types(moveEffect(stacked(), 'b', 1))).toEqual(['exposure', 'gaussianBlur', 'saturation'])
  })

  it('is a no-op at the ends and for an unknown id', () => {
    const c = stacked()
    expect(moveEffect(c, 'a', -1)).toBe(c)
    expect(moveEffect(c, 'c', 1)).toBe(c)
    expect(moveEffect(c, 'nope', 1)).toBe(c)
  })

  it('lets the user override canonical order once applied', () => {
    // Reordering is the whole point of a stack: blur before the grade is a
    // different (and legitimate) picture than blur after it.
    expect(types(moveEffect(stacked(), 'c', -1))).toEqual(['exposure', 'gaussianBlur', 'saturation'])
  })
})

describe('resetEffect', () => {
  it('returns every param to neutral and drops keyframes', () => {
    let c = addEffect(clip(), 'brightnessContrast', 'e1')
    c = setEffectParam(c, 'e1', 'contrast', 0.5, 0)
    c = toggleEffectParamAnimation(c, 'e1', 'brightness', 0)
    c = resetEffect(c, 'e1')
    expect(c.effects[0].params).toEqual({ brightness: 0, contrast: 0 })
    expect(isParamAnimated(c.effects[0], 'brightness')).toBe(false)
  })

  it('keeps the effect applied', () => {
    const c = resetEffect(addEffect(clip(), 'saturation', 'e1'), 'e1')
    expect(c.effects).toHaveLength(1)
  })
})

describe('setEffectParam', () => {
  it('moves the static base when the param is not animated', () => {
    const c = setEffectParam(addEffect(clip(), 'saturation', 'e1'), 'e1', 'saturation', -0.5, 2)
    expect(c.effects[0].params.saturation).toBe(-0.5)
  })

  it('upserts a keyframe at the playhead when the param IS animated', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = setEffectParam(c, 'e1', 'saturation', 0.8, 1)
    expect(paramKeyframes(c.effects[0], 'saturation')).toEqual([kf(0, 0), kf(1, 0.8)])
  })

  it('is a no-op for an unknown effect id', () => {
    const c = addEffect(clip(), 'saturation', 'e1')
    expect(setEffectParam(c, 'nope', 'saturation', 1, 0)).toBe(c)
  })
})

describe('toggleEffectParamAnimation', () => {
  it('seeds a keyframe holding the current value', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = setEffectParam(c, 'e1', 'saturation', -0.5, 0)
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 1.5)
    expect(paramKeyframes(c.effects[0], 'saturation')).toEqual([kf(1.5, -0.5)])
  })

  it('de-animating restores the base rather than snapping to neutral', () => {
    // The data-loss bug this model exists to prevent.
    let c = addEffect(clip(), 'saturation', 'e1')
    c = setEffectParam(c, 'e1', 'saturation', -0.5, 0)
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = setEffectParam(c, 'e1', 'saturation', 0.9, 2) // keyframe elsewhere
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    expect(isParamAnimated(c.effects[0], 'saturation')).toBe(false)
    expect(paramBase(c.effects[0], 'saturation')).toBe(-0.5)
  })
})

describe('keyframe add / remove / ease', () => {
  it('adds a keyframe capturing the resolved value at that time', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = setEffectParam(c, 'e1', 'saturation', 1, 2)
    c = addEffectParamKeyframe(c, 'e1', 'saturation', 1) // midpoint of 0 -> 1
    expect(paramKeyframes(c.effects[0], 'saturation').map((k) => k.value)).toEqual([0, 0.5, 1])
  })

  it('removes the keyframe nearest the playhead within tolerance', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = setEffectParam(c, 'e1', 'saturation', 1, 2)
    c = removeEffectParamKeyframe(c, 'e1', 'saturation', 2)
    expect(paramKeyframes(c.effects[0], 'saturation')).toHaveLength(1)
  })

  it('de-animates cleanly when the last keyframe is removed', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = setEffectParam(c, 'e1', 'saturation', -0.3, 0)
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = removeEffectParamKeyframe(c, 'e1', 'saturation', 0)
    expect(isParamAnimated(c.effects[0], 'saturation')).toBe(false)
    expect(paramBase(c.effects[0], 'saturation')).toBe(-0.3)
  })

  it('sets easing on the keyframe at a given time', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = setEffectParamEase(c, 'e1', 'saturation', 0, 'easeInOut')
    expect(paramKeyframes(c.effects[0], 'saturation')[0].ease).toBe('easeInOut')
  })
})

describe('resolveParam', () => {
  it('reads the static base when unanimated', () => {
    const c = setEffectParam(addEffect(clip(), 'saturation', 'e1'), 'e1', 'saturation', -0.5, 0)
    expect(resolveParam(c.effects[0], 'saturation', 99)).toBe(-0.5)
  })

  it('interpolates keyframes at clip-local time and clamps past the ends', () => {
    let c = addEffect(clip(), 'saturation', 'e1')
    c = toggleEffectParamAnimation(c, 'e1', 'saturation', 0)
    c = setEffectParam(c, 'e1', 'saturation', 1, 2)
    const inst = c.effects[0]
    expect(resolveParam(inst, 'saturation', 1)).toBeCloseTo(0.5)
    expect(resolveParam(inst, 'saturation', -5)).toBe(0)
    expect(resolveParam(inst, 'saturation', 99)).toBe(1)
  })

  it('falls back to the registry default for a param the instance omits', () => {
    const inst: EffectInstance = { id: 'e1', type: 'brightnessContrast', params: {}, enabled: true }
    expect(resolveParam(inst, 'contrast', 0)).toBe(0)
    expect(paramBase(inst, 'contrast')).toBe(0)
  })
})
