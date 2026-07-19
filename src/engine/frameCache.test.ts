import { describe, expect, it } from 'vitest'
import {
  FrameLru,
  SEQ_REOPEN_GAP,
  boundPending,
  frameIndexAt,
  frameMidTimeS,
  needsReopen,
  previewTargetHeight,
  rangeIndices,
  spanIndices,
} from './frameCache'

describe('needsReopen (sequential-reader seek policy)', () => {
  it('reopens when there is no reader yet', () => {
    expect(needsReopen(-1, 10)).toBe(true)
  })
  it('reopens on any backward target (the reader is forward-only)', () => {
    expect(needsReopen(30, 29)).toBe(true)
    expect(needsReopen(30, 0)).toBe(true)
  })
  it('advances through small forward gaps instead of re-seeking', () => {
    expect(needsReopen(30, 30)).toBe(false)
    expect(needsReopen(30, 31)).toBe(false)
    expect(needsReopen(30, 30 + SEQ_REOPEN_GAP)).toBe(false)
  })
  it('reopens past the gap (a seek beats decoding hundreds of frames)', () => {
    expect(needsReopen(30, 30 + SEQ_REOPEN_GAP + 1)).toBe(true)
  })
})

describe('previewTargetHeight', () => {
  it('leaves ≤1080p footage at native size on Full', () => {
    expect(previewTargetHeight(1080, 1)).toBeUndefined()
    expect(previewTargetHeight(720, 1)).toBeUndefined()
  })
  it('caps 4K to 1080p on Full', () => {
    expect(previewTargetHeight(2160, 1)).toBe(1080)
  })
  it('halves/quarters at reduced quality tiers', () => {
    expect(previewTargetHeight(1080, 0.5)).toBe(540)
    expect(previewTargetHeight(1080, 0.25)).toBe(270)
    expect(previewTargetHeight(2160, 0.25)).toBe(270) // min(2160,1080)*0.25
  })
  it('never upscales a small source (returns undefined = native)', () => {
    expect(previewTargetHeight(480, 1)).toBeUndefined()
  })
  it('is safe with unknown dimensions', () => {
    expect(previewTargetHeight(undefined, 1)).toBeUndefined()
    expect(previewTargetHeight(0, 1)).toBeUndefined()
  })
  it('Full follows a TALLER sequence raster (vertical reels, 4K timelines)', () => {
    expect(previewTargetHeight(1920, 1, 1080, 1920)).toBeUndefined() // native — no cap
    expect(previewTargetHeight(3840, 1, 1080, 1920)).toBe(1920)
    expect(previewTargetHeight(2160, 1, 1080, 2160)).toBeUndefined() // 4K seq → native 4K
  })
  it('a sequence shorter than the base never LOWERS the Full cap', () => {
    expect(previewTargetHeight(2160, 1, 1080, 720)).toBe(1080)
  })
  it('Half/Quarter ignore the sequence raster (cheap scrubbing is their point)', () => {
    expect(previewTargetHeight(1920, 0.5, 1080, 1920)).toBe(540)
    expect(previewTargetHeight(3840, 0.25, 1080, 1920)).toBe(270)
  })
})

describe('rangeIndices (transition pre-roll window math)', () => {
  it('covers the range ascending, inclusive of both edge frames', () => {
    expect(rangeIndices(1, 1.1, 30, 10)).toEqual([30, 31, 32, 33])
  })
  it('normalizes a reversed range (reversed outgoing clip)', () => {
    expect(rangeIndices(1.1, 1, 30, 10)).toEqual([30, 31, 32, 33])
  })
  it('clamps to the last real frame (past-EOF freeze-frame territory)', () => {
    expect(rangeIndices(9.9, 10.5, 30, 10)).toEqual([297, 298, 299])
  })
  it('caps the request size', () => {
    expect(rangeIndices(0, 100, 30, 1000, 8)).toHaveLength(8)
    expect(rangeIndices(0, 100, 30, 1000, 8)[0]).toBe(0)
  })
  it('falls back to 30fps when the asset fps is unknown', () => {
    expect(rangeIndices(1, 1.05, undefined, 10)).toEqual([30, 31])
  })
  it('collapses a zero-length range to the single containing frame', () => {
    expect(rangeIndices(2, 2, 30, 10)).toEqual([60])
  })
})

