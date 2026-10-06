// The cinematic looks as effects: where they live, what they are called, how they
// are found, where they land in a stack, and what the renderer is handed.

import { describe, expect, it } from 'vitest'
import { newClipFromAsset, type Clip, type EffectInstance } from '../types'
import { makeAsset } from '../../components/timelineTestFixtures'
import { LOOKS, LOOK_START_AMOUNT, LOOK_TYPES, lookSpecOf, lookType } from './looks'
import { addEffect } from './ops'
import {
  BROWSABLE_EFFECTS,
  CANONICAL_ORDER,
  LOOK_EFFECTS,
  TOOL_EFFECTS,
  defaultParams,
  getEffect,
  isNeutral,
  resolveStack,
} from './registry'
import { filterEffects } from './search'
import { addMenuRows } from './addMenu'

const look = (type: string, amount: number, enabled = true): EffectInstance => ({
  id: `fx_${type}`,
  type,
  enabled,
  params: { amount },
})

function clip(effects: EffectInstance[] = []): Clip {
  const asset = makeAsset({ id: 'gym', name: 'IMG_2831.MOV', kind: 'video', durationS: 10, hasAudio: true, hasVideo: true, width: 1080, height: 1920 })
  return { ...newClipFromAsset(asset, 0), effects }
}

describe('the looks shelf', () => {
  it('has between eight and ten looks, each with its own plain name', () => {
    expect(LOOKS.length).toBeGreaterThanOrEqual(8)
    expect(LOOKS.length).toBeLessThanOrEqual(10)
    expect(new Set(LOOKS.map((l) => l.label)).size).toBe(LOOKS.length)
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length)
  })

  it('uses no dashes of any kind in a name or a description', () => {
    // Built from char codes so this file itself carries no long dash.
    const longDashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)
    for (const l of LOOK_EFFECTS) {
      expect(l.label, l.type).not.toMatch(longDashes)
      expect(l.label, l.type).not.toContain('-')
      expect(l.description, l.type).not.toMatch(longDashes)
    }
  })

  it('offers every look in the pickers, under Looks and not in the tools list', () => {
    for (const type of LOOK_TYPES) {
      const def = getEffect(type)!
      expect(def.category).toBe('look')
      expect(BROWSABLE_EFFECTS).toContain(def)
      expect(LOOK_EFFECTS).toContain(def)
      expect(TOOL_EFFECTS).not.toContain(def)
    }
    expect(LOOK_EFFECTS.map((e) => e.type)).toEqual([...LOOK_TYPES])
  })

  it('keeps the names saved projects point at', () => {
    expect(LOOK_TYPES).toEqual([
      'lookMoodyGym',
      'lookTealOrange',
      'lookFilm800T',
      'lookKodakFilm',
      'lookGritty',
      'lookBlackWhite',
      'lookGoldenHour',
      'lookColdSteel',
      'lookBronze',
      'lookSoftFilm',
    ])
    for (const type of LOOK_TYPES) expect(lookType(lookSpecOf(type)!)).toBe(type)
  })

  it('lists every look in the render order, between his colour fixes and the vignette', () => {
    const order = CANONICAL_ORDER as readonly string[]
    for (const type of LOOK_TYPES) {
      expect(order.indexOf(type)).toBeGreaterThan(order.indexOf('saturation'))
      expect(order.indexOf(type)).toBeLessThan(order.indexOf('vignette'))
    }
  })

  it('has one slider, Amount, that drops at the full look and resets to nothing', () => {
    for (const type of LOOK_TYPES) {
      const def = getEffect(type)!
      expect(def.params.map((p) => p.key)).toEqual(['amount'])
      expect(def.params[0]).toMatchObject({ label: 'Amount', min: 0, max: 1, default: 0 })
      expect(def.initialParams).toEqual({ amount: LOOK_START_AMOUNT })
      expect(isNeutral(look(type, 0))).toBe(true)
      expect(isNeutral(look(type, LOOK_START_AMOUNT))).toBe(false)
      expect(defaultParams(def)).toEqual({ amount: 0 })
    }
  })
})

