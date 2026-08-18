// The keyframe keyboard. These verbs aim at the motion rail's selection, which
// lives in ui state precisely so a test can set it without mounting a rail.
//
// ⛔ THE TWO-PRESS CASE IS THE POINT OF THIS FILE. A pick is a channel plus a
// TIME, so a verb that moves keyframes and forgets to re-aim its own picks works
// perfectly once and is dead on every press after. That failure is invisible in
// a screenshot and invisible in a one-press test.

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
import { addKeyframeAtPlayhead, toggleChannelAnimation, type KeyframePick } from './clipEdits'
import {
  addKeyframeInSegment,
  copyPicks,
  deletePicks,
  motionKeyTarget,
  nudgePicks,
  pastePicks,
  segmentMidpoint,
  stretchPicks,
  walkSelection,
  STRETCH_STEP,
} from './motionKeys'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const firstClip = () => seq().tracks[0].clips[0]
const times = () => channelKeyframes(firstClip(), 'scale').map((k) => k.t)
const picks = () => useStore.getState().ui.motionPicks
const frame = () => 1 / seq().fps

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

/** A clip with scale keyframes at t=1 and t=3, both picked, the door open. */
function seedTwoDiamonds(): Clip {
  const c = seedTitle()
  useStore.getState().setUI({ playheadS: 1 })
  toggleChannelAnimation(c.id, 'scale')
  useStore.getState().setUI({ playheadS: 3 })
  addKeyframeAtPlayhead(c.id, 'scale')
  const p: KeyframePick[] = [
    { channel: 'scale', t: 1 },
    { channel: 'scale', t: 3 },
  ]
  useStore.getState().setUI({
    selection: [c.id],
    handTuneOpen: true,
    motionPicks: p,
    motionSelection: { channel: 'scale', kind: 'key', t: 1 },
  })
  return c
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({
    selection: [],
    playheadS: 0,
    handTuneOpen: false,
    motionPicks: [],
    motionSelection: null,
    motionGroupDeltaS: null,
  })
})

describe('motionKeyTarget', () => {
  it('is null with the hand controls closed, even with diamonds picked', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ handTuneOpen: false })
    // Closed door, closed keyboard: the diamonds are not on screen, so Alt+Left
    // has to go back to meaning the clip.
    expect(motionKeyTarget()).toBeNull()
  })

  it('is null with the door open and nothing picked', () => {
    const c = seedTitle()
    useStore.getState().setUI({ selection: [c.id], handTuneOpen: true, motionPicks: [] })
    expect(motionKeyTarget()).toBeNull()
  })

  it('is null when no clip is selected', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ selection: [] })
    expect(motionKeyTarget()).toBeNull()
  })

  it('is the clip and its picks when the door is open and diamonds are picked', () => {
    const c = seedTwoDiamonds()
    expect(motionKeyTarget()?.clipId).toBe(c.id)
    expect(motionKeyTarget()?.picks).toHaveLength(2)
  })
})

describe('nudgePicks', () => {
  it('moves every picked diamond by one frame', () => {
    seedTwoDiamonds()
    nudgePicks(1)
    expect(times()[0]).toBeCloseTo(1 + frame(), 6)
    expect(times()[1]).toBeCloseTo(3 + frame(), 6)
  })

  it('re-aims its own picks, so a SECOND press moves them again', () => {
    seedTwoDiamonds()
    nudgePicks(1)
    nudgePicks(1)
    // Without the re-aim the picks still point at 1 and 3, match no keyframe,
    // and the second press is a silent no-op.
    expect(times()[0]).toBeCloseTo(1 + 2 * frame(), 6)
    expect(times()[1]).toBeCloseTo(3 + 2 * frame(), 6)
    expect(picks()[0].t).toBeCloseTo(1 + 2 * frame(), 6)
  })

  it('carries the highlighted diamond with the picks', () => {
    seedTwoDiamonds()
    nudgePicks(10)
    const sel = useStore.getState().ui.motionSelection
    expect(sel?.t).toBeCloseTo(1 + 10 * frame(), 6)
  })

  it('holds the picks still when the clamp refused the move', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 0 })
    toggleChannelAnimation(c.id, 'scale') // kf at t=0, the head of the clip
    useStore.getState().setUI({
      selection: [c.id],
      handTuneOpen: true,
      motionPicks: [{ channel: 'scale', t: 0 }],
      motionSelection: { channel: 'scale', kind: 'key', t: 0 },
    })
    nudgePicks(-10) // nowhere to go: t=0 is the head
    expect(times()).toEqual([0])
    expect(picks()[0].t).toBe(0)
  })

  it('does nothing at all with the door shut', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ handTuneOpen: false })
    nudgePicks(1)
    expect(times()).toEqual([1, 3])
  })
})

