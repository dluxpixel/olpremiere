import { describe, expect, it } from 'vitest'

import { defaultTransform, type Clip, type Curve, type Keyframe } from '../types'
import {
  channelBase,
  channelDefault,
  channelKeyframes,
  isChannelAnimated,
  resolveChannel,
  withChannelKeyframes,
  withChannelValue,
  withChannelsAtTime,
} from './channels'
import { migrateClipEffects } from './migrate'

const kf = (t: number, value: number, e: Keyframe['ease'] = 'linear'): Keyframe => ({ t, value, ease: e })

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c',
  assetId: 'a',
  startS: 5,
  inS: 0,
  outS: 4,
  speed: 1,
  enabled: true,
  transform: { ...defaultTransform(), x: 100, scale: 2, rotationDeg: 45 },
  opacity: 0.8,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...over,
})

describe('channelDefault', () => {
  it('knows the non-zero neutrals', () => {
    expect(channelDefault('scale')).toBe(1)
    expect(channelDefault('opacity')).toBe(1)
    expect(channelDefault('anchorX')).toBe(0.5)
    expect(channelDefault('posX')).toBe(0)
  })
  it('reads colour neutrals from the registry rather than a second list', () => {
    expect(channelDefault('brightness')).toBe(0)
    expect(channelDefault('blur')).toBe(0)
    expect(channelDefault('gamma')).toBe(0)
  })
})

describe('channelBase', () => {
  it('reads static transform / opacity straight off the clip', () => {
    const c = clip()
    expect(channelBase(c, 'posX')).toBe(100)
    expect(channelBase(c, 'scale')).toBe(2)
    expect(channelBase(c, 'rotation')).toBe(45)
    expect(channelBase(c, 'opacity')).toBe(0.8)
  })

  it('reads a colour channel out of the clip effect stack', () => {
    const c = clip({ effects: [{ id: 'x', type: 'gaussianBlur', params: { blur: 4 }, enabled: true }] })
    expect(channelBase(c, 'blur')).toBe(4)
  })

  it('returns the registry neutral when the effect is absent', () => {
    const c = clip()
    expect(channelBase(c, 'brightness')).toBe(0)
    expect(channelBase(c, 'saturation')).toBe(0)
  })
})

describe('resolveChannel', () => {
  it('falls back to the static base when unanimated', () => {
    expect(resolveChannel(clip(), 'scale', 1)).toBe(2)
  })

  it('uses keyframes (LOCAL time) when a transform channel is animated', () => {
    const c = clip({ keyframes: { scale: [kf(0, 1), kf(2, 3)] } })
    expect(resolveChannel(c, 'scale', 0)).toBe(1)
    expect(resolveChannel(c, 'scale', 1)).toBeCloseTo(2)
    expect(resolveChannel(c, 'scale', 2)).toBe(3)
  })

  it('uses keyframes when a COLOUR channel is animated inside its effect param', () => {
    const c = clip({
      effects: [
        {
          id: 'x',
          type: 'brightnessContrast',
          params: { brightness: { value: 0, keyframes: [kf(0, 0), kf(2, 0.5)] }, contrast: 0 },
          enabled: true,
        },
      ],
    })
    expect(resolveChannel(c, 'brightness', 1)).toBeCloseTo(0.25)
    // Its sibling param stays static.
    expect(resolveChannel(c, 'contrast', 1)).toBe(0)
  })

  it('leaves an unrelated animated channel on the base for others', () => {
    const c = clip({ keyframes: { posX: [kf(0, 0), kf(1, 50)] } })
    expect(resolveChannel(c, 'posX', 0.5)).toBeCloseTo(25)
    expect(resolveChannel(c, 'scale', 0.5)).toBe(2)
  })
})

describe('isChannelAnimated', () => {
  it('reflects keyframes wherever they live', () => {
    expect(isChannelAnimated(clip(), 'scale')).toBe(false)
    expect(isChannelAnimated(clip({ keyframes: { scale: [kf(0, 1)] } }), 'scale')).toBe(true)
    expect(isChannelAnimated(clip({ keyframes: { scale: [] } }), 'scale')).toBe(false)
    const graded = clip({
      effects: [
        { id: 'x', type: 'saturation', params: { saturation: { value: 0, keyframes: [kf(0, 1)] } }, enabled: true },
      ],
    })
    expect(isChannelAnimated(graded, 'saturation')).toBe(true)
  })
})

