import { describe, expect, it } from 'vitest'
import {
  MAX_RAIL_PX_PER_S,
  MIN_RAIL_PX_PER_S,
  clampPxPerS,
  clampStart,
  fitView,
  keyframeKey,
  panBy,
  railMinGapS,
  railSnap,
  railTicks,
  tickStepS,
  zoomAt,
} from './motionRuler'

// The rail he actually gets: a 20-second clip in the inspector's ~240px.
const DUR = 20
const VIEW_W = 240

describe('clampPxPerS', () => {
  it('holds the zoom between 8 and 2000 px/s', () => {
    expect(clampPxPerS(0.001)).toBe(MIN_RAIL_PX_PER_S)
    expect(clampPxPerS(1e9)).toBe(MAX_RAIL_PX_PER_S)
    expect(clampPxPerS(120)).toBe(120)
    expect(clampPxPerS(Number.NaN)).toBeGreaterThan(0)
  })
})

describe('fitView', () => {
  it('fits the whole clip and parks at its head', () => {
    const v = fitView(DUR, VIEW_W)
    expect(v.startS).toBe(0)
    expect(v.pxPerS).toBeCloseTo(VIEW_W / DUR, 9)
    // The clip ends exactly at the right edge.
    expect(v.pxPerS * DUR).toBeCloseTo(VIEW_W, 9)
  })

  it('stops at the zoom floor rather than fitting an hour into a panel', () => {
    expect(fitView(3600, VIEW_W).pxPerS).toBe(MIN_RAIL_PX_PER_S)
  })

  it('survives a zero-length clip and an unmeasured rail', () => {
    expect(fitView(0, VIEW_W).pxPerS).toBeGreaterThan(0)
    expect(fitView(DUR, 0).startS).toBe(0)
  })
})

describe('clampStart', () => {
  it('pins to the head while the whole clip fits', () => {
    const v = fitView(DUR, VIEW_W)
    expect(clampStart(5, DUR, v.pxPerS, VIEW_W)).toBe(0)
    expect(clampStart(-5, DUR, v.pxPerS, VIEW_W)).toBe(0)
  })

  it('stops with the clip tail at the right edge once zoomed in', () => {
    const pxPerS = 120 // 2s of the 20s clip visible
    expect(clampStart(99, DUR, pxPerS, VIEW_W)).toBeCloseTo(DUR - VIEW_W / pxPerS, 9)
  })
})

describe('zoomAt', () => {
  it('keeps the time under the pointer under the pointer', () => {
    const view = fitView(DUR, VIEW_W)
    const pointerPx = 180
    const tUnder = view.startS + pointerPx / view.pxPerS
    let next = view
    for (let i = 0; i < 6; i++) next = zoomAt(next, 1.2, pointerPx, DUR, VIEW_W)
    expect(next.pxPerS).toBeGreaterThan(view.pxPerS)
    expect(next.startS + pointerPx / next.pxPerS).toBeCloseTo(tUnder, 6)
  })

  it('reaches a 5-frame punch that was two pixels wide at the fit', () => {
    const fit = fitView(DUR, VIEW_W)
    const punchS = 5 / 24
    expect(fit.pxPerS * punchS).toBeLessThan(3) // ungrabbable, which is the point
    let next = fit
    while (next.pxPerS * punchS < 40) {
      const zoomed = zoomAt(next, 1.2, 0, DUR, VIEW_W)
      if (zoomed === next) break
      next = zoomed
    }
    expect(next.pxPerS * punchS).toBeGreaterThanOrEqual(40)
    expect(next.pxPerS).toBeLessThanOrEqual(MAX_RAIL_PX_PER_S)
  })

  it('hands the same view back at the ceiling and the floor', () => {
    const top = { pxPerS: MAX_RAIL_PX_PER_S, startS: 0 }
    expect(zoomAt(top, 1.2, 100, DUR, VIEW_W)).toBe(top)
    const bottom = { pxPerS: MIN_RAIL_PX_PER_S, startS: 0 }
    expect(zoomAt(bottom, 1 / 1.2, 100, DUR, VIEW_W)).toBe(bottom)
  })

  it('never leaves the clip when zooming out at the tail', () => {
    const zoomed = { pxPerS: 400, startS: DUR - VIEW_W / 400 }
    const out = zoomAt(zoomed, 1 / 1.2, VIEW_W, DUR, VIEW_W)
    expect(out.startS).toBeGreaterThanOrEqual(0)
    expect(out.startS + VIEW_W / out.pxPerS).toBeLessThanOrEqual(DUR + 1e-9)
  })
})

