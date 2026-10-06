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
import {
  activeSequence,
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type EffectInstance,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { applyEffectToAllClips, applyEffectToClips } from './bulkEdits'
import { applyEffect } from './clipEdits'
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

/** A caption on its own video track over the three clips, selected along with them. Returns its id. */
function withCaption(ids: string[]): string {
  const caption = newTitleClip(defaultTitleDef('LIGHT WEIGHT'), 0, 5)
  updateActiveSequence('caption', (sq) => {
    const grown = addTrack(sq, 'video')
    const empty = grown.tracks.find((t) => t.kind === 'video' && t.clips.length === 0)!
    return recomputeDuration({ ...grown, tracks: grown.tracks.map((t) => (t.id === empty.id ? { ...t, clips: [caption] } : t)) })
  })
  useStore.getState().setUI({ selection: [...ids, caption.id] })
  shown.length = 0
  return caption.id
}

/** Write a stack straight onto a clip, the way he could have arranged it by hand. */
function setStack(id: string, effects: EffectInstance[]): void {
  updateActiveSequence('arrange', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, effects } : c)) })),
  }))
}

const types = (id: string): string[] => clipById(id).effects.map((e) => e.type)

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

// Every look is designed against the raw footage, so two on one clip compound:
// Moody Gym twice turns mid grey near black and teal. A second look REPLACES the
// first, the way a second click of the punch grade never stacks it (lookActions.ts).
describe('a second look', () => {
  it('replaces the first on every clip, in the slot it held, in ONE undo step', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookMoodyGym')
    // On one clip he moved the vignette in front of the look and added a key after.
    const moody = clipById(ids[0]!).effects[0]!
    setStack(ids[0]!, [
      { id: 'v', type: 'vignette', enabled: true, params: { amount: 0.3 } },
      moody,
      { id: 'k', type: 'chromaKey', enabled: true, params: {} },
    ])
    shown.length = 0
    expect(applyEffectToClips(ids, 'lookTealOrange')).toBe(3)
    expect(types(ids[0]!)).toEqual(['vignette', 'lookTealOrange', 'chromaKey'])
    expect(types(ids[1]!)).toEqual(['lookTealOrange'])
    expect(types(ids[2]!)).toEqual(['lookTealOrange'])
    // The new look drops at its full Amount, as a fresh instance.
    expect(clipById(ids[0]!).effects[1]!.params.amount).toBe(1)
    expect(clipById(ids[0]!).effects[1]!.id).not.toBe(moody.id)
    expect(shown.map((t) => t.message)).toEqual(['Added Teal and Orange to 3 clips, in place of Moody Gym'])
    expect(useStore.getState().undo()).toBe('Apply Teal and Orange')
    expect(types(ids[0]!)).toEqual(['vignette', 'lookMoodyGym', 'chromaKey'])
    expect(types(ids[1]!)).toEqual(['lookMoodyGym'])
  })

  it('says what it swapped on a lone clip, whose old card just left the Inspector', () => {
    const ids = threeClips()
    applyEffectToClips([ids[0]!], 'lookMoodyGym')
    expect(shown).toEqual([])
    applyEffectToClips([ids[0]!], 'lookFilm800T')
    expect(types(ids[0]!)).toEqual(['lookFilm800T'])
    expect(shown.map((t) => t.message)).toEqual(['Swapped Moody Gym for Film 800T'])
  })

  it('does nothing at all when the clip already wears that look, and costs no undo step', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookMoodyGym')
    shown.length = 0
    expect(applyEffectToClips(ids, 'lookMoodyGym')).toBe(0)
    for (const id of ids) expect(types(id)).toEqual(['lookMoodyGym'])
    expect(shown.map((t) => t.message)).toEqual(['Those clips already have Moody Gym'])
    // The one step on the stack is still the first apply.
    expect(useStore.getState().undo()).toBe('Apply Moody Gym')
    for (const id of ids) expect(types(id)).toEqual([])
  })

  it('swaps only the clips that need it in a mixed selection, and says so', () => {
    const ids = threeClips()
    applyEffectToClips([ids[0]!], 'lookBronze')
    applyEffectToClips([ids[1]!], 'lookGritty')
    shown.length = 0
    expect(applyEffectToClips(ids, 'lookGritty')).toBe(2)
    for (const id of ids) expect(types(id)).toEqual(['lookGritty'])
    expect(shown.map((t) => t.message)).toEqual(['Added Gritty to 2 clips, in place of Bronze on 1. 1 already had it'])
  })

  it('replaces from "Apply to every clip" too', () => {
    const ids = threeClips()
    applyEffectToAllClips('lookMoodyGym')
    shown.length = 0
    applyEffectToAllClips('lookColdSteel')
    for (const id of ids) expect(types(id)).toEqual(['lookColdSteel'])
    expect(shown.map((t) => t.message)).toEqual(['Applied "Cold Steel" to 3 clips, in place of Moody Gym'])
  })

  it('replaces from the Inspector Add effect menu on one clip too', () => {
    const ids = threeClips()
    applyEffect(ids[0]!, 'lookMoodyGym')
    applyEffect(ids[0]!, 'lookGoldenHour')
    expect(types(ids[0]!)).toEqual(['lookGoldenHour'])
    expect(shown.map((t) => t.message)).toEqual(['Swapped Moody Gym for Golden Hour'])
    shown.length = 0
    applyEffect(ids[0]!, 'lookGoldenHour')
    expect(types(ids[0]!)).toEqual(['lookGoldenHour'])
    expect(shown.map((t) => t.message)).toEqual(['That clip already has Golden Hour'])
  })

  it('leaves a clip that stacked two looks before this rule with one', () => {
    const ids = threeClips()
    setStack(ids[0]!, [
      { id: 'a', type: 'lookMoodyGym', enabled: true, params: { amount: 1 } },
      { id: 's', type: 'saturation', enabled: true, params: { saturation: 0.2 } },
      { id: 'b', type: 'lookTealOrange', enabled: true, params: { amount: 1 } },
    ])
    applyEffectToClips([ids[0]!], 'lookSoftFilm')
    expect(types(ids[0]!)).toEqual(['lookSoftFilm', 'saturation'])
  })

  it('still lets an ordinary effect go on twice, as it always could', () => {
    const ids = threeClips()
    applyEffectToClips([ids[0]!], 'gaussianBlur')
    applyEffectToClips([ids[0]!], 'gaussianBlur')
    expect(types(ids[0]!)).toEqual(['gaussianBlur', 'gaussianBlur'])
  })
})

