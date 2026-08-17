// The mixdown, which is the half of the beat cache that can be tested without a
// browser decoding anything.
//
// ⛔ IT USED TO LIVE INLINE INSIDE `punchOnBeats` AND WAS NEVER TESTED THERE. It is
// out here now because a dragged diamond needs the same numbers that menu item uses:
// two paths mixing down slightly differently would put the magnets somewhere the
// punches are not, and that would look like the snap being broken rather than like
// two functions disagreeing.

import { describe, expect, it } from 'vitest'
import { monoSlice } from './beatCache'

const SR = 100 // 100 samples a second, so a second of audio is 100 numbers

/** A ramp, so every sample says which sample it is. */
const ramp = (n: number, scale = 1): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => i * scale)

describe('monoSlice', () => {
  it('takes exactly the seconds asked for, at the buffer own rate', () => {
    const one = ramp(500)
    const out = monoSlice([one], SR, 1, 3)
    expect(out.length).toBe(200)
    expect(out[0]).toBeCloseTo(100, 6)
    expect(out[199]).toBeCloseTo(299, 6)
  })

  it('averages the channels rather than summing them', () => {
    // Two channels of a constant 1 must come back as 1, not 2, or a stereo file
    // reads as twice as loud and the onset threshold moves under it.
    const a = new Float32Array(300).fill(1)
    const b = new Float32Array(300).fill(1)
    const out = monoSlice([a, b], SR, 0, 3)
    expect(out.length).toBe(300)
    for (const v of out) expect(v).toBeCloseTo(1, 6)
  })

  it('stops at the end of the audio rather than reading past it', () => {
    const short = ramp(150) // 1.5 seconds
    const out = monoSlice([short], SR, 1, 10)
    expect(out.length).toBe(50)
    expect(out[49]).toBeCloseTo(149, 6)
  })

  it('gives an empty slice for an empty ask, and for no channels', () => {
    expect(monoSlice([ramp(300)], SR, 2, 2).length).toBe(0)
    expect(monoSlice([ramp(300)], SR, 3, 1).length).toBe(0)
    expect(monoSlice([], SR, 0, 3).length).toBe(0)
  })

  it('clamps a negative in point to the start instead of reading before it', () => {
    const out = monoSlice([ramp(300)], SR, -2, 1)
    expect(out.length).toBe(100)
    expect(out[0]).toBeCloseTo(0, 6)
  })
})