describe('panBy', () => {
  it('moves the content with the pointer', () => {
    const view = { pxPerS: 120, startS: 5 }
    // Dragging left (negative dx) reveals LATER time.
    expect(panBy(view, -60, DUR, VIEW_W).startS).toBeCloseTo(5.5, 9)
    expect(panBy(view, 60, DUR, VIEW_W).startS).toBeCloseTo(4.5, 9)
  })

  it('cannot pan off either end, and returns the same view when it cannot move', () => {
    const view = { pxPerS: 120, startS: 0 }
    expect(panBy(view, 500, DUR, VIEW_W)).toBe(view)
    const end = panBy({ pxPerS: 120, startS: 0 }, -1e6, DUR, VIEW_W)
    expect(end.startS).toBeCloseTo(DUR - VIEW_W / 120, 9)
  })
})

describe('tickStepS', () => {
  it('ticks whole FRAMES once a frame is wide enough to see', () => {
    expect(tickStepS(600, 24)).toBeCloseTo(1 / 24, 9)
    expect(tickStepS(240, 30)).toBeCloseTo(1 / 30, 9)
  })

  it('climbs to seconds and beyond as the rail zooms out', () => {
    expect(tickStepS(12, 30)).toBe(1)
    expect(tickStepS(MIN_RAIL_PX_PER_S, 30)).toBe(1)
    expect(tickStepS(1, 30)).toBe(10)
  })

  it('never returns a step so small the ticks read as a filled bar', () => {
    for (const pxPerS of [8, 13, 30, 77, 200, 999, 2000]) {
      expect(tickStepS(pxPerS, 30) * pxPerS).toBeGreaterThanOrEqual(6)
    }
  })
})

describe('railTicks', () => {
  it('returns only what is on screen, in order, from the left edge', () => {
    const view = { pxPerS: 300, startS: 8 }
    const ticks = railTicks(view, VIEW_W, DUR, 30)
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks[0].t).toBeGreaterThanOrEqual(view.startS - 1e-9)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].t).toBeGreaterThan(ticks[i - 1].t)
    for (const tick of ticks) {
      expect(tick.px).toBeGreaterThanOrEqual(-1e-9)
      expect(tick.px).toBeLessThanOrEqual(VIEW_W + 1e-9)
      expect(tick.px).toBeCloseTo((tick.t - view.startS) * view.pxPerS, 9)
    }
  })

  it('stops at the end of the clip', () => {
    const ticks = railTicks({ pxPerS: 8, startS: 0 }, 400, DUR, 30)
    for (const tick of ticks) expect(tick.t).toBeLessThanOrEqual(DUR + 1e-9)
  })

  it('leaves room between the timecode labels at every zoom', () => {
    for (const pxPerS of [8, 30, 120, 600, 2000]) {
      const ticks = railTicks({ pxPerS, startS: 0 }, VIEW_W, DUR, 30)
      const labelled = ticks.filter((t) => t.major)
      for (let i = 1; i < labelled.length; i++) {
        expect(labelled[i].px - labelled[i - 1].px).toBeGreaterThanOrEqual(64 - 1e-9)
      }
    }
  })

  it('draws nothing for a rail with no width and no clip', () => {
    expect(railTicks({ pxPerS: 100, startS: 0 }, 0, DUR, 30)).toEqual([])
    expect(railTicks({ pxPerS: 100, startS: 0 }, VIEW_W, 0, 30)).toEqual([])
  })
})

describe('railSnap', () => {
  it('lands keyframes on frame boundaries', () => {
    expect(railSnap(0.51, 24, DUR)).toBeCloseTo(12 / 24, 9)
    expect(railSnap(1 / 30 + 0.004, 30, DUR)).toBeCloseTo(1 / 30, 9)
  })

  it('holds the snapped time inside the clip', () => {
    expect(railSnap(-3, 30, DUR)).toBe(0)
    expect(railSnap(DUR + 3, 30, DUR)).toBe(DUR)
  })
})

describe('railMinGapS', () => {
  it('is ONE FRAME, not the engine arithmetic minimum', () => {
    expect(railMinGapS(24)).toBeCloseTo(1 / 24, 9)
    expect(railMinGapS(30)).toBeCloseTo(1 / 30, 9)
    expect(railMinGapS(60)).toBeCloseTo(1 / 60, 9)
    // The whole reason it exists: two diamonds this far apart are two diamonds.
    expect(railMinGapS(60)).toBeGreaterThan(1e-4 * 2)
  })

  it('falls back to 30fps rather than dividing by zero', () => {
    expect(railMinGapS(0)).toBeCloseTo(1 / 30, 9)
  })
})

describe('keyframeKey', () => {
  it('gives one keyframe one identity at moment resolution', () => {
    expect(keyframeKey('scale', 1.5)).toBe(keyframeKey('scale', 1.50004))
    expect(keyframeKey('scale', 1.5)).not.toBe(keyframeKey('posX', 1.5))
    expect(keyframeKey('scale', 1.5)).not.toBe(keyframeKey('scale', 1.6))
  })
})
