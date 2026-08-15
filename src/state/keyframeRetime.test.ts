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
  clampKeyframesDelta,
  moveClipKeyframe,
  moveKeyframeTime,
  moveKeyframes,
  scaleKeyframeSpan,
  setKeyframeValueAt,
  setSegmentCurve,
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

  /**
   * ⛔ THE LANE DRAWS THE DRAG LIVE, AND IT MUST LAND WHERE THE COMMIT LANDS.
   *
   * The lane clamps each pointermove through this exact function and the commit
   * clamps through it too. Compute the limit twice, in two files, and the
   * diamonds visibly jump back on release, which reads as the app undoing the
   * drag he just made. So the two are pinned to each other here.
   */
  it('hands the lane the same delta the commit will use, at the wall and inside it', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 4 })
    addKeyframeAtPlayhead(c.id, 'scale') // the wall: NOT picked

    const picks: KeyframePick[] = [
      { channel: 'scale', t: 1 },
      { channel: 'scale', t: 3 },
    ]
    for (const asked of [0.25, 2, -5]) {
      const preview = clampKeyframesDelta(firstClip(), picks, asked, 30)
      const before = times()[1]
      moveKeyframes(c.id, picks, asked)
      expect(times()[1] - before, `asked for ${asked}`).toBeCloseTo(preview, 6)
      useStore.getState().undo()
    }
  })

  it('answers zero rather than a guess when the picks are not on the clip', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    expect(clampKeyframesDelta(firstClip(), [{ channel: 'posY', t: 9 }], 1, 30)).toBe(0)
    expect(clampKeyframesDelta(firstClip(), [], 1, 30)).toBe(0)
  })
})

/**
 * ⛔ HE COULD TYPE WHEN A MOMENT HAPPENS AND NOT WHAT IT IS.
 *
 * Correcting a number already set meant parking the playhead exactly on that
 * moment and using the property row, which is doable and which nobody finds.
 * The audit named it beside the lasso as the other half of the customizability
 * gap.
 */
describe('setKeyframeValueAt', () => {
  const values = () => channelKeyframes(firstClip(), 'scale').map((k) => k.value)

  it('retypes one moment and leaves every other one alone', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    setChannel(c.id, 'scale', 1.4)
    expect(values()).toEqual([1, 1.4])

    setKeyframeValueAt(c.id, 'scale', 3, 1.8)
    expect(values()).toEqual([1, 1.8])
    expect(times()).toEqual([1, 3]) // the moment did not move

    useStore.getState().undo()
    expect(values()).toEqual([1, 1.4])
  })

  // ⛔ The same rule upsertKeyframeValue exists for: a number he corrects must
  // never redraw a curve he shaped.
  it('keeps the ease and the curve the moment was carrying', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    setChannel(c.id, 'scale', 1.4)
    setSegmentCurve(c.id, 'scale', 1, [0.16, 1, 0.3, 1])
    const shaped = channelKeyframes(firstClip(), 'scale')[0]

    setKeyframeValueAt(c.id, 'scale', 1, 1.1)
    const after = channelKeyframes(firstClip(), 'scale')[0]
    expect(after.value).toBe(1.1)
    expect(after.ease).toBe(shaped.ease)
    expect(after.curve).toEqual(shaped.curve)
  })

  it('costs nothing when the number is already what he typed', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    const depth = useStore.getState().history.undo.length
    setKeyframeValueAt(c.id, 'scale', 1, channelKeyframes(firstClip(), 'scale')[0].value)
    setKeyframeValueAt(c.id, 'scale', 9, 2) // no keyframe there at all
    expect(useStore.getState().history.undo.length).toBe(depth)
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
