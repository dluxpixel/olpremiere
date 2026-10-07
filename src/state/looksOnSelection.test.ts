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
import type { EffectPreset } from '../engine/effects/presets'
import { resolveFrame } from '../engine/render/resolve'
import { addTrack, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newAdjustmentClip,
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
import { applyPresetToAllClips, applyPresetToSelection, useLibrary } from './library'
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

/** An adjustment layer on its own video track over the three clips, selected along with them. Returns its id. */
function withAdjustment(ids: string[]): string {
  const adjustment = newAdjustmentClip(0, 5)
  updateActiveSequence('adjustment', (sq) => {
    const grown = addTrack(sq, 'video')
    const empty = grown.tracks.find((t) => t.kind === 'video' && t.clips.length === 0)!
    return recomputeDuration({ ...grown, tracks: grown.tracks.map((t) => (t.id === empty.id ? { ...t, clips: [adjustment] } : t)) })
  })
  useStore.getState().setUI({ selection: [...ids, adjustment.id] })
  shown.length = 0
  return adjustment.id
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

  it("keeps a keyframed Amount, his fade, on the look that takes the old one's place", () => {
    const ids = threeClips()
    const fade = { value: 1, keyframes: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 1.5, value: 1, ease: 'linear' as const }] }
    setStack(ids[0]!, [{ id: 'm', type: 'lookMoodyGym', enabled: true, params: { amount: fade } }])
    expect(applyEffectToClips([ids[0]!], 'lookTealOrange')).toBe(1)
    const teal = clipById(ids[0]!).effects[0]!
    expect(teal.type).toBe('lookTealOrange')
    expect(teal.params.amount).toEqual(fade)
    // Its own copy, never the old look's keyframes shared with the undo history.
    expect(teal.params.amount).not.toBe(fade)
    expect((teal.params.amount as typeof fade).keyframes).not.toBe(fade.keyframes)
    expect(shown.map((t) => t.message)).toEqual(['Swapped Moody Gym for Teal and Orange'])
    useStore.getState().undo()
    expect(clipById(ids[0]!).effects[0]!.params.amount).toEqual(fade)
  })

  it('keeps a keyframed Amount from the Inspector Add effect menu on one clip too', () => {
    const ids = threeClips()
    const fade = { value: 1, keyframes: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 1, value: 1, ease: 'linear' as const }] }
    setStack(ids[0]!, [{ id: 'm', type: 'lookMoodyGym', enabled: true, params: { amount: fade } }])
    applyEffect(ids[0]!, 'lookGoldenHour')
    expect(types(ids[0]!)).toEqual(['lookGoldenHour'])
    expect(clipById(ids[0]!).effects[0]!.params.amount).toEqual(fade)
  })

  it('drops the new look in at full strength over a static Amount, as designed', () => {
    const ids = threeClips()
    setStack(ids[0]!, [{ id: 'm', type: 'lookMoodyGym', enabled: true, params: { amount: 0.6 } }])
    applyEffectToClips([ids[0]!], 'lookTealOrange')
    expect(clipById(ids[0]!).effects.map((e) => [e.type, e.params.amount])).toEqual([['lookTealOrange', 1]])
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

const preset = (id: string, name: string, effects: EffectInstance[]): EffectPreset => ({ id, name, createdAt: 1, effects })
/** A look plus an ordinary effect, the look at a saved Amount of 0.6. */
const tealGrade = preset('p1', 'Teal grade', [
  { id: 'l', type: 'lookTealOrange', enabled: true, params: { amount: 0.6 } },
  { id: 's', type: 'saturation', enabled: true, params: { saturation: 0.3 } },
])
const moodyOnly = preset('p2', 'Moody', [{ id: 'm', type: 'lookMoodyGym', enabled: true, params: { amount: 1 } }])

// A look saved in a Library preset is held to the same rules. The preset used to
// append its whole stack, so a preset holding a look stacked a second look on a
// clip that already wore one, and graded the captions.
describe('a look in a saved preset', () => {
  it('replaces the look each clip wears, in its slot, at the Amount it was saved with, in ONE undo step', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookMoodyGym')
    const moody = clipById(ids[0]!).effects[0]!
    setStack(ids[0]!, [{ id: 'v', type: 'vignette', enabled: true, params: { amount: 0.3 } }, moody])
    useLibrary.setState({ presets: [tealGrade] })
    shown.length = 0
    applyPresetToSelection('p1')
    expect(types(ids[0]!)).toEqual(['vignette', 'lookTealOrange', 'saturation'])
    expect(types(ids[1]!)).toEqual(['lookTealOrange', 'saturation'])
    expect(types(ids[2]!)).toEqual(['lookTealOrange', 'saturation'])
    for (const id of ids) expect(clipById(id).effects.find((e) => e.type === 'lookTealOrange')!.params.amount).toBe(0.6)
    // Each clip got its OWN copy, never the preset's ids.
    const lookIds = ids.map((id) => clipById(id).effects.find((e) => e.type === 'lookTealOrange')!.id)
    expect(new Set(lookIds).size).toBe(3)
    expect(lookIds).not.toContain('l')
    expect(shown.map((t) => t.message)).toEqual(['Applied "Teal grade" to 3 clips. Teal and Orange took the place of Moody Gym'])
    expect(useStore.getState().undo()).toBe('Apply preset Teal grade')
    expect(types(ids[0]!)).toEqual(['vignette', 'lookMoodyGym'])
    expect(types(ids[1]!)).toEqual(['lookMoodyGym'])
    expect(types(ids[2]!)).toEqual(['lookMoodyGym'])
  })

  it('leaves the look a clip already wears alone, and a preset of only that look costs no undo step', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookMoodyGym')
    useLibrary.setState({ presets: [preset('p2', 'Moody', [{ id: 'm', type: 'lookMoodyGym', enabled: true, params: { amount: 0.5 } }])] })
    shown.length = 0
    applyPresetToSelection('p2')
    for (const id of ids) expect(clipById(id).effects.map((e) => [e.type, e.params.amount])).toEqual([['lookMoodyGym', 1]])
    expect(shown.map((t) => t.message)).toEqual(['"Moody" changed nothing. 3 already had Moody Gym'])
    // The one step on the stack is still the shelf's.
    expect(useStore.getState().undo()).toBe('Apply Moody Gym')
  })

  it('still puts the rest of its stack on a clip that already wears its look', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookTealOrange')
    useLibrary.setState({ presets: [tealGrade] })
    shown.length = 0
    applyPresetToSelection('p1')
    for (const id of ids) {
      expect(types(id)).toEqual(['lookTealOrange', 'saturation'])
      // The look it already wore, at its own Amount, not the preset's 0.6.
      expect(clipById(id).effects[0]!.params.amount).toBe(1)
    }
    expect(shown.map((t) => t.message)).toEqual(['Applied "Teal grade" to 3 clips. 3 already had Teal and Orange'])
  })

  it('leaves a clip one look when the preset itself carries two from before the rule', () => {
    const ids = threeClips()
    useLibrary.setState({
      presets: [
        preset('p3', 'Old stack', [
          { id: 'a', type: 'lookMoodyGym', enabled: true, params: { amount: 1 } },
          { id: 's', type: 'saturation', enabled: true, params: { saturation: 0.2 } },
          { id: 'b', type: 'lookTealOrange', enabled: true, params: { amount: 1 } },
        ]),
      ],
    })
    applyPresetToSelection('p3')
    for (const id of ids) expect(types(id)).toEqual(['lookTealOrange', 'saturation'])
  })

  it('leaves the look alone on a clip already wearing the last of two the preset carries', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookTealOrange')
    const worn = ids.map((id) => clipById(id).effects[0]!.id)
    useLibrary.setState({
      presets: [
        preset('p3', 'Old stack', [
          { id: 'a', type: 'lookMoodyGym', enabled: true, params: { amount: 1 } },
          { id: 's', type: 'saturation', enabled: true, params: { saturation: 0.2 } },
          { id: 'b', type: 'lookTealOrange', enabled: true, params: { amount: 0.4 } },
        ]),
      ],
    })
    shown.length = 0
    applyPresetToSelection('p3')
    ids.forEach((id, i) => {
      expect(types(id)).toEqual(['lookTealOrange', 'saturation'])
      // The very instance it wore, at its own Amount: never swapped out and back in.
      expect(clipById(id).effects[0]!.id).toBe(worn[i])
      expect(clipById(id).effects[0]!.params.amount).toBe(1)
    })
    expect(shown.map((t) => t.message)).toEqual(['Applied "Old stack" to 3 clips. 3 already had Teal and Orange'])
  })

  it('keeps the keyframed Amount of the look it takes the place of, over the Amount it was saved with', () => {
    const ids = threeClips()
    const fade = { value: 1, keyframes: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 2, value: 1, ease: 'linear' as const }] }
    setStack(ids[0]!, [{ id: 'm', type: 'lookMoodyGym', enabled: true, params: { amount: fade } }])
    setStack(ids[1]!, [{ id: 'n', type: 'lookMoodyGym', enabled: true, params: { amount: 0.8 } }])
    useStore.getState().setUI({ selection: [ids[0]!, ids[1]!] })
    useLibrary.setState({ presets: [tealGrade] })
    applyPresetToSelection('p1')
    expect(types(ids[0]!)).toEqual(['lookTealOrange', 'saturation'])
    expect(clipById(ids[0]!).effects[0]!.params.amount).toEqual(fade)
    // A static Amount is not a fade: the preset's own saved Amount goes on.
    expect(clipById(ids[1]!).effects[0]!.params.amount).toBe(0.6)
  })

  it('lands a look on a clip without one where the preset saved it, among the rest of its stack', () => {
    const ids = threeClips()
    useLibrary.setState({
      presets: [
        preset('p4', 'Edge', [
          { id: 'v', type: 'vignette', enabled: true, params: { amount: 0.3 } },
          { id: 'l', type: 'lookBronze', enabled: true, params: { amount: 1 } },
        ]),
      ],
    })
    applyPresetToSelection('p4')
    for (const id of ids) expect(types(id)).toEqual(['vignette', 'lookBronze'])
  })

  it('leaves a selected caption clean of its look, while the rest of the preset still reaches it', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    useLibrary.setState({ presets: [tealGrade] })
    applyPresetToSelection('p1')
    expect(types(caption)).toEqual(['saturation'])
    for (const id of ids) expect(types(id)).toEqual(['lookTealOrange', 'saturation'])
    expect(shown.map((t) => t.message)).toEqual(['Applied "Teal grade" to 4 clips. Looks leave titles and captions clean'])
  })

  it('changes nothing on a lone caption when the preset is only a look, and says why', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    useStore.getState().setUI({ selection: [caption] })
    useLibrary.setState({ presets: [moodyOnly] })
    applyPresetToSelection('p2')
    expect(types(caption)).toEqual([])
    expect(shown.map((t) => t.message)).toEqual(['"Moody" changed nothing. Looks leave titles and captions clean'])
    expect(useStore.getState().undo()).toBe('caption')
  })

  it('replaces and leaves captions clean from "Apply to every clip" too, in ONE undo step', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    applyEffectToAllClips('lookMoodyGym')
    useLibrary.setState({ presets: [tealGrade] })
    shown.length = 0
    applyPresetToAllClips('p1')
    for (const id of ids) expect(types(id)).toEqual(['lookTealOrange', 'saturation'])
    expect(types(caption)).toEqual(['saturation'])
    expect(shown.map((t) => t.message)).toEqual([
      'Applied "Teal grade" to 4 clips. Teal and Orange took the place of Moody Gym on 3. Looks leave titles and captions clean',
    ])
    expect(useStore.getState().undo()).toBe('Apply preset Teal grade to all clips')
    for (const id of ids) expect(types(id)).toEqual(['lookMoodyGym'])
    expect(types(caption)).toEqual([])
  })
})

