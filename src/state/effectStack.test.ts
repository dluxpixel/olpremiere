// The whole-stack edits: reorder by drop, the A/B, and reset everything.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import {
  applyEffect,
  deleteEffect,
  rampEffect,
  reorderEffect,
  resetAllEffectParams,
  setAllEffectsEnabled,
  setEffectParamValue,
  toggleEffectEnabled,
} from './clipEdits'
import { updateActiveSequence, useStore } from './store'

const { show } = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

function seedClip(): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

/** A clip carrying three effects, in registry order of application. */
function seedStack(): { id: string; types: string[] } {
  const clip = seedClip()
  applyEffect(clip.id, 'gaussianBlur')
  applyEffect(clip.id, 'glow')
  applyEffect(clip.id, 'colorWheels')
  return { id: clip.id, types: clipById(clip.id).effects.map((e) => e.type) }
}

function lockTrackZero(): void {
  updateActiveSequence('lock', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
  }))
}

beforeEach(() => {
  show.mockClear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

// ⛔ The seeded order is NOT the order they were applied in: addEffect puts each
// one at its own canonical position in the stack. So every assertion below is
// written against the order the seed actually produced, which is also the point
// of the feature: a canonical position is not always the position he wants.
describe('reorderEffect', () => {
  it('drops an effect at the index it was dropped on', () => {
    const { id, types } = seedStack()
    const last = clipById(id).effects[2]
    reorderEffect(id, last.id, 0)
    expect(clipById(id).effects.map((e) => e.type)).toEqual([types[2], types[0], types[1]])
  })

  it('moves down as well as up', () => {
    const { id, types } = seedStack()
    const first = clipById(id).effects[0]
    reorderEffect(id, first.id, 2)
    expect(clipById(id).effects.map((e) => e.type)).toEqual([types[1], types[2], types[0]])
  })

  it('clamps an index past the end instead of dropping the effect', () => {
    // A drop that lands past the last card must still land. Losing an effect to
    // a sloppy drag would be the worst possible answer.
    const { id, types } = seedStack()
    const first = clipById(id).effects[0]
    reorderEffect(id, first.id, 99)
    expect(clipById(id).effects).toHaveLength(3)
    expect(clipById(id).effects[2].type).toBe(types[0])
  })

  it('does nothing for an id that is not in the stack', () => {
    const { id, types } = seedStack()
    reorderEffect(id, 'not-here', 0)
    expect(clipById(id).effects.map((e) => e.type)).toEqual(types)
  })
})

describe('setAllEffectsEnabled', () => {
  it('turns the whole look off and back on in one step each', () => {
    const { id } = seedStack()
    expect(clipById(id).effects.every((e) => e.enabled)).toBe(true)

    setAllEffectsEnabled(id, false)
    expect(clipById(id).effects.every((e) => !e.enabled)).toBe(true)
    // ONE undo step, not one per effect: undo must restore the whole look.
    useStore.getState().undo()
    expect(clipById(id).effects.every((e) => e.enabled)).toBe(true)
  })

  it('brings a half-off stack all the way on', () => {
    const { id } = seedStack()
    setAllEffectsEnabled(id, false)
    // One switched back by hand, so the stack is MIXED, which is the state that
    // used to need a click per card to sort out.
    toggleEffectEnabled(id, clipById(id).effects[1].id)
    expect(clipById(id).effects.filter((e) => e.enabled)).toHaveLength(1)

    setAllEffectsEnabled(id, true)
    expect(clipById(id).effects.every((e) => e.enabled)).toBe(true)
  })
})

// ⛔ A locked track refuses the edit and says "Track is locked" itself. Anything
// that ALSO announces the edit contradicts it, and an Undo button on that toast
// would roll back whatever he did before this instead.
describe('a locked track is never told an edit happened', () => {
  it('says nothing about a removal that did not happen', () => {
    const { id } = seedStack()
    const target = clipById(id).effects[0].id
    lockTrackZero()
    show.mockClear()

    deleteEffect(id, target)

    expect(clipById(id).effects).toHaveLength(3)
    const said = show.mock.calls.map((c) => String(c[0]))
    expect(said.some((m) => /removed/i.test(m))).toBe(false)
    expect(said.some((m) => /locked/i.test(m))).toBe(true)
    // And no toast carried an Undo, which is the dangerous half.
    expect(show.mock.calls.some((c) => c[2] !== undefined)).toBe(false)
  })

  it('says nothing about an ease that did not happen', () => {
    const { id } = seedStack()
    const target = clipById(id).effects[0].id
    lockTrackZero()
    show.mockClear()

    rampEffect(id, target, 'in', 0.5)

    const said = show.mock.calls.map((c) => String(c[0]))
    expect(said.some((m) => /eases/i.test(m))).toBe(false)
  })

  it('keeps a refused effect out of his recents', () => {
    const clip = seedClip()
    lockTrackZero()
    applyEffect(clip.id, 'gaussianBlur')
    expect(clipById(clip.id).effects).toHaveLength(0)
  })
})

describe('the toasts that SHOULD fire', () => {
  it('offers the undo when an effect really goes', () => {
    const { id } = seedStack()
    const target = clipById(id).effects[0].id
    show.mockClear()

    deleteEffect(id, target)

    expect(clipById(id).effects).toHaveLength(2)
    const call = show.mock.calls.find((c) => /removed/i.test(String(c[0])))
    expect(call).toBeDefined()
    expect(call?.[2]).toMatchObject({ label: 'Undo' })
  })

  it('names the length when an ease really lands', () => {
    const { id } = seedStack()
    const blur = clipById(id).effects.find((e) => e.type === 'gaussianBlur')!
    // ⛔ A param still on its default has nothing to ramp between, so Ease is a
    // no-op on a FRESH effect. Turn it up first, which is what the hint below
    // now tells him to do.
    setEffectParamValue(id, blur.id, 'blur', 24)
    show.mockClear()

    rampEffect(id, blur.id, 'in', 0.75)

    expect(show.mock.calls.some((c) => /eases in over 0.75s/.test(String(c[0])))).toBe(true)
  })

  it('explains the dead button instead of doing nothing quietly', () => {
    const { id } = seedStack()
    // Every param still at its default, which is how every effect arrives.
    const target = clipById(id).effects[0].id
    show.mockClear()

    rampEffect(id, target, 'in', 0.5)

    expect(show.mock.calls.some((c) => /turn the effect up first/i.test(String(c[0])))).toBe(true)
  })
})

describe('resetAllEffectParams', () => {
  it('returns every effect to its defaults in one undo step', () => {
    const { id } = seedStack()
    const blur = clipById(id).effects[0]
    const glow = clipById(id).effects[1]
    const blurDefault = blur.params['blur']
    setEffectParamValue(id, blur.id, 'blur', 32)
    setEffectParamValue(id, glow.id, 'amount', 0.9)
    expect(clipById(id).effects[0].params['blur']).not.toEqual(blurDefault)

    resetAllEffectParams(id)
    expect(clipById(id).effects[0].params['blur']).toEqual(blurDefault)
    // Still three effects: reset is not remove.
    expect(clipById(id).effects).toHaveLength(3)
  })
})