describe('finding a look', () => {
  const found = (q: string): string[] => filterEffects(q, LOOK_EFFECTS).map((e) => e.type)

  it('by the plain words he would type', () => {
    expect(found('gym')).toContain('lookMoodyGym')
    expect(found('moody')).toEqual(['lookMoodyGym'])
    expect(found('teal')).toContain('lookTealOrange')
    expect(found('black and white')).toContain('lookBlackWhite')
    expect(found('golden')).toEqual(['lookGoldenHour'])
    expect(found('300')).toEqual(['lookBronze'])
  })

  it('by the film it copies', () => {
    expect(found('800t')).toEqual(['lookFilm800T'])
    expect(found('cinestill')).toEqual(['lookFilm800T'])
    expect(found('kodak')).toEqual(expect.arrayContaining(['lookKodakFilm']))
    expect(found('bleach')).toEqual(['lookGritty'])
    expect(found('eterna')).toEqual(['lookSoftFilm'])
    expect(found('film').length).toBeGreaterThanOrEqual(4)
  })

  it('all of them by "look" or "filter" or "cinematic"', () => {
    expect(found('look')).toHaveLength(LOOKS.length)
    expect(found('filter')).toHaveLength(LOOKS.length)
    expect(found('cinematic')).toHaveLength(LOOKS.length)
  })

  it('in the Inspector Add effect menu too, through the same search', () => {
    const rows = addMenuRows('teal', [])
    expect(rows.map((r) => r.type)).toContain('lookTealOrange')
  })

  it('never takes the word bloom, which the add menu promises to Glow alone', () => {
    expect(found('bloom')).toEqual([])
  })
})

describe('putting a look on a clip', () => {
  it('lands at the full look', () => {
    const c = addEffect(clip(), 'lookMoodyGym', 'a')
    expect(c.effects).toEqual([{ id: 'a', type: 'lookMoodyGym', enabled: true, params: { amount: 1 } }])
  })

  it('goes after his own colour fixes and before a vignette or a blur', () => {
    let c = clip()
    c = addEffect(c, 'saturation', 's')
    c = addEffect(c, 'vignette', 'v')
    c = addEffect(c, 'gaussianBlur', 'b')
    c = addEffect(c, 'lookFilm800T', 'l')
    expect(c.effects.map((e) => e.id)).toEqual(['s', 'l', 'v', 'b'])
  })
})

describe('what the renderer is handed', () => {
  it('a look, then the passes it needs, all scaled by its Amount', () => {
    const stack = resolveStack([look('lookFilm800T', 0.5)], 0)
    expect(stack.map((e) => e.type)).toEqual(['lookFilm800T', 'lookGlow', 'lookGlow'])
    expect(stack[0].params).toEqual({ amount: 0.5 })
    const film = lookSpecOf('lookFilm800T')!
    expect(stack[1].params.strength).toBeCloseTo(film.halation!.strength * 0.5, 6)
    expect(stack[2].params.strength).toBeCloseTo(film.bloom!.strength * 0.5, 6)
  })

  it('a clarity pass for the muscle looks', () => {
    for (const type of ['lookMoodyGym', 'lookGritty', 'lookBlackWhite', 'lookBronze', 'lookColdSteel']) {
      expect(resolveStack([look(type, 1)], 0).map((e) => e.type), type).toContain('lookClarity')
    }
  })

  it('nothing for a look at Amount 0 or switched off', () => {
    expect(resolveStack([look('lookFilm800T', 0)], 0)).toEqual([])
    expect(resolveStack([look('lookFilm800T', 1, false)], 0)).toEqual([])
  })

  it('every look and pass as an effect the renderer knows, pointwise colour then neighbour passes', () => {
    for (const type of LOOK_TYPES) {
      const stack = resolveStack([look(type, 1)], 0)
      expect(getEffect(stack[0].type)!.pass).toBe('pointwise')
      for (const e of stack.slice(1)) {
        expect(getEffect(e.type)!.pass, e.type).toBe('neighborhood')
        expect(getEffect(e.type)!.hidden, e.type).toBe(true)
      }
    }
  })

  it('the same list for the same clip every time, so preview and export agree', () => {
    const effects = LOOK_TYPES.map((t) => look(t, 0.7))
    expect(resolveStack(effects, 1.25)).toEqual(resolveStack(effects, 1.25))
  })

  it('leaves every stack without a look exactly as it was', () => {
    const effects: EffectInstance[] = [
      { id: 'a', type: 'saturation', enabled: true, params: { saturation: 0.2 } },
      { id: 'b', type: 'glow', enabled: true, params: { intensity: 1 } },
      { id: 'c', type: 'contrast', enabled: true, params: { contrast: 0 } },
    ]
    expect(resolveStack(effects, 0)).toEqual([
      { type: 'saturation', params: { saturation: 0.2 } },
      { type: 'glow', params: { intensity: 1, radius: 24, threshold: 0.6 } },
    ])
  })
})
