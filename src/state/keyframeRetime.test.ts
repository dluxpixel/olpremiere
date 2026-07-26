import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import {
  addKeyframeAtPlayhead,
  moveClipKeyframe,
  moveKeyframeTime,
  setClipTransform,
  toggleChannelAnimation,
} from './clipEdits'
import { setClipsAppearance } from './appearanceActions'
import { updateActiveSequence, useStore } from './store'

// The node environment has no window for the real toast store to reach for.
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

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

// A preset compiles straight into clip.keyframes, so every caption shows
// grabbable diamonds — but a transform edit used to recompile the channel from
// the spec and throw the retime away. Retiming now takes the clip off its preset.
describe('retiming a keyframe a PRESET compiled', () => {
  const scaleTimes = () => channelKeyframes(firstClip(), 'scale').map((k) => k.t)

  it('survives the next monitor drag — the retime is not recompiled away', () => {
    const c = seedTitle()
    setClipsAppearance([c.id], { in: 'pop' })
    const compiled = scaleTimes()
    expect(compiled.length).toBeGreaterThan(1)

    // Drag the LAST compiled moment of the entrance later.
    const from = compiled[compiled.length - 1]
    const to = from + 0.4
    moveClipKeyframe(c.id, from, to)
    const retimed = scaleTimes()
    expect(retimed[retimed.length - 1]).toBeCloseTo(to, 6)

    // The very next gizmo drag used to rebuild the channel from the spec.
    setClipTransform(c.id, { x: 120 })
    expect(scaleTimes()).toEqual(retimed)
  })

  it('promotes the clip off the preset, and undo puts it back', () => {
    const c = seedTitle()
    setClipsAppearance([c.id], { in: 'pop' })
    expect(firstClip().appearance?.in).toBe('pop')

    const compiled = scaleTimes()
    moveClipKeyframe(c.id, compiled[compiled.length - 1], compiled[compiled.length - 1] + 0.4)
    expect(firstClip().appearance).toBeUndefined()

    useStore.getState().undo()
    expect(firstClip().appearance?.in).toBe('pop')
    expect(scaleTimes()).toEqual(compiled)
  })

  it('a moment that touches NO appearance channel leaves the preset alone', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 3 })
    toggleChannelAnimation(c.id, 'blur') // an effect param, well clear of the entrance
    setClipsAppearance([c.id], { in: 'pop' })
    expect(firstClip().appearance?.in).toBe('pop')

    moveClipKeyframe(c.id, 3, 3.5)
    expect(firstClip().appearance?.in).toBe('pop')
  })
})
