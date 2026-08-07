import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelKeyframes, resolveChannel } from '../engine/effects/channels'
import { evalChannel } from '../engine/keyframes'
import { clipEndS, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newId,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import {
  cutPunchAtPlayhead,
  impactAtPlayhead,
  punchInAtPlayhead,
  punchOutAtPlayhead,
  rampWorkArea,
  whipToNext,
} from './motionActions'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const v1 = () => seq().tracks[0]
const a1 = () => seq().tracks[2]

function seedClip(startS: number, durS: number): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), startS, durS)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

/** A linked A/V pair: V1 and A1 sharing one link group, the way a cut sees it. */
function seedLinkedPair(startS: number, durS: number): { video: Clip; audio: Clip } {
  const linkId = newId()
  const video: Clip = { ...newTitleClip(defaultTitleDef('x'), startS, durS), linkId }
  const audio: Clip = { ...newTitleClip(defaultTitleDef('x'), startS, durS), id: newId(), title: undefined, linkId }
  updateActiveSequence('seed pair', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0 ? { ...t, clips: [...t.clips, video] } : i === 2 ? { ...t, clips: [...t.clips, audio] } : t,
      ),
    }),
  )
  return { video, audio }
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  // The motion UI state the actions read. Set explicitly here rather than left
  // to the store defaults, because these three ARE the move: a punch that read a
  // different rise or a different anchor would be a different gesture.
  useStore.getState().setUI({
    selection: [],
    playheadS: 0,
    punchDepth: 1.2,
    punchRiseFrames: 5,
    zoomAnchor: { x: 0.5, y: 0.4 },
  })
})

describe('punchInAtPlayhead / impactAtPlayhead', () => {
  it('writes the zoom at the playhead in one undo step', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 5 })
    punchInAtPlayhead(clip.id)
    const c = v1().clips[0]
    expect(evalChannel(c.keyframes?.scale, 3 + 5 / 30, 1)).toBeCloseTo(1.2, 5)
    useStore.getState().undo()
    expect(v1().clips[0].keyframes?.scale).toBeUndefined()
  })

  it('refuses when the playhead is outside the clip', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 0.5 })
    punchInAtPlayhead(clip.id)
    impactAtPlayhead(clip.id)
    expect(v1().clips[0].keyframes).toBeUndefined()
  })

  // The whole reason "punch out at any time in the clip" is expressible now: the
  // punch no longer schedules its own return, so the frame stays where he put it
  // until he says otherwise.
  it('HOLDS at the target to the end of the clip instead of sliding back', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 5 })
    punchInAtPlayhead(clip.id)
    const c = v1().clips[0]
    // Two knots only: the foot of the rise and the top. No hold, no return leg.
    expect(channelKeyframes(c, 'scale')).toHaveLength(2)
    expect(resolveChannel(c, 'scale', 3 + 5 / 30)).toBeCloseTo(1.2, 5)
    // Well past where the old envelope would have dropped it back to base.
    expect(resolveChannel(c, 'scale', 9.5)).toBeCloseTo(1.2, 5)
  })

  it('zooms toward the zoom anchor, co-timing posX and posY with the scale keyframes', () => {
    const clip = seedClip(0, 10)
    // Off centre on BOTH axes, so a focal that was never passed shows up as two
    // channels that simply never got written.
    useStore.getState().setUI({ playheadS: 4, zoomAnchor: { x: 0.25, y: 0.25 } })
    punchInAtPlayhead(clip.id)
    const c = v1().clips[0]

    const times = (ch: 'scale' | 'posX' | 'posY') => channelKeyframes(c, ch).map((k) => k.t)
    expect(times('scale')).toEqual([4, 4 + 5 / 30])
    expect(times('posX')).toEqual(times('scale'))
    expect(times('posY')).toEqual(times('scale'))

    // The focal point holds still: a point f px from centre lands at f*r after
    // scaling, so the layer shifts by -f*(r-1). Anchor 0.25 of 1920 is 480 px
    // left of centre, 0.25 of 1080 is 270 px above it.
    expect(resolveChannel(c, 'posX', 4 + 5 / 30)).toBeCloseTo(480 * 0.2, 4)
    expect(resolveChannel(c, 'posY', 4 + 5 / 30)).toBeCloseTo(270 * 0.2, 4)
  })

  it('impact writes the desat/blur/scale pulse', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 6 })
    impactAtPlayhead(clip.id)
    const c = v1().clips[0]
    // Colour lives in the EFFECT STACK, so assert where the renderer reads.
    expect(resolveChannel(c, 'saturation', 4)).toBeCloseTo(-0.9, 5)
    expect(resolveChannel(c, 'blur', 4)).toBeCloseTo(6, 5)
    expect(c.effects.map((e) => e.type).sort()).toEqual(['gaussianBlur', 'saturation'])
  })
})

