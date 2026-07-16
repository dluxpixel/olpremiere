import { beforeEach, describe, expect, it } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { channelKeyframes } from '../engine/effects/channels'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { addKeyframeAtPlayhead, moveKeyframeTime, toggleChannelAnimation } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const firstClip = () => seq().tracks[0].clips[0]
const times = () => channelKeyframes(firstClip(), 'scale').map((k) => k.t)

function seedTitle(): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
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
})

describe('moveKeyframeTime', () => {
  it('retimes a keyframe and keeps value + easing, in one undo step', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale') // seeds kf at t=1
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale') // kf at t=3
    expect(times()).toEqual([1, 3])

    const before = channelKeyframes(firstClip(), 'scale').find((k) => Math.abs(k.t - 3) < 1e-6)!
    moveKeyframeTime(c.id, 'scale', 3, 2)
    expect(times()).toEqual([1, 2])
    const after = channelKeyframes(firstClip(), 'scale').find((k) => Math.abs(k.t - 2) < 1e-6)!
    expect(after.value).toBe(before.value)
    expect(after.ease).toBe(before.ease)

    useStore.getState().undo()
    expect(times()).toEqual([1, 3])
  })

  it('clamps the new time to the clip span', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale')
    // Push the first keyframe way past the end → clamps to durS (5).
    moveKeyframeTime(c.id, 'scale', 1, 99)
    expect(times()).toEqual([3, 5])
    // And below zero → clamps to 0.
    moveKeyframeTime(c.id, 'scale', 3, -4)
    expect(times()).toEqual([0, 5])
  })

  it('is a no-op (no command) when the time does not change', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'scale')
    const projBefore = useStore.getState().project
    moveKeyframeTime(c.id, 'scale', 2, 2)
    expect(useStore.getState().project).toBe(projBefore)
  })
})
