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
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { copyClipAttributes, pasteClipAttributes } from './attributes'
import { applyEffectToAllClips, applyEffectToClips, setClipsTransition } from './bulkEdits'
import { useLibrary, applyPresetToAllClips, applyPresetToSelection } from './library'
import { setClipTransition } from './clipEdits'
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

/** A caption on V3 over the three pictures, the way a whole Short is selected. Returns its id. */
function withCaption(): string {
  const cap = newTitleClip(defaultTitleDef('hi'), 0, 2)
  updateActiveSequence('seed caption', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.name === 'V3' ? { ...t, clips: [...t.clips, { ...cap, startS: 3 }] } : t)) }),
  )
  return cap.id
}

// FOOTAGE WINS A MIXED SELECTION, and a selection never gets a second copy.
// Measured 2026-10-06: Apply to every clip graded every caption (yellow words
// went grey under Saturation), and adding Auto Color again to the whole Short
// gave the clips that had it a doubled look.
describe('footage wins a mixed selection, and nothing is stacked twice', () => {
  it('Add effect on pictures plus a caption grades the pictures and leaves the caption clean', () => {
    const ids = threePictures()
    const cap = withCaption()
    expect(applyEffectToClips([...ids, cap], 'saturation')).toBe(3)
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(clipById(cap).effects).toHaveLength(0)
  })

  it('a selection of captions alone still takes the effect (a Glow on the words)', () => {
    threePictures()
    const cap = withCaption()
    expect(applyEffectToClips([cap], 'glow')).toBe(1)
    expect(clipById(cap).effects.map((e) => e.type)).toEqual(['glow'])
  })

  it('Apply to every clip leaves the captions clean', () => {
    const ids = threePictures()
    const cap = withCaption()
    applyEffectToAllClips('saturation')
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(clipById(cap).effects).toHaveLength(0)
    expect(said()).toEqual(['Applied "Saturation" to 3 clips'])
  })

  it('adding it again to the selection skips the clips that already have it, and counts them', () => {
    const ids = threePictures()
    applyEffectToClips([ids[0]!], 'autoColor')
    shown.length = 0
    expect(applyEffectToClips(ids, 'autoColor')).toBe(2)
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(said()).toEqual(['Added Auto Color to 2 clips. 1 already had it'])
    shown.length = 0
    expect(applyEffectToClips(ids, 'autoColor')).toBe(0)
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(said()).toEqual(['Every one of those clips already has Auto Color'])
    shown.length = 0
    applyEffectToAllClips('autoColor')
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(said()).toEqual(['Every clip already has Auto Color'])
  })

  it('one clip on its own may still stack a second copy on purpose', () => {
    const [a] = threePictures()
    applyEffectToClips([a!], 'glow')
    applyEffectToClips([a!], 'glow')
    expect(clipById(a!).effects).toHaveLength(2)
  })

  it('an effect dropped on the caption of a mixed selection is for the selected captions', () => {
    const ids = threePictures()
    const cap = withCaption()
    expect(effectDropTargets(cap, [...ids, cap], seq())).toEqual([cap])
    expect(effectDropTargets(ids[0]!, [...ids, cap], seq())).toEqual([...ids, cap])
  })

  it('a Library look goes on the pictures, not the caption, by both doors', () => {
    const ids = threePictures()
    const cap = withCaption()
    useLibrary.setState({
      presets: [{ id: 'p1', name: 'Warm', createdAt: 1, effects: [{ id: 'fx', type: 'saturation', enabled: true, params: { saturation: 0.3 } }] }],
    })
    useStore.getState().setUI({ selection: [...ids, cap] })
    applyPresetToSelection('p1')
    expect(effectsOf(ids)).toEqual([1, 1, 1])
    expect(clipById(cap).effects).toHaveLength(0)
    applyPresetToAllClips('p1')
    expect(effectsOf(ids)).toEqual([2, 2, 2])
    expect(clipById(cap).effects).toHaveLength(0)
  })
})

/** One picture on V1 and a caption on V2 over it, the cut locked. Returns [picture, caption]. */
function lockedCutWithCaption(): [string, string] {
  const assets = { a: picture('a') }
  useStore.getState().setProject({ ...newProject('locked cut'), assets })
  const pic = newClipFromAsset(assets.a, 0)
  const cap = newTitleClip(defaultTitleDef('hi'), 0, 2)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.name === 'V1' ? { ...t, clips: [pic], locked: true } : t.name === 'V2' ? { ...t, clips: [cap] } : t,
      ),
    }),
  )
  shown.length = 0
  return [pic.id, cap.id]
}