describe('punchOutAtPlayhead', () => {
  it('falls to the clip BASE and holds there for the rest of the clip', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 5 })
    punchInAtPlayhead(clip.id)
    useStore.getState().setUI({ playheadS: 7 })
    punchOutAtPlayhead(clip.id)

    const c = v1().clips[0]
    // Still up where the punch left it, right until the fall starts.
    expect(resolveChannel(c, 'scale', 4.9)).toBeCloseTo(1.2, 5)
    // Landed on base, not on "wherever it was before the punch": anything else
    // drifts a little further from the clip's own framing on every in/out pair
    // and only shows up on export.
    expect(resolveChannel(c, 'scale', 5 + 5 / 30)).toBeCloseTo(1, 5)
    expect(resolveChannel(c, 'scale', 9.5)).toBeCloseTo(1, 5)
    // Position comes home too, so the pair ends exactly where the clip started
    // rather than a few pixels off it.
    expect(resolveChannel(c, 'posY', 9.5)).toBeCloseTo(0, 5)
  })

  it('refuses when the playhead is outside the clip', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 0.5 })
    punchOutAtPlayhead(clip.id)
    expect(v1().clips[0].keyframes).toBeUndefined()
  })
})

describe('cutPunchAtPlayhead', () => {
  it('splits the LINKED audio at the same frame and starts the right half bigger', () => {
    const { video } = seedLinkedPair(0, 8)
    useStore.getState().setUI({ playheadS: 3, punchDepth: 1.4 })

    cutPunchAtPlayhead(video.id)

    // splitGroup, not splitClipOnly: cutting the picture alone would leave the
    // audio whole and the two sides drift apart at the cut.
    expect(v1().clips.map((c) => c.startS)).toEqual([0, 3])
    expect(a1().clips.map((c) => c.startS)).toEqual([0, 3])
    expect(clipEndS(v1().clips[0])).toBeCloseTo(3, 6)

    const [left, right] = v1().clips
    // No animation at all: the right half simply IS bigger.
    expect(right.transform.scale).toBeCloseTo(1.4, 6)
    expect(channelKeyframes(right, 'scale')).toHaveLength(0)
    expect(left.transform.scale).toBeCloseTo(1, 6)
    expect(channelKeyframes(left, 'scale')).toHaveLength(0)
  })

  it('is ONE undo step for the split and the depth together', () => {
    const { video } = seedLinkedPair(0, 8)
    useStore.getState().setUI({ playheadS: 3 })
    cutPunchAtPlayhead(video.id)
    useStore.getState().undo()
    expect(v1().clips).toHaveLength(1)
    expect(a1().clips).toHaveLength(1)
    expect(v1().clips[0].transform.scale).toBeCloseTo(1, 6)
  })

  it('leaves the timeline alone when the cut lands too close to an edge', () => {
    const { video } = seedLinkedPair(0, 8)
    useStore.getState().setUI({ playheadS: 0.001 })
    cutPunchAtPlayhead(video.id)
    expect(v1().clips).toHaveLength(1)
    expect(a1().clips).toHaveLength(1)
    expect(v1().clips[0].transform.scale).toBeCloseTo(1, 6)
  })
})

describe('whipToNext', () => {
  it('adds the directional-blur pair across a touching cut', () => {
    const a = seedClip(0, 4)
    seedClip(4, 4)
    whipToNext(a.id)
    const [ca, cb] = v1().clips
    expect(ca.effects.some((e) => e.type === 'directionalBlur')).toBe(true)
    expect(cb.effects.some((e) => e.type === 'directionalBlur')).toBe(true)
    useStore.getState().undo()
    expect(v1().clips.every((c) => c.effects.length === 0)).toBe(true)
  })

  it('refuses when the next clip does not touch', () => {
    const a = seedClip(0, 4)
    seedClip(6, 4)
    whipToNext(a.id)
    expect(v1().clips.every((c) => c.effects.length === 0)).toBe(true)
  })
})

describe('rampWorkArea', () => {
  it('ramps the in/out range of the clip and selects the sped piece', () => {
    const clip = seedClip(0, 10)
    updateActiveSequence('io', (sq) => ({ ...sq, inPointS: 4, outPointS: 7 }))
    rampWorkArea(clip.id, 2)
    const clips = v1().clips
    expect(clips).toHaveLength(3)
    expect(clips[1].speed).toBe(2)
    expect(clips[1].effects.some((e) => e.type === 'gaussianBlur')).toBe(true)
    expect(useStore.getState().ui.selection).toEqual([clips[1].id])
  })

  it('does nothing without a work area', () => {
    const clip = seedClip(0, 10)
    rampWorkArea(clip.id, 2)
    expect(v1().clips).toHaveLength(1)
    expect(v1().clips[0].speed).toBe(1)
  })
})
