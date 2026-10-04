// An effect on several selected pictures lands on ALL of them, by every door.
//
// His words, 2026-10-04: *"selecting multiple images and putting effects on them
// that actually apply to all of them."* The Effects tab's double click and the
// multi-selection Inspector already fanned out (v3.18.0). The doors below did
// not: an effect dragged onto a selected clip, the clip's right-click Remove green
// screen, a Library preset, and the Inspector's effect search put it on ONE clip
// and, for the drag, collapsed the selection to it. And three of the doors that
// did fan out counted the sound partners that ride along in a selection as clips
// they had changed. Every door below runs through the real actions, on a real
// project of three pasted pictures.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectDropTargets } from '../components/effectDrop'
import { clipContextMenuItems } from '../components/timelineClipMenu'
import { makeAsset } from '../components/timelineTestFixtures'
import { addTrack, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  newClipFromAsset,
  newProject,
  type Clip,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { copyClipAttributes, pasteClipAttributes } from './attributes'
import { applyEffectToClips } from './bulkEdits'
import { useLibrary, applyPresetToSelection } from './library'
import { applyPunchyGradeToClips } from './lookActions'
import { updateActiveSequence, useStore } from './store'

const shown: { message: string; kind?: string }[] = []
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string, kind?: string) => shown.push({ message, kind }) }) },
}))
// library.ts reaches for IndexedDB when it loads; none of these doors touch it.
vi.mock('./persistence', () => ({ db: async () => ({}), getBlob: async () => null, putBlob: async () => {} }))

const said = (): string[] => shown.map((t) => t.message)
const seq = (): Sequence => activeSequence(useStore.getState().project)
const allClips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)
const clipById = (id: string): Clip => allClips().find((c) => c.id === id)!
const effectsOf = (ids: string[]): number[] => ids.map((id) => clipById(id).effects.length)

const picture = (id: string): MediaAsset =>
  makeAsset({ id, name: `${id}.png`, kind: 'image', durationS: 0, hasAudio: false, hasVideo: false, width: 640, height: 480 })
const sound: MediaAsset = makeAsset({ id: 'voice', name: 'voice.wav', kind: 'audio', durationS: 5, hasAudio: true, hasVideo: false })

/** Three pasted pictures stacked on V1, V2 and V3, all at 0 s. Returns their clip ids. */
function threePictures(): string[] {
  const assets = { a: picture('a'), b: picture('b'), c: picture('c'), voice: sound }
  useStore.getState().setProject({ ...newProject('pictures'), assets })
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

/** The selection of a video clip carries its sound partner too: a voice clip on A1. */
function withSoundPartner(): string {
  const voice = newClipFromAsset(sound, 0)
  updateActiveSequence('seed sound', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.kind === 'audio' && t.name === 'A1' ? { ...t, clips: [voice] } : t)) }),
  )
  return voice.id
}

const lockTrack = (name: string): void =>
  updateActiveSequence('lock', (sq) => ({ ...sq, tracks: sq.tracks.map((t) => (t.name === name ? { ...t, locked: true } : t)) }))

beforeEach(() => {
  shown.length = 0
})

describe('the Effects tab (double click, Enter, Apply to N clips) and the multi Inspector', () => {
  it('puts one fresh effect on each picture, in ONE undo step, and says how many it changed', () => {
    const ids = threePictures()
    expect(applyEffectToClips(ids, 'gaussianBlur')).toBe(3)
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(new Set(ids.map((id) => clipById(id).effects[0]!.id)).size).toBe(3)
    expect(said()).toEqual(['Added Gaussian Blur to 3 clips'])
    useStore.getState().undo()
    expect(effectsOf(ids)).toEqual([0, 0, 0])
  })

  it('does not count the sound that rides along in a selection as a clip it changed', () => {
    const ids = threePictures()
    const voice = withSoundPartner()
    useStore.getState().setUI({ selection: [...ids, voice] })
    expect(applyEffectToClips([...ids, voice], 'gaussianBlur')).toBe(3)
    expect(clipById(voice).effects).toHaveLength(0)
    expect(said()).toEqual(['Added Gaussian Blur to 3 clips'])
  })

  it('leaves a clip on a locked track out and says so', () => {
    const ids = threePictures()
    lockTrack('V2')
    expect(applyEffectToClips(ids, 'gaussianBlur')).toBe(2)
    expect(effectsOf(ids)).toEqual([1, 0, 1])
    expect(said()).toEqual(['Added Gaussian Blur to 2 clips. 1 clip is on a locked track and was left out'])
  })

  it('refuses out loud when every selected clip is on a locked track, and records no step', () => {
    const ids = threePictures()
    lockTrack('V1')
    lockTrack('V2')
    lockTrack('V3')
    const steps = useStore.getState().history.undo.length
    expect(applyEffectToClips(ids, 'gaussianBlur')).toBe(0)
    expect(useStore.getState().history.undo.length).toBe(steps)
    expect(said()).toEqual(['Those clips are on a locked track'])
  })

  it('adds the effect to a lone picture without a word', () => {
    const [a] = threePictures()
    expect(applyEffectToClips([a!], 'gaussianBlur')).toBe(1)
    expect(clipById(a!).effects).toHaveLength(1)
    expect(said()).toEqual([])
  })
})