// A look greys white words, grains them, darkens them at the edges, and a film
// look haloes them in red. The caption style owns a title, so every door to a
// look leaves titles and captions clean, as the punch grade always has.
describe('a look and the captions', () => {
  it('skips the caption in a selection and says so', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    expect(applyEffectToClips([...ids, caption], 'lookMoodyGym')).toBe(3)
    expect(types(caption)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual(['lookMoodyGym'])
    expect(shown.map((t) => t.message)).toEqual(['Added Moody Gym to 3 clips. Titles and captions left clean'])
  })

  it('skips a caption it is dropped on', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    useStore.getState().setUI({ selection: [] })
    expect(applyEffectToClips(effectDropTargets(caption, []), 'lookFilm800T')).toBe(0)
    expect(types(caption)).toEqual([])
    expect(shown.map((t) => t.message)).toEqual(['Looks leave titles and captions clean'])
  })

  it('skips every caption from "Apply to every clip"', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    applyEffectToAllClips('lookKodakFilm')
    expect(types(caption)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual(['lookKodakFilm'])
    expect(shown.map((t) => t.message)).toEqual(['Applied "Kodak Film" to 3 clips. Titles and captions left clean'])
  })

  it('skips a caption from its own Inspector Add effect menu', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    applyEffect(caption, 'lookBlackWhite')
    expect(types(caption)).toEqual([])
    expect(shown.map((t) => t.message)).toEqual(['Looks leave titles and captions clean'])
  })

  it('never reaches the renderer on a caption', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    applyEffectToAllClips('lookFilm800T')
    const layers = resolveFrame(seq(), 1).ops.flatMap((op) => (op.type === 'layer' ? [op.layer] : []))
    expect(layers.find((l) => l.clipId === caption)!.effects).toEqual([])
  })

  it('still lets an ordinary effect onto a caption', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    expect(applyEffectToClips([caption], 'gaussianBlur')).toBe(1)
    expect(types(caption)).toEqual(['gaussianBlur'])
  })
})
