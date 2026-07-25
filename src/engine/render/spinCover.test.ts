import { describe, expect, it } from 'vitest'
import { SPIN, spinCoverScale } from './glRenderer'

// Rotating the frame exposes triangular gaps at the corners; the sampler clamps
// and smears edge pixels into them, which is what "the spin streaks" means. The
// punch has to out-zoom that gap at the worst moment of the whip.
describe('spin covers the rotation it asks for', () => {
  // Both sides scale by 1 + punch * s and rotate by angle * s, where s runs 0..1
  // on one side and 1..0 on the other. The midpoint is the worst case: the most
  // rotation either side reaches while its own punch is only half applied.
  const worstCase = (aspect: number) => {
    let worst = 0
    for (let i = 0; i <= 100; i++) {
      const s = i / 100
      const need = spinCoverScale(SPIN.angleRad * s, aspect)
      const have = 1 + SPIN.punch * s
      worst = Math.max(worst, need / have)
    }
    return worst
  }

  it('holds on a 16:9 timeline', () => {
    expect(worstCase(16 / 9)).toBeLessThanOrEqual(1)
  })

  it('holds on a 9:16 Shorts timeline', () => {
    expect(worstCase(9 / 16)).toBeLessThanOrEqual(1)
  })

  it('holds on a square timeline', () => {
    expect(worstCase(1)).toBeLessThanOrEqual(1)
  })

  it('would NOT have held with the old constants — this is the bug', () => {
    // 0.5 rad of rotation against a 1.3x punch: at the midpoint 14 degrees needs
    // ~1.41x on 16:9 and only had 1.15x, so the corners were never covered.
    const need = spinCoverScale(0.5 * 0.5, 16 / 9)
    expect(need).toBeGreaterThan(1 + 0.3 * 0.5)
  })

  it('rotates far enough to read as a whip', () => {
    expect(SPIN.angleRad).toBeGreaterThan(0.5)
  })

  it('cover scale is 1 at no rotation and grows with the angle', () => {
    expect(spinCoverScale(0, 16 / 9)).toBeCloseTo(1, 6)
    expect(spinCoverScale(0.4, 16 / 9)).toBeGreaterThan(spinCoverScale(0.2, 16 / 9))
  })
})