// "Apply to every clip" and a preset both leave a locked track out before they
// start. With the footage locked, the captions over it are the only clips left,
// and the lock must not make them fair game for a look.
describe('a look with the footage locked', () => {
  /** Lock every track holding one of these clips, the way he protects his footage. */
  function lockTracksOf(ids: string[]): void {
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.clips.some((c) => ids.includes(c.id)) ? { ...t, locked: true } : t)),
    }))
    shown.length = 0
  }

  it('"Apply to every clip" leaves the captions clean and costs no undo step', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    lockTracksOf(ids)
    applyEffectToAllClips('lookMoodyGym')
    expect(types(caption)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual([])
    expect(shown).toEqual([{ message: 'Applied "Moody Gym" to 0 clips. Titles and captions left clean', kind: 'info' }])
    expect(useStore.getState().undo()).toBe('lock')
  })

  it('a preset of only a look leaves the captions clean from "Apply to every clip" and costs no undo step', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    lockTracksOf(ids)
    useLibrary.setState({ presets: [moodyOnly] })
    applyPresetToAllClips('p2')
    expect(types(caption)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual([])
    expect(shown).toEqual([{ message: 'Applied "Moody" to 0 clips. Looks leave titles and captions clean', kind: 'info' }])
    expect(useStore.getState().undo()).toBe('lock')
  })

  it('a preset from "Apply to every clip" puts only the rest of its stack on the captions', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    lockTracksOf(ids)
    useLibrary.setState({ presets: [tealGrade] })
    applyPresetToAllClips('p1')
    expect(types(caption)).toEqual(['saturation'])
    for (const id of ids) expect(types(id)).toEqual([])
    expect(shown.map((t) => t.message)).toEqual(['Applied "Teal grade" to 1 clip. Looks leave titles and captions clean'])
  })

  it('a preset on a selection of locked footage and a caption puts no look on the caption', () => {
    const ids = threeClips()
    const caption = withCaption(ids)
    lockTracksOf(ids)
    useLibrary.setState({ presets: [tealGrade] })
    applyPresetToSelection('p1')
    expect(types(caption)).toEqual(['saturation'])
    for (const id of ids) expect(types(id)).toEqual([])
    expect(shown.map((t) => t.message)).toEqual([
      'Applied "Teal grade". Looks leave titles and captions clean. 3 clips are on a locked track and were left out',
    ])
  })
})

