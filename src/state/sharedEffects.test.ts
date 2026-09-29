// His ask, 2026-09-29: select every clip with Auto Color and change them all at once.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { paramKeyframes, resolveParam } from '../engine/effects/ops'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip, type Sequence } from '../engine/types'
import { applyEffect, toggleEffectParamKeyframes } from './clipEdits'
import {
  clipsWithEffect,
  firstOfType,
  removeSharedEffect,
  resetSharedEffectParam,
  selectClipsWithEffect,
  setSharedEffectEnabled,
  setSharedEffectParam,
  sharedEffectTypes,
  sharedEnabled,
  sharedParamValue,
} from './sharedEffects'
import { updateActiveSequence, useStore } from './store'

const { show } = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
const amountOf = (id: string): number => resolveParam(firstOfType(clipById(id), 'autoColor')!, 'amount', 0)

function seedClip(startS: number): string {
  const clip = newTitleClip(defaultTitleDef('x'), startS, 2)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)) }),
  )
  return clip.id
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  show.mockClear()
})

describe('select all with an effect', () => {
  it('selects exactly the clips carrying it', () => {
    const a = seedClip(0)
    const b = seedClip(2)
    const c = seedClip(4)
    applyEffect(a, 'autoColor')
    applyEffect(c, 'autoColor')
    applyEffect(b, 'gaussianBlur')
    expect(clipsWithEffect(seq(), 'autoColor').sort()).toEqual([a, c].sort())
    selectClipsWithEffect('autoColor')
    expect(useStore.getState().ui.selection.sort()).toEqual([a, c].sort())
    expect(show).toHaveBeenCalledWith('Selected the 2 clips with Auto Color', 'info')
  })
})

describe('the effects every selected clip shares', () => {
  it('lists only what ALL of them carry', () => {
    const a = seedClip(0)
    const b = seedClip(2)
    applyEffect(a, 'autoColor')
    applyEffect(a, 'gaussianBlur')
    applyEffect(b, 'autoColor')
    expect(sharedEffectTypes([clipById(a), clipById(b)])).toEqual(['autoColor'])
  })
})

describe('changing it on every clip at once', () => {
  it('sets the value on all of them, as ONE undo', () => {
    const ids = [seedClip(0), seedClip(2), seedClip(4)]
    for (const id of ids) applyEffect(id, 'autoColor')
    setSharedEffectParam(ids, 'autoColor', 'amount', 0.25)
    for (const id of ids) expect(amountOf(id)).toBeCloseTo(0.25, 6)
    // ONE undo puts all three back.
    expect(useStore.getState().undo()).toMatch(/Auto Color Amount on 3 clips/)
    for (const id of ids) expect(amountOf(id)).toBeCloseTo(0.6, 6)
  })

  it('reads mixed when the clips differ, and one change evens them out', () => {
    const ids = [seedClip(0), seedClip(2)]
    for (const id of ids) applyEffect(id, 'autoColor')
    setSharedEffectParam([ids[1]!], 'autoColor', 'amount', 0.9)
    const clips = ids.map(clipById)
    expect(sharedParamValue(clips, 'autoColor', 'amount', () => 0)).toEqual({ value: 0.6, mixed: true })
    setSharedEffectParam(ids, 'autoColor', 'amount', 0.4)
    expect(sharedParamValue(ids.map(clipById), 'autoColor', 'amount', () => 0)).toEqual({ value: 0.4, mixed: false })
  })

  it('never flattens a setting he keyframed on one clip: it keyframes it at the playhead there', () => {
    const [a, b] = [seedClip(0), seedClip(2)]
    applyEffect(a, 'autoColor')
    applyEffect(b, 'autoColor')
    toggleEffectParamKeyframes(a, firstOfType(clipById(a), 'autoColor')!.id, 'amount')
    const before = paramKeyframes(firstOfType(clipById(a), 'autoColor')!, 'amount').length
    setSharedEffectParam([a, b], 'autoColor', 'amount', 0.3)
    expect(paramKeyframes(firstOfType(clipById(a), 'autoColor')!, 'amount').length).toBeGreaterThanOrEqual(before)
    expect(amountOf(a)).toBeCloseTo(0.3, 6)
    expect(amountOf(b)).toBeCloseTo(0.3, 6)
  })

  it('resets, switches off and removes on all of them', () => {
    const ids = [seedClip(0), seedClip(2)]
    for (const id of ids) applyEffect(id, 'autoColor')
    resetSharedEffectParam(ids, 'autoColor', 'amount')
    for (const id of ids) expect(amountOf(id)).toBe(0)
    setSharedEffectEnabled(ids, 'autoColor', false)
    expect(sharedEnabled(ids.map(clipById), 'autoColor')).toBe('off')
    setSharedEffectEnabled(ids, 'autoColor', true)
    expect(sharedEnabled(ids.map(clipById), 'autoColor')).toBe('on')
    removeSharedEffect(ids, 'autoColor')
    for (const id of ids) expect(firstOfType(clipById(id), 'autoColor')).toBeUndefined()
  })
})
