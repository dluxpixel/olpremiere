import { describe, expect, it } from 'vitest'
import { MAX_PX_PER_S, MIN_PX_PER_S } from '../state/store'
import { clampPxPerS, followScrollLeft, frameAtOffset, zoomAroundPlan, zoomFitPxPerS, zoomToPlan } from './timelineZoom'

describe('clampPxPerS', () => {
  it('holds a zoom inside the store range', () => {
    expect(clampPxPerS(0)).toBe(MIN_PX_PER_S)
    expect(clampPxPerS(1e9)).toBe(MAX_PX_PER_S)
    expect(clampPxPerS(60)).toBe(60)
  })
})

describe('zoomAroundPlan (ctrl+wheel)', () => {
  it('keeps the time under the pointer under the pointer', () => {
    // 60px/s, scrolled 600px, pointer 300px in: 15s is under it.
    const plan = zoomAroundPlan(60, 2, 300, 600)!
    expect(plan.pxPerS).toBe(120)
    expect(15 * plan.pxPerS - plan.scrollLeft).toBe(300)
  })

  it('never scrolls before zero', () => {
    expect(zoomAroundPlan(60, 0.5, 300, 0)!.scrollLeft).toBe(0)
  })

  it('does nothing at the zoom limit', () => {
    expect(zoomAroundPlan(MAX_PX_PER_S, 2, 100, 0)).toBeNull()
    expect(zoomAroundPlan(MIN_PX_PER_S, 0.5, 100, 0)).toBeNull()
  })
})

describe('zoomToPlan (keys, toolbar, slider)', () => {
  it('anchors on the playhead when it is in view', () => {
    // View 0..1000px at 100px/s = 0..10s, playhead at 4s sits at 400px.
    const plan = zoomToPlan(100, 200, 0, 1000, 4)!
    expect(plan.pxPerS).toBe(200)
    expect(4 * 200 - plan.scrollLeft).toBe(400)
  })

  it('anchors on the middle of the view when the playhead is off screen', () => {
    // View 10..20s at 100px/s, playhead at 50s: the anchor is 15s at 500px.
    const plan = zoomToPlan(100, 50, 1000, 1000, 50)!
    expect(plan.pxPerS).toBe(50)
    expect(15 * 50 - plan.scrollLeft).toBe(500)
  })

  it('does nothing when the clamped zoom is the current one', () => {
    expect(zoomToPlan(MAX_PX_PER_S, MAX_PX_PER_S * 4, 0, 1000, 0)).toBeNull()
  })
})

describe('zoomFitPxPerS', () => {
  it('fits the sequence with 40px of air', () => {
    expect(zoomFitPxPerS(1040, 10)).toBe(100)
  })

  it('clamps to the zoom range', () => {
    expect(zoomFitPxPerS(1040, 1e6)).toBe(MIN_PX_PER_S)
    expect(zoomFitPxPerS(1e7, 1)).toBe(MAX_PX_PER_S)
  })
})

describe('followScrollLeft', () => {
  it('pages forward 80px behind the playhead when playing runs off the right', () => {
    expect(followScrollLeft(990, 0, 1000, true)).toBe(910)
    expect(followScrollLeft(900, 0, 1000, true)).toBeNull()
  })

  it('does not tug back while playing when he scrolled ahead a little', () => {
    expect(followScrollLeft(500, 1000, 1000, true)).toBeNull()
    // Fully a viewport behind: re-centre.
    expect(followScrollLeft(-1, 1000, 1000, true)).toBe(0)
  })

  it('centres an off-screen jump while paused and leaves an in-view jump alone', () => {
    expect(followScrollLeft(5000, 0, 1000, false)).toBe(4500)
    expect(followScrollLeft(999, 0, 1000, false)).toBeNull()
    expect(followScrollLeft(100, 1000, 1000, false)).toBe(0)
  })
})

describe('frameAtOffset', () => {
  it('quantizes to the frame and never goes before zero', () => {
    expect(frameAtOffset(-50, 100, 30)).toBe(0)
    expect(frameAtOffset(100, 100, 30)).toBe(1)
    expect(frameAtOffset(101, 100, 30)).toBeCloseTo(1, 10)
  })
})
