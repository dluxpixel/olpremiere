import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { channelKeyframes } from '../engine/effects/channels'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { setClipTransformAtPlayhead } from './clipEdits'
import { setAutoKeyframe } from './settings'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const clipOf = (id: string): Clip =>
  activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!

function seed(): Clip {
  const clip = newTitleClip(defaultTitleDef('Hi'), 0, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  setAutoKeyframe(false)
})

describe('auto-keyframe', () => {
  it('OFF: dragging a still clip moves the whole clip, as before', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    setClipTransformAtPlayhead(c.id, { x: 120 })
    expect(clipOf(c.id).transform.x).toBe(120)
    expect(channelKeyframes(clipOf(c.id), 'posX')).toHaveLength(0)
  })

  it('ON: the same drag ANIMATES it from where it was', () => {
    const c = seed()
    setAutoKeyframe(true)
    useStore.getState().setUI({ playheadS: 2 })
    setClipTransformAtPlayhead(c.id, { x: 120 })

    const kfs = channelKeyframes(clipOf(c.id), 'posX')
    // A lone keyframe would just be a moved base, so there are two: the old
    // value pinned at the head, the new one at the playhead.
    expect(kfs.map((k) => k.t)).toEqual([0, 2])
    expect(kfs[0].value).toBe(0)
    expect(kfs[1].value).toBe(120)
  })

  it('ON at the clip head: still a plain move, because there is nothing to animate FROM', () => {
    const c = seed()
    setAutoKeyframe(true)
    useStore.getState().setUI({ playheadS: 0 })
    setClipTransformAtPlayhead(c.id, { x: 40 })
    expect(channelKeyframes(clipOf(c.id), 'posX')).toHaveLength(0)
    expect(clipOf(c.id).transform.x).toBe(40)
  })

  it('an ALREADY-animated channel keyframes at the playhead either way', () => {
    const c = seed()
    setAutoKeyframe(true)
    useStore.getState().setUI({ playheadS: 2 })
    setClipTransformAtPlayhead(c.id, { x: 120 }) // creates [0, 2]
    useStore.getState().setUI({ playheadS: 4 })
    setClipTransformAtPlayhead(c.id, { x: 300 })
    expect(channelKeyframes(clipOf(c.id), 'posX').map((k) => k.t)).toEqual([0, 2, 4])

    setAutoKeyframe(false)
    useStore.getState().setUI({ playheadS: 1 })
    setClipTransformAtPlayhead(c.id, { x: 10 })
    expect(channelKeyframes(clipOf(c.id), 'posX').map((k) => k.t)).toEqual([0, 1, 2, 4])
  })

  it('animates every dragged channel, in one undo step', () => {
    const c = seed()
    setAutoKeyframe(true)
    useStore.getState().setUI({ playheadS: 2 })
    setClipTransformAtPlayhead(c.id, { x: 120, y: -40, scale: 1.5 })
    for (const ch of ['posX', 'posY', 'scale'] as const) {
      expect(channelKeyframes(clipOf(c.id), ch)).toHaveLength(2)
    }
    useStore.getState().undo()
    for (const ch of ['posX', 'posY', 'scale'] as const) {
      expect(channelKeyframes(clipOf(c.id), ch)).toHaveLength(0)
    }
  })
})
