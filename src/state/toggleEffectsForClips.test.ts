// @vitest-environment jsdom
//
// Shift+B switches the effects of the WHOLE selection, in one undo step.
//
// MEASURED 2026-10-06: three pictures with Auto Color selected, Shift+B, only
// the first went off. With the linked sound picked first it did nothing at all.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ shown: [] as string[] }))
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (m: string) => toasts.shown.push(m) }) },
}))

import { buildAppBindings } from '../App'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
} from '../engine/types'
import { keyTargetClipId, toggleEffectsForClips } from './bulkEdits'
import { updateActiveSequence, useStore } from './store'

const asset: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const autoColor = (id: string, enabled = true) => ({ id, type: 'autoColor' as const, params: {}, enabled })
const at = (id: string, startS: number, over: Partial<Clip> = {}): Clip => ({
  ...newClipFromAsset(asset, startS),
  id,
  inS: 0,
  outS: 1,
  ...over,
})
const seq = () => activeSequence(useStore.getState().project)
const on = (): Record<string, boolean[]> =>
  Object.fromEntries(seq().tracks.flatMap((t) => t.clips.map((c) => [c.id, c.effects.map((e) => e.enabled)])))

/** Three pictures on V1, each with Auto Color (p2's already off), a caption on V2, their sound on A1. */
function seed(lockV1 = false): void {
  useStore.getState().setProject({ ...newProject(), assets: { v: asset } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? {
              ...t,
              locked: lockV1,
              clips: [
                at('p1', 0, { linkId: 'L1', effects: [autoColor('e1')] }),
                at('p2', 1, { linkId: 'L2', effects: [autoColor('e2', false)] }),
                at('p3', 2, { linkId: 'L3', effects: [autoColor('e3')] }),
              ],
            }
          : i === 1
            ? { ...t, clips: [{ ...newTitleClip(defaultTitleDef('hi'), 0, 3), id: 'cap' }] }
            : i === 2
              ? { ...t, clips: [at('a1', 0, { linkId: 'L1' }), at('a2', 1, { linkId: 'L2' }), at('a3', 2, { linkId: 'L3' })] }
              : t,
      ),
    }),
  )
}

beforeEach(() => {
  toasts.shown.length = 0
  seed()
})

describe('toggleEffectsForClips (Shift+B on a selection)', () => {
  it('turns every effect off on ALL the selected pictures, then all back on, one undo each', () => {
    const picked = ['a1', 'p1', 'a2', 'p2', 'a3', 'p3']
    toggleEffectsForClips(picked)
    expect(on()).toMatchObject({ p1: [false], p2: [false], p3: [false], a1: [], a2: [], a3: [] })
    expect(toasts.shown).toEqual(['Effects off on 3 clips'])
    toggleEffectsForClips(picked)
    expect(on()).toMatchObject({ p1: [true], p2: [true], p3: [true] })
    expect(toasts.shown.at(-1)).toBe('Effects back on for 3 clips')
    useStore.getState().undo()
    expect(on()).toMatchObject({ p1: [false], p2: [false], p3: [false] })
    useStore.getState().undo()
    expect(on()).toMatchObject({ p1: [true], p2: [false], p3: [true] })
  })

  it('says why when nothing it picked carries an effect', () => {
    toggleEffectsForClips(['a1', 'cap'])
    expect(toasts.shown).toEqual(['No effects on the selected clips'])
  })

  it('names the clips a lock held back', () => {
    seed(true)
    toggleEffectsForClips(['p1', 'p3'])
    expect(on()).toMatchObject({ p1: [true], p3: [true] })
    expect(toasts.shown).toEqual(['2 clips are on a locked track and were left out'])
  })

  it('the Shift+B key reaches every selected clip, sound picked first or not', () => {
    useStore.getState().setUI({ selection: ['a1', 'p1', 'p2', 'p3'] })
    buildAppBindings().find((b) => b.combo === 'shift+b')!.run(new KeyboardEvent('keydown', { key: 'B', shiftKey: true }))
    expect(on()).toMatchObject({ p1: [false], p2: [false], p3: [false] })
  })
})

describe('keyTargetClipId (P, Shift+P, Alt+P, D, F on a selection)', () => {
  it('picks the selected picture under the playhead, not the caption or sound picked first', () => {
    expect(keyTargetClipId(seq(), ['cap', 'a2', 'p1', 'p2'], 1.5)).toBe('p2')
  })

  it('falls back to any selected clip under the playhead, then to the first one', () => {
    expect(keyTargetClipId(seq(), ['p3', 'cap'], 0.5)).toBe('cap')
    expect(keyTargetClipId(seq(), ['p3', 'p2'], 0.5)).toBe('p3')
    expect(keyTargetClipId(seq(), ['p3'], 0.5)).toBe('p3')
  })
})