// An adjustment layer grades the composite of everything under it. A look on it
// AND on the footage under it is the very compounding one look per clip is for:
// Moody Gym twice turns mid grey near black and teal. So a look that goes on
// footage leaves the adjustment layers in the same run alone. One on its own,
// or a run of nothing but adjustment layers, still takes it: that is how he
// grades a whole edit at once.
describe('a look and adjustment layers', () => {
  const adjustmentEffects = (): string[] =>
    resolveFrame(seq(), 1).ops.flatMap((op) => (op.type === 'adjustment' ? op.effects.map((e) => e.type) : []))

  it('skips an adjustment layer selected with footage, and says so', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    expect(applyEffectToClips([...ids, adjustment], 'lookMoodyGym')).toBe(3)
    expect(types(adjustment)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual(['lookMoodyGym'])
    expect(shown.map((t) => t.message)).toEqual(['Added Moody Gym to 3 clips. Adjustment layers left alone, so nothing is graded twice'])
  })

  it('skips every adjustment layer from "Apply to every clip", so the footage under it is graded once', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    applyEffectToAllClips('lookKodakFilm')
    expect(types(adjustment)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual(['lookKodakFilm'])
    expect(adjustmentEffects()).toEqual([])
    expect(shown.map((t) => t.message)).toEqual([
      'Applied "Kodak Film" to 3 clips. Adjustment layers left alone, so nothing is graded twice',
    ])
  })

  it('says why when the footage already wears the look', () => {
    const ids = threeClips()
    applyEffectToClips(ids, 'lookMoodyGym')
    const adjustment = withAdjustment(ids)
    expect(applyEffectToClips([...ids, adjustment], 'lookMoodyGym')).toBe(0)
    expect(types(adjustment)).toEqual([])
    expect(shown.map((t) => t.message)).toEqual([
      'Those clips already have Moody Gym. Adjustment layers left alone, so nothing is graded twice',
    ])
  })

  it('still goes on an adjustment layer on its own, or a run of only adjustment layers', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    expect(applyEffectToClips([adjustment], 'lookMoodyGym')).toBe(1)
    expect(types(adjustment)).toEqual(['lookMoodyGym'])
    expect(adjustmentEffects()[0]).toBe('lookMoodyGym')
    for (const id of ids) expect(types(id)).toEqual([])
  })

  it('takes "Apply to every clip" when the footage is locked and only the adjustment layer is open', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.clips.some((c) => ids.includes(c.id)) ? { ...t, locked: true } : t)),
    }))
    applyEffectToAllClips('lookMoodyGym')
    expect(types(adjustment)).toEqual(['lookMoodyGym'])
  })

  it('leaves the look of a preset off an adjustment layer selected with footage, while the rest of the preset reaches it', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    useLibrary.setState({ presets: [tealGrade] })
    applyPresetToSelection('p1')
    expect(types(adjustment)).toEqual(['saturation'])
    for (const id of ids) expect(types(id)).toEqual(['lookTealOrange', 'saturation'])
    expect(shown.map((t) => t.message)).toEqual([
      'Applied "Teal grade" to 4 clips. Teal and Orange left off adjustment layers, so nothing is graded twice',
    ])
  })

  it('leaves the look of a preset off every adjustment layer from "Apply to every clip"', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    useLibrary.setState({ presets: [moodyOnly] })
    applyPresetToAllClips('p2')
    expect(types(adjustment)).toEqual([])
    for (const id of ids) expect(types(id)).toEqual(['lookMoodyGym'])
    expect(adjustmentEffects()).toEqual([])
    expect(shown.map((t) => t.message)).toEqual([
      'Applied "Moody" to 3 clips. Moody Gym left off adjustment layers, so nothing is graded twice',
    ])
  })

  it('still puts a preset\'s look on an adjustment layer on its own', () => {
    const ids = threeClips()
    const adjustment = withAdjustment(ids)
    useStore.getState().setUI({ selection: [adjustment] })
    useLibrary.setState({ presets: [tealGrade] })
    applyPresetToSelection('p1')
    expect(types(adjustment)).toEqual(['lookTealOrange', 'saturation'])
  })
})