describe('withChannelValue', () => {
  it('writes transform channels onto the clip, not the stack', () => {
    const c = withChannelValue(clip(), 'scale', 3)
    expect(c.transform.scale).toBe(3)
    expect(c.effects).toEqual([])
  })

  it('MATERIALISES a colour effect on the first non-neutral write', () => {
    const c = withChannelValue(clip(), 'saturation', -1)
    expect(c.effects).toHaveLength(1)
    expect(c.effects[0]).toMatchObject({ type: 'saturation', params: { saturation: -1 }, enabled: true })
  })

  it('EVAPORATES the effect when it returns to neutral, leaving no no-op behind', () => {
    let c = withChannelValue(clip(), 'saturation', -1)
    expect(c.effects).toHaveLength(1)
    c = withChannelValue(c, 'saturation', 0)
    expect(c.effects).toEqual([])
  })

  it('never materialises an effect for a neutral write', () => {
    expect(withChannelValue(clip(), 'brightness', 0).effects).toEqual([])
  })

  it('keeps an effect alive while any sibling param is non-neutral', () => {
    let c = withChannelValue(clip(), 'brightness', 0.5)
    c = withChannelValue(c, 'contrast', 0.5)
    expect(c.effects).toHaveLength(1)
    c = withChannelValue(c, 'brightness', 0)
    expect(c.effects).toHaveLength(1)
    expect(c.effects[0].params).toEqual({ brightness: 0, contrast: 0.5 })
  })

  it('inserts effects so canonical math order is preserved regardless of write order', () => {
    // Write them backwards; the stack must still read exposure -> ... -> blur.
    let c = clip()
    c = withChannelValue(c, 'blur', 4)
    c = withChannelValue(c, 'saturation', 0.2)
    c = withChannelValue(c, 'brightness', 0.2)
    c = withChannelValue(c, 'temperature', 0.2)
    c = withChannelValue(c, 'gain', 0.2)
    c = withChannelValue(c, 'exposure', 0.2)
    expect(c.effects.map((e) => e.type)).toEqual([
      'exposure',
      'colorWheels',
      'whiteBalance',
      'brightnessContrast',
      'saturation',
      'gaussianBlur',
    ])
  })

  it('does not mutate the input clip', () => {
    const c = clip()
    withChannelValue(c, 'saturation', -1)
    expect(c.effects).toEqual([])
  })
})

describe('withChannelKeyframes', () => {
  it('animating a colour channel materialises its effect and stores keyframes in the param', () => {
    const c = withChannelKeyframes(clip(), 'brightness', [kf(0, 0), kf(1, 1)])
    expect(c.effects).toHaveLength(1)
    expect(channelKeyframes(c, 'brightness')).toHaveLength(2)
  })

  it('an animated-but-currently-zero param keeps its effect alive', () => {
    // isNeutral must not evaporate an effect just because the keyframes read 0 now.
    const c = withChannelKeyframes(clip(), 'brightness', [kf(0, 0)])
    expect(c.effects).toHaveLength(1)
  })

  it('de-animating collapses the param back to a static number holding the base', () => {
    // Regression: the animated form used to be {keyframes} with no `value`, so
    // turning the stopwatch off silently reset a graded param to neutral.
    let c = withChannelValue(clip(), 'brightness', 0.4)
    c = withChannelKeyframes(c, 'brightness', [kf(0, 0.4), kf(1, 0.9)])
    c = withChannelKeyframes(c, 'brightness', [])
    expect(channelKeyframes(c, 'brightness')).toEqual([])
    expect(channelBase(c, 'brightness')).toBe(0.4)
  })

  it('an animated param retains its pre-animation base while animated', () => {
    let c = withChannelValue(clip(), 'brightness', 0.4)
    c = withChannelKeyframes(c, 'brightness', [kf(0, 0), kf(1, 1)])
    expect(channelBase(c, 'brightness')).toBe(0.4)
    // ...but the resolved value still comes from the keyframes.
    expect(resolveChannel(c, 'brightness', 0.5)).toBeCloseTo(0.5)
  })

  it('de-animating a channel back to neutral evaporates the effect entirely', () => {
    let c = withChannelKeyframes(clip(), 'saturation', [kf(0, 0)])
    c = withChannelKeyframes(c, 'saturation', [])
    expect(c.effects).toEqual([])
  })

  it('transform keyframes still live on the clip', () => {
    const c = withChannelKeyframes(clip(), 'scale', [kf(0, 1)])
    expect(c.keyframes?.scale).toHaveLength(1)
    expect(c.effects).toEqual([])
  })
})