// Review, 2026-10-07: with the cut locked on V1, Apply to every clip dropped the
// locked footage BEFORE the footage wins rule, so the rule saw only the captions
// and graded every one of them.
describe('Apply to every clip with the footage track locked', () => {
  it('an effect leaves the captions clean and names the locked footage', () => {
    const [pic, cap] = lockedCutWithCaption()
    applyEffectToAllClips('saturation')
    expect(clipById(cap).effects).toHaveLength(0)
    expect(clipById(pic).effects).toHaveLength(0)
    expect(said()).toEqual(['That clip is on a locked track'])
  })

  it('a Library look leaves the captions clean and names the locked footage', () => {
    const [pic, cap] = lockedCutWithCaption()
    useLibrary.setState({
      presets: [{ id: 'p1', name: 'Warm', createdAt: 1, effects: [{ id: 'fx', type: 'saturation', enabled: true, params: { saturation: 0.3 } }] }],
    })
    applyPresetToAllClips('p1')
    expect(clipById(cap).effects).toHaveLength(0)
    expect(clipById(pic).effects).toHaveLength(0)
    expect(said()).toEqual(['That clip is on a locked track'])
  })

  it('the unlocked footage still takes it, and the locked footage is named', () => {
    const ids = threePictures()
    const cap = withCaption()
    lockTrack('V2')
    applyEffectToAllClips('saturation')
    expect(effectsOf(ids)).toEqual([1, 0, 1])
    expect(clipById(cap).effects).toHaveLength(0)
    expect(said()).toEqual(['Applied "Saturation" to 2 clips. 1 clip is on a locked track and was left out'])
    shown.length = 0
    useLibrary.setState({
      presets: [{ id: 'p1', name: 'Warm', createdAt: 1, effects: [{ id: 'fx', type: 'saturation', enabled: true, params: { saturation: 0.3 } }] }],
    })
    applyPresetToAllClips('p1')
    expect(effectsOf(ids)).toEqual([2, 0, 2])
    expect(clipById(cap).effects).toHaveLength(0)
    expect(said()).toEqual(['Applied "Warm" to 2 clips. 1 clip is on a locked track and was left out'])
  })
})

// A gym montage is twenty cuts. Selecting all twenty and picking White Flash put
// it on ONE of them, from every door (measured 2026-10-06).
describe('a transition on several selected pictures', () => {
  const ins = (ids: string[]) => ids.map((id) => clipById(id).transitionIn ?? null)

  it('lands on every selected picture at its own default length, in ONE undo step', () => {
    const ids = threePictures()
    const voice = withSoundPartner()
    const cap = withCaption()
    expect(setClipsTransition([...ids, voice, cap], 'in', 'whiteFlash')).toBe(3)
    expect(ins(ids)).toEqual([0, 1, 2].map(() => ({ type: 'whiteFlash', durationS: 0.2 })))
    expect(clipById(voice).transitionIn).toBeUndefined()
    expect(clipById(cap).transitionIn).toBeUndefined()
    expect(said()).toEqual(['White Flash at the start of 3 clips'])
    useStore.getState().undo()
    expect(ins(ids)).toEqual([null, null, null])
  })

  it('the clip menu offers it on all of them when the selection is kept', () => {
    const ids = threePictures()
    const item = clipContextMenuItems({
      clip: clipById(ids[0]!),
      seq: seq(),
      assets: useStore.getState().project.assets,
      selNow: ids,
      keepSelection: true,
      playheadS: 1,
      show: () => {},
    }).find((i) => i.label === 'Transition in · all 3')
    expect(item).toBeDefined()
    item!.submenu!.find((i) => i.label === 'Cross Dissolve')!.onClick?.()
    expect(ins(ids).map((t) => t?.type)).toEqual(['crossDissolve', 'crossDissolve', 'crossDissolve'])
  })

  // Review, 2026-10-07: a kind picked for the whole selection gave every clip the
  // kind's default length, throwing away the lengths he had set one by one.
  it('a kind picked for all of them keeps the length each one had', () => {
    const ids = threePictures()
    updateActiveSequence('lengths', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          const at = ids.indexOf(c.id)
          return at < 0 ? c : { ...c, transitionIn: { type: 'whiteFlash', durationS: [0.3, 0.4, 0.2][at]! } }
        }),
      })),
    }))
    setClipsTransition(ids, 'in', 'whiteFlash')
    expect(ins(ids).map((t) => t?.durationS)).toEqual([0.3, 0.4, 0.2])
    // A kind his length does not fit takes that kind's default.
    setClipsTransition(ids, 'in', 'crossDissolve')
    expect(ins(ids).map((t) => t?.type)).toEqual(['crossDissolve', 'crossDissolve', 'crossDissolve'])
    // The one clip door keeps it the same way.
    const [a] = ids
    updateActiveSequence('one', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === a ? { ...c, transitionIn: { type: 'whiteFlash', durationS: 0.35 } } : c)),
      })),
    }))
    setClipTransition(a!, 'in', 'whiteFlash')
    expect(clipById(a!).transitionIn).toEqual({ type: 'whiteFlash', durationS: 0.35 })
  })
})

