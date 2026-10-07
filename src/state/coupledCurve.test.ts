// A zoom to a point writes Zoom AND Position with the same knots and the same
// curve, so the point holds still. Shaping only the Zoom (or picking Overshoot)
// let the position run ahead of the zoom and the face slid across the frame
// before it settled (2026-10-06).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelKeyframes, resolveChannel } from '../engine/effects/channels'
import { MOTION_CURVES, punchInClip } from '../engine/motion'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { coupledSegmentChannels, setAllSegmentCurves, setSegmentCurve, setSegmentEase } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const clip = (): Clip => activeSequence(useStore.getState().project).tracks[0]!.clips[0]!
const FOCAL = { x: 900, y: 500 }

/** A clip punched in at 1 s toward FOCAL on a 1920x1080 frame. */
function punched(): Clip {
  const c = punchInClip(newTitleClip(defaultTitleDef('x'), 0, 5), 30, {
    atS: 1,
    targetScale: 1.5,
    riseFrames: 15,
    holdToEnd: true,
    focal: FOCAL,
    seqWidth: 1920,
    seqHeight: 1080,
  })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [c] } : t)) }),
  )
  return c
}

/** Where the focal point lands on screen, relative to the frame centre. */
const focalAt = (c: Clip, t: number) => ({
  x: resolveChannel(c, 'posX', t) + (FOCAL.x - 960) * resolveChannel(c, 'scale', t),
  y: resolveChannel(c, 'posY', t) + (FOCAL.y - 540) * resolveChannel(c, 'scale', t),
})

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('shaping the Zoom of a zoom to a point', () => {
  it('finds Position moving in step with it', () => {
    punched()
    expect(coupledSegmentChannels(clip(), 'scale', 1)).toEqual(['scale', 'posX', 'posY'])
  })

  it('gives Position the same curve, so the point holds still all the way', () => {
    punched()
    setSegmentCurve(clip().id, 'scale', 1, MOTION_CURVES.overshoot, { coupled: true })
    for (const ch of ['scale', 'posX', 'posY'] as const) {
      expect(channelKeyframes(clip(), ch)[0]!.curve).toEqual(MOTION_CURVES.overshoot)
    }
    const at0 = focalAt(clip(), 1)
    for (const t of [1.1, 1.2, 1.25, 1.35, 1.45]) {
      expect(focalAt(clip(), t).x).toBeCloseTo(at0.x, 6)
      expect(focalAt(clip(), t).y).toBeCloseTo(at0.y, 6)
    }
    // One undo takes the shape off all three.
    useStore.getState().undo()
    expect(channelKeyframes(clip(), 'posX')[0]!.curve).toEqual(MOTION_CURVES.snapIn)
  })

  it('a named ease goes on all of them too', () => {
    punched()
    setSegmentEase(clip().id, 'scale', 1, 'easeInOut', { coupled: true })
    for (const ch of ['scale', 'posX', 'posY'] as const) {
      expect(channelKeyframes(clip(), ch)[0]).toMatchObject({ ease: 'easeInOut' })
      expect(channelKeyframes(clip(), ch)[0]!.curve).toBeUndefined()
    }
  })

  it('without the option only the one channel changes, as before', () => {
    punched()
    setSegmentCurve(clip().id, 'scale', 1, MOTION_CURVES.overshoot)
    expect(channelKeyframes(clip(), 'posX')[0]!.curve).toEqual(MOTION_CURVES.snapIn)
  })

  // Review, 2026-10-07: "Apply to all segments" shaped the Zoom alone, so the
  // face slid again while the header said Position follows.
  it('Apply to all segments shapes Position with the Zoom, so the point holds still', () => {
    punched()
    setAllSegmentCurves(clip().id, 'scale', MOTION_CURVES.overshoot, { coupled: true })
    for (const ch of ['scale', 'posX', 'posY'] as const) {
      expect(channelKeyframes(clip(), ch)[0]!.curve).toEqual(MOTION_CURVES.overshoot)
    }
    const at0 = focalAt(clip(), 1)
    for (const t of [1.1, 1.25, 1.45]) {
      expect(focalAt(clip(), t).x).toBeCloseTo(at0.x, 6)
      expect(focalAt(clip(), t).y).toBeCloseTo(at0.y, 6)
    }
    useStore.getState().undo()
    expect(channelKeyframes(clip(), 'posX')[0]!.curve).toEqual(MOTION_CURVES.snapIn)
  })
})