describe('dragging an effect onto one of the selected pictures', () => {
  it('lands on the whole selection when the clip it is dropped on is part of it', () => {
    const ids = threePictures()
    expect(effectDropTargets(ids[1]!, ids)).toEqual(ids)
  })

  it('lands on just that clip when it is not part of the selection, or when it is the only one', () => {
    const ids = threePictures()
    expect(effectDropTargets('elsewhere', ids)).toEqual(['elsewhere'])
    expect(effectDropTargets(ids[0]!, [ids[0]!])).toEqual([ids[0]])
    expect(effectDropTargets(ids[0]!, [])).toEqual([ids[0]])
  })
})

describe('the clip right-click menu on several selected pictures', () => {
  const menuFor = (ids: string[], keepSelection: boolean) =>
    clipContextMenuItems({
      clip: clipById(ids[0]!),
      seq: seq(),
      assets: useStore.getState().project.assets,
      selNow: keepSelection ? ids : [ids[0]!],
      keepSelection,
      playheadS: 1,
      show: () => {},
    })

  it('Remove green screen keys every selected picture, in ONE undo step', () => {
    const ids = threePictures()
    const item = menuFor(ids, true).find((i) => i.label === 'Remove green screen · all 3')
    expect(item).toBeDefined()
    item!.onClick?.()
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(ids.every((id) => clipById(id).effects[0]!.type === 'chromaKey')).toBe(true)
    expect(said()).toEqual(['Added Green Screen to 3 clips'])
    useStore.getState().undo()
    expect(effectsOf(ids)).toEqual([0, 0, 0])
  })

  it('keeps its plain name and its one clip when only one is selected', () => {
    const ids = threePictures()
    const item = menuFor(ids, false).find((i) => i.label === 'Remove green screen')
    expect(item).toBeDefined()
    item!.onClick?.()
    expect(effectsOf(ids)).toEqual([1, 0, 0])
  })

  it('Paste attributes names the pictures it will go on, not the sound beside them', () => {
    const ids = threePictures()
    const voice = withSoundPartner()
    const items = clipContextMenuItems({
      clip: clipById(ids[0]!),
      seq: seq(),
      assets: useStore.getState().project.assets,
      selNow: [...ids, voice],
      keepSelection: true,
      playheadS: 1,
      show: () => {},
    })
    expect(items.some((i) => i.label === 'Paste attributes to 3')).toBe(true)
  })

  it('Paste attributes carries the effects onto every selected picture and counts only pictures', () => {
    const ids = threePictures()
    const voice = withSoundPartner()
    const source = newClipFromAsset(picture('s'), 0)
    updateActiveSequence('seed source', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.name === 'V1' ? { ...t, clips: [...t.clips, { ...source, startS: 9 }] } : t)) }),
    )
    applyEffectToClips([source.id], 'gaussianBlur')
    copyClipAttributes(source.id)
    shown.length = 0

    pasteClipAttributes([...ids, voice])

    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(clipById(voice).effects).toHaveLength(0)
    expect(said()).toEqual(['Attributes pasted to 3 clips'])
    useStore.getState().undo()
    expect(effectsOf(ids)).toEqual([0, 0, 0])
  })
})

describe('a Library effect preset on several selected pictures', () => {
  const preset = {
    id: 'p1',
    name: 'Warm',
    createdAt: 1,
    effects: [{ id: 'fx', type: 'saturation', enabled: true, params: { saturation: 0.3 } }],
  }

  it('is added to every selected picture with its own ids, in ONE undo step, and counted', () => {
    const ids = threePictures()
    useLibrary.setState({ presets: [preset] })
    applyPresetToSelection('p1')
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(new Set(ids.map((id) => clipById(id).effects[0]!.id)).size).toBe(3)
    expect(said()).toEqual(['Applied "Warm" to 3 clips'])
    useStore.getState().undo()
    expect(effectsOf(ids)).toEqual([0, 0, 0])
  })

  it('leaves the sound out and a locked track out, and says how many it did change', () => {
    const ids = threePictures()
    const voice = withSoundPartner()
    lockTrack('V3')
    useStore.getState().setUI({ selection: [...ids, voice] })
    useLibrary.setState({ presets: [preset] })
    applyPresetToSelection('p1')
    expect(effectsOf(ids)).toEqual([1, 1, 0])
    expect(clipById(voice).effects).toHaveLength(0)
    expect(said()).toEqual(['Applied "Warm" to 2 clips. 1 clip is on a locked track and was left out'])
  })

  it('still says "Select a clip first" with nothing selected', () => {
    threePictures()
    useStore.getState().setUI({ selection: [] })
    useLibrary.setState({ presets: [preset] })
    applyPresetToSelection('p1')
    expect(said()).toEqual(['Select a clip first'])
  })
})

describe('Punch grade on several selected pictures', () => {
  it('grades every picture and counts only pictures, not the sound beside them', () => {
    const ids = threePictures()
    const voice = withSoundPartner()
    applyPunchyGradeToClips([...ids, voice])
    expect(effectsOf(ids)).toEqual([3, 3, 3])
    expect(clipById(voice).effects).toHaveLength(0)
    expect(said()).toEqual(['Punch grade on 3 clips'])
    useStore.getState().undo()
    expect(effectsOf(ids)).toEqual([0, 0, 0])
  })
})
