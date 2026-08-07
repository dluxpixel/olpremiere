import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { channelKeyframes } from '../engine/effects/channels'
import { MOTION_CURVES } from '../engine/motion'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import {
  setClipTransformAtPlayhead,
  toggleChannelAnimation,
  toggleMotionAtPlayhead,
} from './clipEdits'
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
})

// ARMED is no longer a persisted global preference. It is a fact about the CLIP:
// a clip carrying keyframes on any of posX, posY, scale or rotation animates
// under a drag, and a clip carrying none simply moves. These assert exactly what
// a drag commits, which is the part that was always worth testing.
describe('per-clip armed', () => {
  it('NOT ARMED: dragging a still clip moves the whole clip', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    setClipTransformAtPlayhead(c.id, { x: 120 })
    expect(clipOf(c.id).transform.x).toBe(120)
    expect(channelKeyframes(clipOf(c.id), 'posX')).toHaveLength(0)
  })

  it('ARMED by the badge: the same drag ANIMATES it from where it was', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    // The gizmo badge is what arms a still clip: it snapshots the framing here,
    // and it takes TWO, because a lone keyframe holds everywhere and is just a
    // moved base.
    toggleMotionAtPlayhead(c.id)
    expect(channelKeyframes(clipOf(c.id), 'posX').map((k) => k.t)).toEqual([0, 2])

    useStore.getState().setUI({ playheadS: 4 })
    setClipTransformAtPlayhead(c.id, { x: 120 })

    const kfs = channelKeyframes(clipOf(c.id), 'posX')
    expect(kfs.map((k) => k.t)).toEqual([0, 2, 4])
    expect(kfs[1].value).toBe(0)
    expect(kfs[2].value).toBe(120)
  })

  it('ARMED at the clip head: an animated channel still keyframes there', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'posX')
    useStore.getState().setUI({ playheadS: 0 })
    setClipTransformAtPlayhead(c.id, { x: 40 })
    expect(channelKeyframes(clipOf(c.id), 'posX').map((k) => k.t)).toEqual([0, 2])
  })

  it('NOT ARMED at the clip head: a plain move, because there is nothing to animate FROM', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 0 })
    setClipTransformAtPlayhead(c.id, { x: 40 })
    expect(channelKeyframes(clipOf(c.id), 'posX')).toHaveLength(0)
    expect(clipOf(c.id).transform.x).toBe(40)
  })

  it('an ALREADY-animated channel keyframes at the playhead wherever the playhead is', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'posX')
    useStore.getState().setUI({ playheadS: 4 })
    setClipTransformAtPlayhead(c.id, { x: 300 })
    useStore.getState().setUI({ playheadS: 1 })
    setClipTransformAtPlayhead(c.id, { x: 10 })
    expect(channelKeyframes(clipOf(c.id), 'posX').map((k) => k.t)).toEqual([1, 2, 4])
  })

  // The live defect this whole rule exists to kill: a drag four seconds into a
  // clip used to pin the previous value at t=0, so the framing crawled linearly
  // across four whole seconds instead of moving where he dragged.
  it('pins the value it leaves FROM at the nearest existing moment, not at the clip head', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 3.5 })
    toggleChannelAnimation(c.id, 'scale') // the clip is now armed, moment at 3.5
    useStore.getState().setUI({ playheadS: 4 })
    setClipTransformAtPlayhead(c.id, { x: 120 })

    const kfs = channelKeyframes(clipOf(c.id), 'posX')
    expect(kfs.map((k) => k.t)).toEqual([3.5, 4])
    expect(kfs[0].value).toBe(0)
  })

  it('commits the move curve on the keyframe the move leaves FROM', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 4 })
    setClipTransformAtPlayhead(c.id, { x: 120 })
    // snapIn is the default move curve; linear is the opt-out, not the default.
    expect(channelKeyframes(clipOf(c.id), 'posX')[0].curve).toEqual(MOTION_CURVES.snapIn)
  })

  it('animates every dragged channel, in one undo step', () => {
    const c = seed()
    useStore.getState().setUI({ playheadS: 2 })
    toggleMotionAtPlayhead(c.id)
    const before = ['posX', 'posY', 'scale'] as const
    useStore.getState().setUI({ playheadS: 4 })
    setClipTransformAtPlayhead(c.id, { x: 120, y: -40, scale: 1.5 })
    for (const ch of before) {
      expect(channelKeyframes(clipOf(c.id), ch).map((k) => k.t)).toEqual([0, 2, 4])
    }
    useStore.getState().undo()
    for (const ch of before) {
      expect(channelKeyframes(clipOf(c.id), ch).map((k) => k.t)).toEqual([0, 2])
    }
  })
})