describe('deletePicks', () => {
  it('drops every picked diamond in one undo step and clears the selection', () => {
    seedTwoDiamonds()
    deletePicks()
    expect(times()).toEqual([])
    expect(picks()).toEqual([])
    expect(useStore.getState().ui.motionSelection).toBeNull()
    useStore.getState().undo()
    expect(times()).toEqual([1, 3])
  })

  it('leaves an unpicked diamond exactly where it was', () => {
    const c = seedTwoDiamonds()
    useStore.getState().setUI({ playheadS: 4 })
    addKeyframeAtPlayhead(c.id, 'scale')
    deletePicks()
    expect(times()).toEqual([4])
  })

  it('de-animates the channel when the last diamond goes, holding its value', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    const held = channelKeyframes(firstClip(), 'scale')[0].value
    useStore.getState().setUI({
      selection: [c.id],
      handTuneOpen: true,
      motionPicks: [{ channel: 'scale', t: 1 }],
    })
    deletePicks()
    // The same landing as the lane's own trash button: the channel collapses to
    // a static number at the value it had, so the picture does not jump.
    expect(channelKeyframes(firstClip(), 'scale')).toEqual([])
    expect(firstClip().transform?.scale ?? held).toBeCloseTo(held, 6)
  })
})

describe('stretchPicks', () => {
  it('grows the run out of its first diamond, which does not move', () => {
    seedTwoDiamonds()
    stretchPicks(STRETCH_STEP)
    expect(times()[0]).toBeCloseTo(1, 6)
    expect(times()[1]).toBeCloseTo(1 + 2 * STRETCH_STEP, 6)
  })

  it('re-aims its picks, so squeezing twice compounds', () => {
    seedTwoDiamonds()
    stretchPicks(1 / STRETCH_STEP)
    stretchPicks(1 / STRETCH_STEP)
    expect(times()[1]).toBeCloseTo(1 + 2 / (STRETCH_STEP * STRETCH_STEP), 6)
  })

  it('is a round trip: slower then faster is where it started', () => {
    seedTwoDiamonds()
    stretchPicks(STRETCH_STEP)
    stretchPicks(1 / STRETCH_STEP)
    expect(times()[1]).toBeCloseTo(3, 6)
  })
})

describe('copyPicks / pastePicks', () => {
  it('drops the copied run at the playhead, keeping its spacing', () => {
    seedTwoDiamonds()
    expect(copyPicks()).toBe(true)
    useStore.getState().setUI({ playheadS: 1.5 })
    expect(pastePicks()).toBe(true)
    // Copied at 1 and 3, so two seconds apart, pasted from 1.5.
    expect(times()).toEqual([1, 1.5, 3, 3.5])
  })

  it('carries the ease and the hand-shaped curve, not just the time', () => {
    const c = seedTwoDiamonds()
    const curve = [0.1, 0.9, 0.4, 1] as const
    updateActiveSequence('shape it', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((cl) =>
          cl.id === c.id && cl.keyframes?.scale
            ? {
                ...cl,
                keyframes: {
                  ...cl.keyframes,
                  scale: cl.keyframes.scale.map((k) =>
                    k.t === 1 ? { ...k, ease: 'easeOut' as const, curve } : k,
                  ),
                },
              }
            : cl,
        ),
      })),
    }))
    copyPicks()
    useStore.getState().setUI({ playheadS: 1.5 })
    pastePicks()
    const landed = channelKeyframes(firstClip(), 'scale').find((k) => k.t === 1.5)
    // A paste that dropped these would hand back a linear move and say nothing.
    expect(landed?.ease).toBe('easeOut')
    expect(landed?.curve).toEqual(curve)
  })

  it('selects what landed, so a nudge straight after moves the new diamonds', () => {
    seedTwoDiamonds()
    copyPicks()
    useStore.getState().setUI({ playheadS: 1.5 })
    pastePicks()
    expect(picks().map((p) => p.t)).toEqual([1.5, 3.5])
    nudgePicks(1)
    expect(times()[1]).toBeCloseTo(1.5 + frame(), 6)
  })

  it('merges onto a diamond already at that moment rather than doubling it', () => {
    seedTwoDiamonds()
    copyPicks()
    useStore.getState().setUI({ playheadS: 1 }) // paste back on top of itself
    pastePicks()
    expect(times()).toEqual([1, 3])
  })

  it('refuses to paste past the end of the clip', () => {
    seedTwoDiamonds()
    copyPicks()
    useStore.getState().setUI({ playheadS: 4.5 })
    pastePicks()
    // The run is 2s long from 4.5 on a 5s clip, so the tail falls outside and
    // is dropped; the head still lands.
    expect(times()).toEqual([1, 3, 4.5])
  })

  it('copies nothing with the door shut, and paste falls through', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ handTuneOpen: false })
    expect(copyPicks()).toBe(false)
    expect(pastePicks()).toBe(false)
  })
})

