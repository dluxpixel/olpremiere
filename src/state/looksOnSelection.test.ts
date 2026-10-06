// A cinematic look on several selected clips lands on ALL of them.
//
// His standing ask, 2026-10-04: *"selecting multiple images and putting effects
// on them that actually apply to all of them."* The Looks shelf, the drop onto a
// selected clip and the multi Inspector all go through applyEffectToClips, so a
// look is held to exactly what every other effect is held to, on a real project
// of three clips, through the real actions.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectDropTargets } from '../components/effectDrop'
import { makeAsset } from '../components/timelineTestFixtures'
import { LOOK_TYPES } from '../engine/effects/looks'
import { resolveFrame } from '../engine/render/resolve'
import { addTrack, recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset, type Sequence } from '../engine/types'
import { applyEffectToAllClips, applyEffectToClips } from './bulkEdits'
import { updateActiveSequence, useStore } from './store'

const shown: { message: string; kind?: string }[] = []
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string, kind?: string) => shown.push({ message, kind }) }) },
}))
vi.mock('./persistence', () => ({ db: async () => ({}), getBlob: async () => null, putBlob: async () => {} }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const allClips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)
const clipById = (id: string): Clip => allClips().find((c) => c.id === id)!

const gymClip = (id: string): MediaAsset =>
  makeAsset({ id, name: `${id}.MOV`, kind: 'video', durationS: 5, hasAudio: false, hasVideo: true, width: 1080, height: 1920 })

/** Three gym clips stacked on V1, V2 and V3, all at 0 s, all selected. Returns their clip ids. */
function threeClips(): string[] {
  const assets = { a: gymClip('a'), b: gymClip('b'), c: gymClip('c') }
  useStore.getState().setProject({ ...newProject('gym'), assets })
  const ids: string[] = []
  updateActiveSequence('seed', (sq) => {
    const grown = addTrack(sq, 'video')
    const video = grown.tracks.filter((t) => t.kind === 'video')
    const clips: Clip[] = (['a', 'b', 'c'] as const).map((k) => newClipFromAsset(assets[k], 0))
    ids.push(...clips.map((c) => c.id))
    return recomputeDuration({
      ...grown,
      tracks: grown.tracks.map((t) => {
        const at = video.findIndex((v) => v.id === t.id)
        return at >= 0 && clips[at] ? { ...t, clips: [clips[at]!] } : t
      }),
    })
  })
  useStore.getState().setUI({ selection: ids })
  shown.length = 0
  return ids
}

beforeEach(() => {
  shown.length = 0
})

describe('a look on a selection', () => {
  it('goes on every selected clip, at the full look, in ONE undo step', () => {
    const ids = threeClips()
    expect(applyEffectToClips(ids, 'lookMoodyGym')).toBe(3)
    for (const id of ids) {
      expect(clipById(id).effects.map((e) => [e.type, e.params.amount])).toEqual([['lookMoodyGym', 1]])
    }
    expect(new Set(ids.map((id) => clipById(id).effects[0]!.id)).size).toBe(3)
    expect(shown.map((t) => t.message)).toEqual(['Added Moody Gym to 3 clips'])
    useStore.getState().undo()
    for (const id of ids) expect(clipById(id).effects).toHaveLength(0)
  })

  it('goes on all of them when dropped on one of them', () => {
    const ids = threeClips()
    expect(effectDropTargets(ids[1]!, ids)).toEqual(ids)
    applyEffectToClips(effectDropTargets(ids[1]!, ids), 'lookFilm800T')
    for (const id of ids) expect(clipById(id).effects[0]!.type).toBe('lookFilm800T')
  })

  it('goes on every clip from "Apply to every clip"', () => {
    const ids = threeClips()
    useStore.getState().setUI({ selection: [] })
    applyEffectToAllClips('lookBronze')
    for (const id of ids) expect(clipById(id).effects[0]!.type).toBe('lookBronze')
  })

  it('reaches the renderer on every clip, with its passes, from the one resolver both screens use', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookFilm800T')
    const frame = resolveFrame(seq(), 1)
    const layers = frame.ops.flatMap((op) => (op.type === 'layer' ? [op.layer] : []))
    expect(layers).toHaveLength(3)
    for (const layer of layers) expect(layer.effects.map((e) => e.type)).toEqual(['lookFilm800T', 'lookGlow', 'lookGlow'])
  })

  it('works for every look on the shelf', () => {
    for (const type of LOOK_TYPES) {
      const ids = threeClips()
      expect(applyEffectToClips(ids, type), type).toBe(3)
    }
  })
})
