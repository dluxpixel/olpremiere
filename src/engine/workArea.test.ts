import { describe, expect, it } from 'vitest'

import type { Sequence } from './types'
import { clearWorkArea, hasWorkArea, setInPoint, setOutPoint, workArea } from './workArea'

const seq = (over: Partial<Sequence> = {}): Sequence =>
  ({ durationS: 10, ...over }) as Sequence

describe('workArea', () => {
  it('spans the whole sequence when no points are set, and reports itself inactive', () => {
    expect(workArea(seq())).toEqual({ startS: 0, endS: 10, active: false })
    expect(hasWorkArea(seq())).toBe(false)
  })

  it('an in point alone means "from here to the end"', () => {
    expect(workArea(seq({ inPointS: 3 }))).toEqual({ startS: 3, endS: 10, active: true })
  })

  it('an out point alone means "from the start to here"', () => {
    expect(workArea(seq({ outPointS: 7 }))).toEqual({ startS: 0, endS: 7, active: true })
  })

  it('uses both points when both are set', () => {
    expect(workArea(seq({ inPointS: 3, outPointS: 7 }))).toEqual({ startS: 3, endS: 7, active: true })
  })

  it('clamps points that fall outside the sequence', () => {
    expect(workArea(seq({ inPointS: -5, outPointS: 99 }))).toEqual({ startS: 0, endS: 10, active: false })
  })

  it('falls back to the whole sequence for an INVERTED range rather than exporting nothing', () => {
    expect(workArea(seq({ inPointS: 8, outPointS: 2 }))).toEqual({ startS: 0, endS: 10, active: false })
  })

  it('falls back to the whole sequence for a range too short to render', () => {
    expect(workArea(seq({ inPointS: 4, outPointS: 4 }))).toEqual({ startS: 0, endS: 10, active: false })
    expect(workArea(seq({ inPointS: 4, outPointS: 4.0000001 })).active).toBe(false)
  })

  it('a range covering exactly the whole sequence is not "active"', () => {
    expect(workArea(seq({ inPointS: 0, outPointS: 10 })).active).toBe(false)
  })

  it('survives a zero-length sequence without producing a negative range', () => {
    const w = workArea(seq({ durationS: 0, inPointS: 2, outPointS: 5 }))
    expect(w).toEqual({ startS: 0, endS: 0, active: false })
  })
})

describe('setInPoint', () => {
  it('sets and clamps', () => {
    expect(setInPoint(seq(), 3).inPointS).toBe(3)
    expect(setInPoint(seq(), -1).inPointS).toBe(0)
    expect(setInPoint(seq(), 99).inPointS).toBe(10)
  })

  it('dropping the in point past the out point CLEARS the out point', () => {
    // Premiere's behaviour. Silently swapping the two would be more surprising.
    const s = setInPoint(seq({ outPointS: 4 }), 6)
    expect(s.inPointS).toBe(6)
    expect(s.outPointS).toBeUndefined()
  })

  it('dropping it exactly on the out point clears the out point too', () => {
    expect(setInPoint(seq({ outPointS: 4 }), 4).outPointS).toBeUndefined()
  })

  it('leaves a valid out point alone', () => {
    expect(setInPoint(seq({ outPointS: 8 }), 2).outPointS).toBe(8)
  })

  it('does not mutate the input', () => {
    const s = seq()
    setInPoint(s, 3)
    expect(s.inPointS).toBeUndefined()
  })
})

describe('setOutPoint', () => {
  it('sets and clamps', () => {
    expect(setOutPoint(seq(), 7).outPointS).toBe(7)
    expect(setOutPoint(seq(), -1).outPointS).toBe(0)
    expect(setOutPoint(seq(), 99).outPointS).toBe(10)
  })

  it('dropping the out point before the in point CLEARS the in point', () => {
    const s = setOutPoint(seq({ inPointS: 6 }), 2)
    expect(s.outPointS).toBe(2)
    expect(s.inPointS).toBeUndefined()
  })

  it('leaves a valid in point alone', () => {
    expect(setOutPoint(seq({ inPointS: 2 }), 8).inPointS).toBe(2)
  })
})

describe('clearWorkArea', () => {
  it('strips both points', () => {
    const s = clearWorkArea(seq({ inPointS: 2, outPointS: 8 }))
    expect(s.inPointS).toBeUndefined()
    expect(s.outPointS).toBeUndefined()
    expect(workArea(s).active).toBe(false)
  })

  it('returns the SAME object when there is nothing to strip', () => {
    const s = seq()
    expect(clearWorkArea(s)).toBe(s)
  })
})

describe('round trips', () => {
  it('in then out then clear returns to the whole sequence', () => {
    let s = seq()
    s = setInPoint(s, 2)
    s = setOutPoint(s, 8)
    expect(workArea(s)).toEqual({ startS: 2, endS: 8, active: true })
    expect(workArea(clearWorkArea(s))).toEqual({ startS: 0, endS: 10, active: false })
  })

  it('never yields a range the exporter would read as zero frames', () => {
    for (const [i, o] of [
      [0, 0],
      [5, 5],
      [9, 1],
      [-3, -1],
      [11, 12],
    ]) {
      const w = workArea(seq({ inPointS: i, outPointS: o }))
      expect(w.endS).toBeGreaterThan(w.startS)
    }
  })
})