describe('walkSelection', () => {
  it('steps the highlight to the next diamond on the same channel', () => {
    seedTwoDiamonds()
    walkSelection(1)
    expect(useStore.getState().ui.motionSelection?.t).toBe(3)
    expect(picks()).toEqual([{ channel: 'scale', t: 3 }])
  })

  it('steps back', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ motionSelection: { channel: 'scale', kind: 'key', t: 3 } })
    walkSelection(-1)
    expect(useStore.getState().ui.motionSelection?.t).toBe(1)
  })

  it('stops at the last diamond rather than wrapping', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ motionSelection: { channel: 'scale', kind: 'key', t: 3 } })
    walkSelection(1)
    expect(useStore.getState().ui.motionSelection?.t).toBe(3)
  })
})

describe('segmentMidpoint', () => {
  const kf = (t: number) => ({ t, value: 0, ease: 'linear' as const })

  it('is halfway to the next diamond', () => {
    expect(segmentMidpoint([kf(1), kf(3)], 1, 5)).toBe(2)
  })

  it('is null on the LAST diamond, which leaves no segment', () => {
    expect(segmentMidpoint([kf(1), kf(3)], 3, 5)).toBeNull()
  })

  it('is null when the time names no diamond', () => {
    expect(segmentMidpoint([kf(1), kf(3)], 2, 5)).toBeNull()
  })
})

describe('addKeyframeInSegment', () => {
  it('adds a diamond in the middle of the selected segment, not at the playhead', () => {
    seedTwoDiamonds()
    // The playhead is deliberately somewhere else: this verb exists so he does
    // not have to park it first.
    useStore.getState().setUI({ playheadS: 4.5, motionSelection: { channel: 'scale', kind: 'key', t: 1 } })
    addKeyframeInSegment()
    expect(times()).toEqual([1, 2, 3])
    expect(useStore.getState().ui.motionSelection?.t).toBe(2)
  })

  it('does not change the picture: the new diamond takes the value it already had', () => {
    const c = seedTitle()
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(c.id, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    addKeyframeAtPlayhead(c.id, 'scale')
    updateActiveSequence('shape it', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((cl) =>
          cl.id === c.id && cl.keyframes?.scale
            ? {
                ...cl,
                keyframes: {
                  ...cl.keyframes,
                  scale: cl.keyframes.scale.map((k) => (k.t === 3 ? { ...k, value: 2 } : k)),
                },
              }
            : cl,
        ),
      })),
    }))
    useStore.getState().setUI({
      selection: [c.id],
      handTuneOpen: true,
      motionSelection: { channel: 'scale', kind: 'key', t: 1 },
      motionPicks: [{ channel: 'scale', t: 1 }],
    })
    const before = channelKeyframes(firstClip(), 'scale')
    const startValue = before[0].value
    addKeyframeInSegment()
    const mid = channelKeyframes(firstClip(), 'scale').find((k) => k.t === 2)
    // Halfway along a linear ramp from startValue to 2.
    expect(mid?.value).toBeCloseTo(startValue + (2 - startValue) / 2, 6)
  })

  it('does nothing on the last diamond', () => {
    seedTwoDiamonds()
    useStore.getState().setUI({ motionSelection: { channel: 'scale', kind: 'key', t: 3 } })
    addKeyframeInSegment()
    expect(times()).toEqual([1, 3])
  })
})