describe('frameIndexAt', () => {
  it('quantizes with floor semantics at the asset fps', () => {
    expect(frameIndexAt(0, 30)).toBe(0)
    expect(frameIndexAt(0.5, 30)).toBe(15)
    expect(frameIndexAt(0.51, 30)).toBe(15)
    expect(frameIndexAt(1.999, 24)).toBe(47)
  })

  it('lands exact frame boundaries on the boundary frame despite float error', () => {
    expect(frameIndexAt(1 / 30, 30)).toBe(1)
    expect(frameIndexAt(29 / 30, 30)).toBe(29)
    expect(frameIndexAt(7 / 24, 24)).toBe(7)
  })

  it('falls back to 30fps when fps is undefined', () => {
    expect(frameIndexAt(1, undefined)).toBe(30)
    expect(frameIndexAt(0.5, undefined)).toBe(15)
  })

  it('falls back to 30fps for non-positive fps', () => {
    expect(frameIndexAt(1, 0)).toBe(30)
  })

  it('clamps negative times to frame 0', () => {
    expect(frameIndexAt(-0.2, undefined)).toBe(0)
  })
})

describe('frameMidTimeS', () => {
  it('targets the frame midpoint', () => {
    expect(frameMidTimeS(0, 30)).toBeCloseTo(0.5 / 30)
    expect(frameMidTimeS(15, 30)).toBeCloseTo(15.5 / 30)
  })

  it('round-trips with frameIndexAt', () => {
    for (const fps of [24, 30, 60, undefined]) {
      for (const idx of [0, 1, 29, 100]) {
        expect(frameIndexAt(frameMidTimeS(idx, fps), fps)).toBe(idx)
      }
    }
  })
})

describe('FrameLru', () => {
  it('evicts the least-recently-used entry beyond the cap', () => {
    const lru = new FrameLru<string>(3)
    lru.set('a', 'A')
    lru.set('b', 'B')
    lru.set('c', 'C')
    expect(lru.set('d', 'D')).toEqual(['a'])
    expect(lru.get('a')).toBeUndefined()
    expect(lru.size).toBe(3)
  })

  it('get() touches: a hit survives the next eviction', () => {
    const lru = new FrameLru<string>(3)
    lru.set('a', 'A')
    lru.set('b', 'B')
    lru.set('c', 'C')
    expect(lru.get('a')).toBe('A')
    expect(lru.set('d', 'D')).toEqual(['b'])
    expect(lru.get('a')).toBe('A')
  })

  it('has() peeks without touching', () => {
    const lru = new FrameLru<string>(2)
    lru.set('a', 'A')
    lru.set('b', 'B')
    expect(lru.has('a')).toBe(true)
    expect(lru.set('c', 'C')).toEqual(['a'])
  })

  it('overwriting a key re-orders it without growing', () => {
    const lru = new FrameLru<string>(2)
    lru.set('a', 'A')
    lru.set('b', 'B')
    expect(lru.set('a', 'A2')).toEqual([])
    expect(lru.size).toBe(2)
    expect(lru.set('c', 'C')).toEqual(['b'])
    expect(lru.get('a')).toBe('A2')
  })

  it('delete + keys support prefix purges', () => {
    const lru = new FrameLru<number>(4)
    lru.set('x:1', 1)
    lru.set('y:1', 2)
    lru.set('x:2', 3)
    for (const key of lru.keys()) {
      if (key.startsWith('x:')) lru.delete(key)
    }
    expect(lru.keys()).toEqual(['y:1'])
  })
})

describe('boundPending', () => {
  it('keeps the cap nearest to latest, nearest-first', () => {
    const out = boundPending([1, 2, 3, 10, 11, 12, 13, 14, 15, 16], 12, 8)
    expect(out).toEqual([12, 11, 13, 10, 14, 15, 16, 3])
  })

  it('breaks distance ties with the lower index', () => {
    expect(boundPending([13, 11, 12], 12, 3)).toEqual([12, 11, 13])
  })

  it('dedupes before bounding', () => {
    expect(boundPending([5, 5, 6, 6, 4], 5, 8)).toEqual([5, 4, 6])
  })

  it('drops the farthest (oldest scrub positions) when over the cap', () => {
    const stale = [0, 1, 2, 3, 4]
    const out = boundPending([...stale, 100, 101, 99], 100, 3)
    expect(out).toEqual([100, 99, 101])
  })

  it('handles empty input', () => {
    expect(boundPending([], 0, 8)).toEqual([])
  })
})

describe('spanIndices', () => {
  it('emits nearest-first, forward before backward on ties', () => {
    expect(spanIndices(5, 2, Number.MAX_SAFE_INTEGER)).toEqual([5, 6, 4, 7, 3])
  })

  it('clamps to [0, maxIndex]', () => {
    expect(spanIndices(1, 2, 2)).toEqual([1, 2, 0])
    expect(spanIndices(0, 1, 0)).toEqual([0])
  })
})
