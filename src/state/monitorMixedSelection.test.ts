// The monitor's right click and its drag to align, on a mixed selection.
//
// MEASURED 2026-10-06, with a whole Short selected (Ctrl+A): right click a
// caption in the MONITOR, Entrance > Fade in, and the footage faded in too, with
// every scale and position keyframe of its Push in wiped by the compile. Drag the
// captions down to align them and the footage jumped down with them.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelKeyframes } from '../engine/effects/channels'
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
import { alignTargets } from './bulkEdits'
import { previewClipMenu } from './clipMenus'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const video: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const seq = () => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** Footage on V1, two captions on V2 over it, its sound on A1. */
function short(): { footage: string; caps: string[]; sound: string } {
  useStore.getState().setProject({ ...newProject(), assets: { v: video } })
  const footage = { ...newClipFromAsset(video, 0), id: 'foot', linkId: 'L' }
  const sound = { ...newClipFromAsset(video, 0), id: 'snd', linkId: 'L' }
  const caps = [newTitleClip(defaultTitleDef('a'), 0, 1), newTitleClip(defaultTitleDef('b'), 1, 1)]
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0 ? { ...t, clips: [footage] } : i === 1 ? { ...t, clips: caps } : i === 2 ? { ...t, clips: [sound] } : t,
      ),
    }),
  )
  return { footage: 'foot', caps: caps.map((c) => c.id), sound: 'snd' }
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('the monitor right click on a caption of a mixed selection', () => {
  it('Entrance > Fade in reaches the selected captions and leaves the footage and its move alone', () => {
    const { footage, caps, sound } = short()
    // Seed a real Push in so there is something to lose.
    updateActiveSequence('push', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === footage ? { ...c, keyframes: { scale: [{ t: 0, value: 1, ease: 'linear' as const }, { t: 4, value: 1.2, ease: 'linear' as const }] } } : c,
        ),
      })),
    }))
    const before = channelKeyframes(clipById(footage), 'scale')
    const entrance = previewClipMenu(clipById(caps[0]!), [caps[0]!, footage, caps[1]!, sound]).find((i) =>
      i.label?.startsWith('Entrance'),
    )!
    expect(entrance.label).toBe('Entrance · all 2')
    entrance.submenu!.find((i) => i.label === 'Fade in')!.onClick?.()
    expect(caps.map((id) => clipById(id).appearance?.in)).toEqual(['fadeIn', 'fadeIn'])
    expect(clipById(footage).appearance).toBeUndefined()
    expect(channelKeyframes(clipById(footage), 'scale')).toEqual(before)
  })

  it('setClipsAppearance itself never compiles onto a video clip', () => {
    const { footage } = short()
    const before = clipById(footage)
    setClipsAppearance([footage], { in: 'fadeIn' })
    expect(clipById(footage)).toBe(before)
  })
})

describe('alignTargets (the monitor drag to align)', () => {
  it('a caption on top moves the selected captions, not the footage or the sound', () => {
    const { footage, caps, sound } = short()
    expect(alignTargets(seq(), [footage, sound, ...caps], caps[0]!)).toEqual(caps)
  })

  it('footage on top moves the selected pictures only', () => {
    const { footage, caps, sound } = short()
    expect(alignTargets(seq(), [footage, sound, ...caps], footage)).toEqual([footage])
  })
})