/** Three pictures back to back on V1: [0, 5), [5, 10), [10, 15). Returns their clip ids. */
function montage(): string[] {
  const assets = { a: picture('a'), b: picture('b'), c: picture('c') }
  useStore.getState().setProject({ ...newProject('montage'), assets })
  const clips: Clip[] = (['a', 'b', 'c'] as const).map((k, i) => newClipFromAsset(assets[k], i * 5))
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.name === 'V1' ? { ...t, clips } : t)) }),
  )
  shown.length = 0
  return clips.map((c) => c.id)
}

const withOut = (id: string, type: string): void =>
  updateActiveSequence('seed out', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === id ? { ...c, transitionOut: { type, durationS: 0.4 } } : c)),
    })),
  }))

// Only one transition plays at a cut and B's In wins over A's Out (resolve.ts).
// Cross Dissolve on the end of A, later Cross Zoom on the start of B: the zoom played
// while A's Inspector still said "Out: Cross Dissolve" (measured 2026-10-06).
describe('an In over the Out of the clip before', () => {
  it('one clip: the In takes the Out it overrides off, in the SAME undo step', () => {
    const [a, b] = montage()
    withOut(a!, 'crossDissolve')
    setClipTransition(b!, 'in', 'zoom')
    expect(clipById(b!).transitionIn?.type).toBe('zoom')
    expect(clipById(a!).transitionOut).toBeUndefined()
    useStore.getState().undo()
    expect(clipById(b!).transitionIn).toBeUndefined()
    expect(clipById(a!).transitionOut?.type).toBe('crossDissolve')
  })

  it('several clips: every Out an In overrides goes, the rest stay, one undo', () => {
    const [a, b, c] = montage()
    withOut(a!, 'crossDissolve')
    withOut(b!, 'wipeLeft')
    withOut(c!, 'dipToBlack')
    // B and C take the In, so A's Out and B's Out are overridden. C's Out has
    // no clip after it and still plays.
    setClipsTransition([b!, c!], 'in', 'whiteFlash')
    expect(clipById(a!).transitionOut).toBeUndefined()
    expect(clipById(b!).transitionOut).toBeUndefined()
    expect(clipById(c!).transitionOut?.type).toBe('dipToBlack')
    expect([b!, c!].map((id) => clipById(id).transitionIn?.type)).toEqual(['whiteFlash', 'whiteFlash'])
    useStore.getState().undo()
    expect([a!, b!, c!].map((id) => clipById(id).transitionOut?.type)).toEqual(['crossDissolve', 'wipeLeft', 'dipToBlack'])
    expect([b!, c!].map((id) => clipById(id).transitionIn)).toEqual([undefined, undefined])
  })

  it('an Out the In does not meet stays: a gap between the clips, or an Out being set', () => {
    const [a, b] = montage()
    withOut(a!, 'crossDissolve')
    // Pull B a second to the right, so A and B no longer touch.
    updateActiveSequence('gap', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === b ? { ...c, startS: 6 } : c)) })),
    }))
    setClipTransition(b!, 'in', 'zoom')
    expect(clipById(a!).transitionOut?.type).toBe('crossDissolve')
    setClipTransition(b!, 'out', 'zoom')
    expect(clipById(a!).transitionOut?.type).toBe('crossDissolve')
  })
})
