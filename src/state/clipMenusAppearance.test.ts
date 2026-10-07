import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAppearanceToClip } from '../engine/anim/appearance'
import { channelKeyframes, withChannelKeyframes } from '../engine/effects/channels'
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
import { setClipsAppearance } from './appearanceActions'
import { copyClipAttributes, pasteClipAttributes } from './attributes'
import { toggleChannelAnimation, toggleMotionAtPlayhead } from './clipEdits'
import { appearanceMenuItems } from './clipMenus'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const videoAsset: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const imageAsset: MediaAsset = { id: 'i', name: 'i', kind: 'image', blobKey: 'b', durationS: 0, hasAudio: false, hasVideo: false }

const addAsset = (a: MediaAsset) =>
  useStore.setState((s) => ({ project: { ...s.project, assets: { ...s.project.assets, [a.id]: a } } }))

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('appearanceMenuItems: entrances by clip kind', () => {
  it('shows entrance/exit for a TITLE clip', () => {
    const clip = newTitleClip(defaultTitleDef('hi'), 0, 3)
    expect(appearanceMenuItems(clip).some((i) => i.label?.startsWith('Entrance'))).toBe(true)
  })

  it('shows entrance/exit for a still IMAGE clip (it "appears" like text)', () => {
    addAsset(imageAsset)
    const clip = newClipFromAsset(imageAsset, 0)
    expect(appearanceMenuItems(clip).some((i) => i.label?.startsWith('Entrance'))).toBe(true)
  })

  it('is EMPTY for a VIDEO clip (video animates via Motion + transitions)', () => {
    addAsset(videoAsset)
    const clip = newClipFromAsset(videoAsset, 0)
    expect(appearanceMenuItems(clip)).toEqual([])
  })
})

// Review, 2026-10-07: footage that picked up a caption's pop (Paste attributes,
// an older project) could not lose it: None and Clear were refused like an add,
// the video clip menu had no Animation items, and the stopwatch and D refused it.
describe('footage that carries an In or Out', () => {
  const clipById = (id: string): Clip =>
    activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

  /** A video clip on V1 with a pop compiled onto it, the way a paste used to leave it. */
  function poppingFootage(): string {
    addAsset(videoAsset)
    const sq = activeSequence(useStore.getState().project)
    const clip = applyAppearanceToClip(newClipFromAsset(videoAsset, 0), { in: 'pop', durS: 0.2 }, sq.width, sq.height)
    updateActiveSequence('seed', (s) =>
      recomputeDuration({ ...s, tracks: s.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
    )
    return clip.id
  }

  it('the menu offers Clear animation, and it takes the pop off', () => {
    const id = poppingFootage()
    const items = appearanceMenuItems(clipById(id))
    expect(items.map((i) => i.label)).toEqual(['Clear animation'])
    items[0]!.onClick?.()
    expect(clipById(id).appearance).toBeUndefined()
    expect(channelKeyframes(clipById(id), 'scale')).toEqual([])
  })

  it('None on the In takes it off, and a new In is still refused', () => {
    const id = poppingFootage()
    setClipsAppearance([id], { in: 'fadeIn' })
    expect(clipById(id).appearance?.in).toBe('pop')
    setClipsAppearance([id], { in: undefined })
    expect(clipById(id).appearance).toBeUndefined()
  })

  it('keeps its stopwatch and D', () => {
    const id = poppingFootage()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(id, 'posX')
    expect(channelKeyframes(clipById(id), 'posX').map((k) => k.t)).toEqual([1])
    expect(clipById(id).appearance).toBeUndefined()

    const other = poppingFootage()
    useStore.getState().setUI({ playheadS: 2 })
    toggleMotionAtPlayhead(other)
    expect(channelKeyframes(clipById(other), 'posY').some((k) => Math.abs(k.t - 2) < 1e-6)).toBe(true)
  })

  it('Paste attributes off a popping caption leaves the pop off footage, and its move on', () => {
    addAsset(videoAsset)
    const sq = activeSequence(useStore.getState().project)
    const caption = applyAppearanceToClip(newTitleClip(defaultTitleDef('hi'), 0, 1), { in: 'pop', durS: 0.1 }, sq.width, sq.height)
    const move = [
      { t: 0, value: 1, ease: 'linear' as const },
      { t: 3, value: 1.2, ease: 'linear' as const },
    ]
    const footage = withChannelKeyframes(newClipFromAsset(videoAsset, 0), 'scale', move)
    updateActiveSequence('seed', (s) =>
      recomputeDuration({
        ...s,
        tracks: s.tracks.map((t, i) => (i === 0 ? { ...t, clips: [footage] } : i === 1 ? { ...t, clips: [caption] } : t)),
      }),
    )
    copyClipAttributes(caption.id)
    pasteClipAttributes([footage.id])
    expect(clipById(footage.id).appearance).toBeUndefined()
    expect(channelKeyframes(clipById(footage.id), 'scale')).toEqual(move)
  })
})
