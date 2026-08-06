// The frame rate a container reports is a MEASUREMENT, and it can be wrong.
//
// A webm test fixture that every other tool calls 60 fps measured 31.09 through
// mediabunny's averagePacketRate, because the file carries no duration in its
// header. Adopting 31.09 would have set a timeline to a rate no camera has ever
// produced, and every nudge, timecode and export downstream inherits it.

import { describe, expect, it } from 'vitest'
import { snapFrameRate, STANDARD_FPS } from './probe'

describe('snapFrameRate', () => {
  it('snaps the broadcast rates onto themselves', () => {
    for (const fps of STANDARD_FPS) expect(snapFrameRate(fps)).toBe(fps)
  })

  it('pulls a container that reports 29.9698 onto 29.97', () => {
    expect(snapFrameRate(29.9698)).toBe(29.97)
    expect(snapFrameRate(59.9401)).toBe(59.94)
    expect(snapFrameRate(23.9761)).toBe(23.976)
  })

  // A noisy measurement near 60 lands in the 60 family. Which of the two it
  // picks (59.94 or 60) is not worth asserting: they are a tenth of a percent
  // apart and nothing downstream can tell them apart on a real edit. What
  // matters is that it does not land on 50, or on nothing.
  it('a 60 fps source measured slightly off lands in the 60 family', () => {
    expect([59.94, 60]).toContain(snapFrameRate(59.6))
    expect([59.94, 60]).toContain(snapFrameRate(60.4))
  })

  // THE ONE THAT MATTERS: refuse, do not round.
  it('REFUSES a rate that is not near any real one', () => {
    expect(snapFrameRate(31.09)).toBeUndefined()
    expect(snapFrameRate(17)).toBeUndefined()
    expect(snapFrameRate(45)).toBeUndefined()
  })

  it('refuses nonsense rather than passing it on', () => {
    expect(snapFrameRate(undefined)).toBeUndefined()
    expect(snapFrameRate(0)).toBeUndefined()
    expect(snapFrameRate(-30)).toBeUndefined()
    expect(snapFrameRate(NaN)).toBeUndefined()
    expect(snapFrameRate(Infinity)).toBeUndefined()
    expect(snapFrameRate(5000)).toBeUndefined()
  })

  it('29.97 and 30 stay APART: they are different rates and must not merge', () => {
    expect(snapFrameRate(29.97)).toBe(29.97)
    expect(snapFrameRate(30)).toBe(30)
  })
})
