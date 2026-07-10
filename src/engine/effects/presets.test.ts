import { describe, expect, it } from 'vitest'

import { defaultTransform, type Clip, type EffectInstance } from '../types'
import { applyPresetToClip, autoPresetName, copyEffects, presetFromClip } from './presets'

let n = 0
const idFor = (): string => `id-${n++}`

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

const sat = (v: number): EffectInstance => ({ id: 'e1', type: 'saturation', params: { saturation: v }, enabled: true })
const animated = (): EffectInstance => ({
  id: 'e2',
  type: 'brightnessContrast',
  params: { brightness: { value: 0.2, keyframes: [{ t: 0, value: 0, ease: 'linear' }] }, contrast: 0.1 },
  enabled: true,
})

describe('copyEffects', () => {
  it('assigns fresh ids and preserves order, enabled, and values', () => {
    const out = copyEffects([sat(-1), { ...animated(), enabled: false }], idFor)
    expect(out.map((e) => e.type)).toEqual(['saturation', 'brightnessContrast'])
    expect(out[0].id).not.toBe('e1')
    expect(out[1].enabled).toBe(false)
    expect(out[0].params.saturation).toBe(-1)
  })

  it('deep-copies keyframes: mutating the copy never touches the source', () => {
    const src = animated()
    const [copy] = copyEffects([src], idFor)
    const copiedParam = copy.params.brightness
    if (typeof copiedParam === 'number') throw new Error('expected animated param')
    copiedParam.keyframes.push({ t: 1, value: 1, ease: 'linear' })
    copiedParam.keyframes[0].value = 99
    const srcParam = src.params.brightness
    if (typeof srcParam === 'number') throw new Error('expected animated param')
    expect(srcParam.keyframes).toHaveLength(1)
    expect(srcParam.keyframes[0].value).toBe(0)
  })
})

describe('autoPresetName', () => {
  it('names from registry labels', () => {
    expect(autoPresetName([sat(-1)])).toBe('Saturation')
    expect(autoPresetName([sat(-1), animated()])).toBe('Saturation + Brightness & Contrast')
  })
  it('summarises long stacks', () => {
    const four = [sat(-1), animated(), sat(0.5), animated()]
    expect(autoPresetName(four)).toBe('Saturation + 3 more')
  })
  it('tolerates unknown types', () => {
    expect(autoPresetName([{ id: 'x', type: 'mystery', params: {}, enabled: true }])).toBe('mystery')
  })
})

describe('presetFromClip', () => {
  it('snapshots the stack with fresh ids and the given identity', () => {
    const p = presetFromClip(clip([sat(-0.5)]), 'p1', 123, idFor)!
    expect(p.id).toBe('p1')
    expect(p.createdAt).toBe(123)
    expect(p.name).toBe('Saturation')
    expect(p.effects[0].id).not.toBe('e1')
  })

  it('honours an explicit name, falling back on blank', () => {
    expect(presetFromClip(clip([sat(1)]), 'p', 0, idFor, 'My Look')!.name).toBe('My Look')
    expect(presetFromClip(clip([sat(1)]), 'p', 0, idFor, '   ')!.name).toBe('Saturation')
  })

  it('returns null for a clip with no effects', () => {
    expect(presetFromClip(clip(), 'p', 0, idFor)).toBeNull()
  })

  it('is a snapshot: later edits to the clip do not change the preset', () => {
    const c = clip([sat(-0.5)])
    const p = presetFromClip(c, 'p', 0, idFor)!
    c.effects[0].params.saturation = 1
    expect(p.effects[0].params.saturation).toBe(-0.5)
  })
})

describe('applyPresetToClip', () => {
  it('APPENDS after the existing stack rather than replacing it', () => {
    const p = presetFromClip(clip([animated()]), 'p', 0, idFor)!
    const target = clip([sat(-1)])
    const out = applyPresetToClip(target, p, idFor)
    expect(out.effects.map((e) => e.type)).toEqual(['saturation', 'brightnessContrast'])
    expect(out.effects[0].params.saturation).toBe(-1) // untouched
  })

  it('each application is independent: two applies share nothing', () => {
    const p = presetFromClip(clip([animated()]), 'p', 0, idFor)!
    const a = applyPresetToClip(clip(), p, idFor)
    const b = applyPresetToClip(clip(), p, idFor)
    expect(a.effects[0].id).not.toBe(b.effects[0].id)
    const pa = a.effects[0].params.brightness
    const pb = b.effects[0].params.brightness
    if (typeof pa === 'number' || typeof pb === 'number') throw new Error('expected animated')
    expect(pa.keyframes).not.toBe(pb.keyframes)
  })

  it('does not mutate the input clip', () => {
    const p = presetFromClip(clip([sat(1)]), 'p', 0, idFor)!
    const target = clip()
    applyPresetToClip(target, p, idFor)
    expect(target.effects).toEqual([])
  })
})
