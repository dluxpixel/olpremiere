import { describe, expect, it } from 'vitest'

import { defaultTransform, type Clip, type EffectInstance } from '../engine/types'
import { paramChannel } from './EffectControls'

const effect = (id: string, type: string): EffectInstance => ({ id, type, enabled: true, params: {} })

const clip = (effects: EffectInstance[]): Clip => ({
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

describe('paramChannel', () => {
  it('addresses a param that a channel already names', () => {
    const blur = effect('e1', 'gaussianBlur')
    expect(paramChannel(clip([blur]), blur, 'blur')).toBe('blur')

    const wheels = effect('e2', 'colorWheels')
    const c = clip([wheels])
    expect(paramChannel(c, wheels, 'lift')).toBe('lift')
    expect(paramChannel(c, wheels, 'gamma')).toBe('gamma')
    expect(paramChannel(c, wheels, 'gain')).toBe('gain')
  })

  it('gives no lane to a param outside the channel addresses', () => {
    const glow = effect('e1', 'glow')
    expect(paramChannel(clip([glow]), glow, 'amount')).toBeNull()

    const blur = effect('e2', 'gaussianBlur')
    expect(paramChannel(clip([blur]), blur, 'nosuchparam')).toBeNull()
  })

  it('gives no lane to the SECOND copy of an effect, which the channel cannot reach', () => {
    // A channel resolves to the FIRST effect of its type, so a lane on the
    // second copy would silently retime the first one's keyframes.
    const first = effect('e1', 'gaussianBlur')
    const second = effect('e2', 'gaussianBlur')
    const c = clip([first, second])
    expect(paramChannel(c, first, 'blur')).toBe('blur')
    expect(paramChannel(c, second, 'blur')).toBeNull()
  })
})
