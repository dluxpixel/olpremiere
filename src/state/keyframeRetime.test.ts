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
  moveKeyframes,
  scaleKeyframeSpan,
  setChannel,
  setClipTransform,
  toggleChannelAnimation,
  type KeyframePick,
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

// The lane vocabulary: lasso some diamonds, then slide them or stretch them.
// Both edits are about SPACING, so both are worthless the moment one keyframe
// in the selection moves further than another.
describe('moveKeyframes', () => {
  const posTimes = () => channelKeyframes(firstClip(), 'posX').map((k) => k.t)

  it('slides a multi-selection across two channels and keeps its relative spacing', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale') // scale kf at 1
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale') // scale kf at 3
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'posX') // posX kf at 2, between the two
    expect(times()).toEqual([1, 3])
    expect(posTimes()).toEqual([2])

    const picks: KeyframePick[] = [
      { channel: 'scale', t: 1 },
      { channel: 'scale', t: 3 },
      { channel: 'posX', t: 2 },
    ]
    moveKeyframes(c.id, picks, 0.5)

    const [a, b] = times()
    expect(a).toBeCloseTo(1.5, 6)
    expect(b).toBeCloseTo(3.5, 6)
    expect(posTimes()[0]).toBeCloseTo(2.5, 6)
    // The shape of the move, which is the whole point of moving it as a set.
    expect(b - a).toBeCloseTo(2, 6)
    expect(posTimes()[0] - a).toBeCloseTo(1, 6)

    useStore.getState().undo()
    expect(times()).toEqual([1, 3])
    expect(posTimes()).toEqual([2])
  })

  // Clamping each keyframe on its own would bunch the selection up against
  // whichever one hit its neighbour first, silently retiming a move he only
  // meant to shift. One delta, clamped once, for the whole set.
  it('clamps the whole set by one delta when a pick runs into an unpicked neighbour', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 4 })
    addKeyframeAtPlayhead(c.id, 'scale') // the wall: NOT picked
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'posX')

    const picks: KeyframePick[] = [
      { channel: 'scale', t: 1 },
      { channel: 'scale', t: 3 },
      { channel: 'posX', t: 2 },
    ]
    moveKeyframes(c.id, picks, 2) // far past the wall at 4

    const [a, b, wall] = times()
    expect(wall).toBeCloseTo(4, 6) // the unpicked keyframe never moved
    expect(b - a).toBeCloseTo(2, 6) // spacing survives the clamp
    expect(posTimes()[0] - a).toBeCloseTo(1, 6)
    // Stopped one FRAME short of the wall (30fps sequence), not on top of it.
    expect(wall - b).toBeCloseTo(1 / 30, 6)
  })
})

describe('scaleKeyframeSpan', () => {
  const scaleValues = () => channelKeyframes(firstClip(), 'scale').map((k) => k.value)

  it('stretches a move around its anchor without reordering the keyframes', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale') // value 1 at t=1
    useStore.getState().setUI({ playheadS: 2 })
    setChannel(c.id, 'scale', 1.2)
    useStore.getState().setUI({ playheadS: 3 })
    setChannel(c.id, 'scale', 1.4)
    expect(times()).toEqual([1, 2, 3])
    expect(scaleValues()).toEqual([1, 1.2, 1.4])

    const picks: KeyframePick[] = [
      { channel: 'scale', t: 1 },
      { channel: 'scale', t: 2 },
      { channel: 'scale', t: 3 },
    ]
    scaleKeyframeSpan(c.id, picks, 1, 1.5) // hold the head, drag the tail out

    const t = times()
    expect(t[0]).toBeCloseTo(1, 6) // the anchor stays put
    expect(t[1]).toBeCloseTo(2.5, 6)
    expect(t[2]).toBeCloseTo(4, 6)
    // Each keyframe still carries its own value, in the order it was written:
    // a stretch that reordered them would swap the values, not just the times.
    expect(scaleValues()).toEqual([1, 1.2, 1.4])
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1])

    useStore.getState().undo()
    expect(times()).toEqual([1, 2, 3])
  })

  it('refuses a factor that would fold the move through its anchor', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale')

    const picks: KeyframePick[] = [
      { channel: 'scale', t: 1 },
      { channel: 'scale', t: 3 },
    ]
    const projBefore = useStore.getState().project
    scaleKeyframeSpan(c.id, picks, 2, -1)
    expect(useStore.getState().project).toBe(projBefore)
    expect(times()).toEqual([1, 3])
  })
})

// A preset compiles straight into clip.keyframes, so every caption shows
// grabbable diamonds, but a transform edit used to recompile the channel from
// the spec and throw the retime away. Retiming now takes the clip off its preset.
describe('retiming a keyframe a PRESET compiled', () => {
  const scaleTimes = () => channelKeyframes(firstClip(), 'scale').map((k) => k.t)

  it('survives the next monitor drag: the retime is not recompiled away', () => {
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

  // Clamping used to park the dragged moment 2e-4s from its neighbour: two
  // diamonds on the same pixel at any zoom, and the next drag grabs whichever
  // the DOM lists first.
  it('a drag onto a neighbour stops one FRAME short, not a fifth of a millisecond', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale')

    moveClipKeyframe(c.id, 1, 3) // drag the first moment right onto the second

    const [a, b] = channelKeyframes(firstClip(), 'scale').map((k) => k.t)
    expect(b - a).toBeGreaterThanOrEqual(1 / 30 - 1e-9) // the sequence runs at 30fps
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
