// The delivery counter, and why it exists.
//
// previewHealth answers "was the picture the right frame" and cannot answer
// "did the picture arrive at all". Three separate harnesses reported the
// preview as healthy while he was watching it stutter, because a loop that
// paints every other frame scores a perfect zero error on the frames it does
// paint: the dropped ones are never sampled. These tests pin the difference.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { previewPacing, recordPreviewTick, resetPreviewPacing } from './previewTruth'

/** Drive performance.now() by hand so a test never depends on wall clock. */
let clock = 0
beforeEach(() => {
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  resetPreviewPacing()
})

const tick = (frame: number, painted: boolean, advanceMs = 8) => {
  recordPreviewTick(frame, painted)
  clock += advanceMs
}

describe('previewPacing', () => {
  it('reports nothing rather than a flattering zero before anything plays', () => {
    expect(previewPacing().ticks).toBe(0)
    expect(previewPacing().droppedRatio).toBe(0)
  })

  it('a loop that paints every frame drops nothing', () => {
    for (let f = 0; f < 20; f++) {
      tick(f, true, 16)
      tick(f, false, 16) // the second vsync of the same frame paints nothing, correctly
    }
    const p = previewPacing(60_000)
    expect(p.due).toBe(20)
    expect(p.painted).toBe(20)
    expect(p.droppedRatio).toBe(0)
    expect(p.worstHitchFrames).toBe(0)
  })

  // THE CASE THE OLD MEASUREMENT COULD NOT SEE.
  it('a loop that paints every OTHER frame is reported as half dropped', () => {
    for (let f = 0; f < 20; f++) tick(f, f % 2 === 0, 16)
    const p = previewPacing(60_000)
    expect(p.due).toBe(20)
    expect(p.painted).toBe(10)
    expect(p.droppedRatio).toBeCloseTo(0.5, 2)
  })

  it('counts a frame as delivered when ANY tick that saw it painted', () => {
    tick(7, false, 8)
    tick(7, false, 8)
    tick(7, true, 8) // late, but it did reach the screen
    const p = previewPacing(60_000)
    expect(p.due).toBe(1)
    expect(p.painted).toBe(1)
  })

  it('names the longest run of frames that never reached the screen', () => {
    tick(0, true, 16)
    for (const f of [1, 2, 3, 4]) tick(f, false, 16) // a four-frame freeze
    tick(5, true, 16)
    tick(6, false, 16)
    tick(7, true, 16)
    expect(previewPacing(60_000).worstHitchFrames).toBe(4)
  })

  it('measures the gap between PAINTS, which is what a freeze looks like', () => {
    tick(0, true, 16)
    tick(1, false, 16)
    tick(2, false, 16)
    tick(3, false, 16)
    tick(4, true, 16)
    tick(5, true, 16)
    const p = previewPacing(60_000)
    // Paints at +0, +64, +80: gaps of 64 and 16.
    expect(p.worstGapMs).toBe(64)
    expect(p.medianGapMs).toBe(64)
  })

  it('only counts what happened inside the window it was asked about', () => {
    tick(0, true, 16)
    tick(1, true, 16)
    clock += 5000 // long gone
    tick(2, true, 16)
    tick(3, true, 16)
    expect(previewPacing(1000).due).toBe(2)
  })

  it('forgets the run when playback starts or stops', () => {
    for (let f = 0; f < 5; f++) tick(f, false, 16)
    expect(previewPacing(60_000).due).toBe(5)
    resetPreviewPacing()
    expect(previewPacing(60_000).ticks).toBe(0)
  })

  it('a playhead that runs backwards (a loop wrap) still counts frames', () => {
    tick(30, true, 16)
    tick(0, true, 16) // wrapped
    tick(1, true, 16)
    const p = previewPacing(60_000)
    expect(p.due).toBe(3)
    expect(p.painted).toBe(3)
    expect(p.droppedRatio).toBe(0)
  })
})
