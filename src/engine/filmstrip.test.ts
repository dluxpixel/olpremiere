import { describe, expect, it } from 'vitest'
import { filmstripPlan, TILE_W } from './filmstrip'

describe('filmstripPlan', () => {
  it('spreads tile centers across the trimmed source range', () => {
    const plan = filmstripPlan('a', TILE_W * 4, 2, 10, 1)!
    expect(plan.n).toBe(4)
    expect(plan.timesS[0]).toBeCloseTo(3, 6) // 2 + (0.5/4)*8
    expect(plan.timesS[3]).toBeCloseTo(9, 6)
  })

  it('buckets the tile count so zooming does not regenerate per pixel', () => {
    const a = filmstripPlan('a', TILE_W * 4.6, 0, 10, 1)!
    const b = filmstripPlan('a', TILE_W * 5.4, 0, 10, 1)!
    expect(a.n).toBe(6)
    expect(a.key).toBe(b.key) // both land in the 6-tile bucket
    expect(filmstripPlan('a', TILE_W * 200, 0, 10, 1)!.n).toBe(32) // capped
    expect(filmstripPlan('a', 10, 0, 10, 1)!.n).toBe(1)
  })

  it('quantizes the trim so live trim-drags reuse the cache', () => {
    const a = filmstripPlan('a', 300, 2.01, 8.02, 1)!
    const b = filmstripPlan('a', 300, 1.99, 7.98, 1)!
    expect(a.key).toBe(b.key)
  })

  it('reverses tile order for reversed clips', () => {
    const fwd = filmstripPlan('a', TILE_W * 3, 0, 6, 1)!
    const rev = filmstripPlan('a', TILE_W * 3, 0, 6, -1)!
    expect(rev.timesS).toEqual([...fwd.timesS].reverse())
    expect(rev.key).not.toBe(fwd.key)
  })

  it('rejects degenerate spans', () => {
    expect(filmstripPlan('a', 300, 5, 5, 1)).toBeNull()
    expect(filmstripPlan('a', 0, 0, 5, 1)).toBeNull()
  })
})