describe('withChannelsAtTime', () => {
  const SNAP: Curve = [0.16, 1, 0.3, 1]
  const snapCommit = { ease: 'linear' as const, curve: SNAP }

  it('pins the previous value at the nearest existing MOMENT, not at the head of the clip', () => {
    // The live defect: a drag four seconds in wrote t=0 and t=4, so the framing
    // crawled linearly across four whole seconds instead of moving where he
    // dragged. The moment is read across every channel, so the pin lands on the
    // scale keyframe already sitting at 3.5.
    const c = withChannelsAtTime(
      clip({ keyframes: { scale: [kf(0, 1), kf(3.5, 1.2)] } }),
      4,
      [['posX', 250]] as const,
      true,
      snapCommit,
    )
    const kfs = channelKeyframes(c, 'posX')
    expect(kfs.map((k) => k.t)).toEqual([3.5, 4])
    expect(kfs[0].value).toBe(100)
    expect(kfs[1].value).toBe(250)
  })

  it('falls back to the head only when the clip carries no earlier moment', () => {
    const c = withChannelsAtTime(clip(), 4, [['posX', 250]] as const, true, snapCommit)
    expect(channelKeyframes(c, 'posX').map((k) => k.t)).toEqual([0, 4])
  })

  it('writes the passed curve on the keyframe the move leaves FROM, not a hardcoded linear', () => {
    const armed = withChannelsAtTime(clip(), 4, [['scale', 1.2]] as const, true, snapCommit)
    expect(channelKeyframes(armed, 'scale')[0]).toMatchObject({ t: 0, curve: SNAP })

    // An already animated channel keyframes at the playhead carrying the same
    // shape, so the next move leaving that keyframe runs the curve too.
    const anim = withChannelsAtTime(
      clip({ keyframes: { scale: [kf(0, 1)] } }),
      2,
      [['scale', 1.4]] as const,
      true,
      snapCommit,
    )
    expect(channelKeyframes(anim, 'scale')[1]).toMatchObject({ t: 2, curve: SNAP })

    // A named ease with no curve travels the same way, and leaves no curve key
    // behind for the curve editor to draw a ghost handle from.
    const named = withChannelsAtTime(clip(), 4, [['scale', 1.2]] as const, true, { ease: 'easeOut' })
    expect(channelKeyframes(named, 'scale')[0].ease).toBe('easeOut')
    expect(channelKeyframes(named, 'scale')[0].curve).toBeUndefined()
  })

  it('writes the static base when the clip is not armed', () => {
    const c = withChannelsAtTime(clip(), 4, [['scale', 1.2]] as const, false, snapCommit)
    expect(c.transform.scale).toBe(1.2)
    expect(channelKeyframes(c, 'scale')).toEqual([])
  })
})

describe('migrateClipEffects', () => {
  it('is a no-op for a clip with no colour state, and sheds the dead bag', () => {
    const c = migrateClipEffects(clip({ filters: {} }))
    expect(c.effects).toEqual([])
    expect(c.filters).toBeUndefined()
  })

  it('moves a static filters bag into the canonical stack', () => {
    const c = migrateClipEffects(clip({ filters: { lift: 0.2, gamma: -0.3, gain: 0.1, temperature: 0.5, tint: -0.4 } }))
    expect(c.effects.map((e) => e.type)).toEqual(['colorWheels', 'whiteBalance'])
    expect(c.effects[0].params).toEqual({ lift: 0.2, gamma: -0.3, gain: 0.1 })
    expect(c.effects[1].params).toEqual({ temperature: 0.5, tint: -0.4 })
    expect(c.filters).toBeUndefined()
  })

  it('moves animated colour channels into their effect params and clears them off the clip', () => {
    const c = migrateClipEffects(clip({ keyframes: { brightness: [kf(0, 0), kf(2, 0.5)] } }))
    expect(c.keyframes?.brightness).toBeUndefined()
    expect(resolveChannel(c, 'brightness', 1)).toBeCloseTo(0.25)
  })

  it('preserves the resolved value across the migration, static and animated alike', () => {
    const legacy = clip({ filters: { saturation: -0.5, blur: 8 }, keyframes: { brightness: [kf(0, 0), kf(2, 0.5)] } })
    const migrated = migrateClipEffects(legacy)
    expect(resolveChannel(migrated, 'saturation', 1)).toBe(-0.5)
    expect(resolveChannel(migrated, 'blur', 1)).toBe(8)
    expect(resolveChannel(migrated, 'brightness', 1)).toBeCloseTo(0.25)
  })

  it('leaves transform keyframes untouched', () => {
    const c = migrateClipEffects(clip({ filters: { blur: 2 }, keyframes: { scale: [kf(0, 1), kf(1, 2)] } }))
    expect(c.keyframes?.scale).toHaveLength(2)
    expect(resolveChannel(c, 'scale', 0.5)).toBeCloseTo(1.5)
  })

  it('is idempotent: migrating twice changes nothing', () => {
    const once = migrateClipEffects(clip({ filters: { saturation: -0.5 } }))
    expect(migrateClipEffects(once)).toEqual(once)
  })

  it('never touches a clip that already has an effect stack', () => {
    const c = clip({ effects: [{ id: 'x', type: 'saturation', params: { saturation: -1 }, enabled: true }] })
    expect(migrateClipEffects(c).effects).toEqual(c.effects)
  })
})
