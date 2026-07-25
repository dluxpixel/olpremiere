import { describe, expect, it } from 'vitest'
import { TRANSITION_KINDS, transitionDurationSpec } from './types'

describe('transition duration envelope', () => {
  it('covers every kind', () => {
    for (const kind of TRANSITION_KINDS) {
      const spec = transitionDurationSpec(kind)
      expect(spec.min).toBeGreaterThan(0)
      expect(spec.def).toBeGreaterThanOrEqual(spec.min)
      expect(spec.def).toBeLessThanOrEqual(spec.max)
    }
  })

  it('no kind still defaults to the old flat one second', () => {
    // A whole second is half a shot at Shorts pacing — the single biggest reason
    // the transitions read amateur. Nothing may quietly regress to it.
    for (const kind of TRANSITION_KINDS) {
      expect(transitionDurationSpec(kind).def).toBeLessThanOrEqual(0.5)
    }
  })

  it('hits are faster than moves, and moves faster than blends', () => {
    const hit = Math.max(transitionDurationSpec('glitch').def, transitionDurationSpec('whiteFlash').def)
    const move = Math.min(
      transitionDurationSpec('zoom').def,
      transitionDurationSpec('spin').def,
      transitionDurationSpec('slideLeft').def,
    )
    const blend = Math.min(
      transitionDurationSpec('crossDissolve').def,
      transitionDurationSpec('dipToBlack').def,
    )
    expect(hit).toBeLessThan(move)
    expect(move).toBeLessThan(blend)
  })

  it('keeps White Flash on its tight intro-hit envelope', () => {
    expect(transitionDurationSpec('whiteFlash')).toEqual({ def: 0.2, min: 0.1, max: 0.5 })
  })

  it('still allows a deliberately long blend', () => {
    expect(transitionDurationSpec('crossDissolve').max).toBeGreaterThanOrEqual(5)
  })
})
