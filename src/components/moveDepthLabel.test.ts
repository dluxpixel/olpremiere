// The readout that made him think the slider was broken.
//
// ⛔ THE POINT OF EVERY CASE HERE IS THAT THE NUMBER AGREES WITH THE HANDLE. A
// readout of "96%" over a handle sitting at 31% of its track is two percentages
// of two different things at the same eye level, and there is no way to read that
// as anything but a fault. His words, 2026-08-24: *"When I drag it, it just
// breaks and shows different percentages."*

import { describe, expect, it } from 'vitest'
import { depthLabel, depthTrackFrac } from './moveDepthLabel'

const MIN = 0.5
const MAX = 2

describe('depthLabel', () => {
  it('says which way the move goes, never a bare percentage', () => {
    expect(depthLabel(1.4).text).toBe('in 40%')
    expect(depthLabel(0.6).text).toBe('out 40%')
  })

  it('is the case he photographed: 0.96 reads as a small pull back, not as 96', () => {
    // The old readout printed 96% here while the handle sat at 31% of the track.
    const label = depthLabel(0.96)
    expect(label.text).toBe('out 4%')
    expect(label.direction).toBe('out')
    expect(depthTrackFrac(0.96, MIN, MAX)).toBeCloseTo(0.3067, 3)
  })

  it('moves in the same direction as the handle across the whole range', () => {
    // Walk the slider and check the amount falls to its minimum at the middle and
    // grows away from it on both sides, which is what the handle does.
    const steps = [0.5, 0.7, 0.9, 1.1, 1.5, 2]
    const amounts = steps.map((d) => depthLabel(d).amountPct)
    expect(amounts).toEqual([50, 30, 10, 10, 50, 100])
    for (const d of steps) {
      expect(depthLabel(d).direction).toBe(d > 1 ? 'in' : 'out')
    }
  })

  it('never rounds a real move down to nothing', () => {
    // The slider refuses to settle within 4% of neutral, so the smallest real
    // value is 0.96 / 1.04. A value closer than half a percent still says 1%,
    // because "0%" over a move that is happening is the same lie in a smaller font.
    expect(depthLabel(1.002).amountPct).toBe(1)
    expect(depthLabel(0.998).amountPct).toBe(1)
  })

  it('only exactly neutral reads as no move', () => {
    expect(depthLabel(1).text).toBe('none')
    expect(depthLabel(1).direction).toBe('none')
  })

  it('survives a value that is not a number', () => {
    expect(depthLabel(Number.NaN).direction).toBe('none')
  })
})

describe('depthTrackFrac', () => {
  it('puts neutral where the middle marker is drawn', () => {
    // 1 in a 0.5..2 range is a THIRD of the way along, not halfway, which is
    // exactly why the marker has to be drawn from this function rather than
    // eyeballed at 50%.
    expect(depthTrackFrac(1, MIN, MAX)).toBeCloseTo(1 / 3, 5)
  })

  it('clamps to the track and never divides by a bad range', () => {
    expect(depthTrackFrac(9, MIN, MAX)).toBe(1)
    expect(depthTrackFrac(-9, MIN, MAX)).toBe(0)
    expect(depthTrackFrac(1, 2, 2)).toBe(0)
  })
})
