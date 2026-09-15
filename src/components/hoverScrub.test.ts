import { describe, expect, it } from 'vitest'
import { movedAFrame, scrubTimeAt } from './hoverScrub'

describe('scrubTimeAt', () => {
  it('maps the pointer across the picture onto the clip, on frame boundaries', () => {
    expect(scrubTimeAt(0, 200, 10, 30)).toBe(0)
    expect(scrubTimeAt(100, 200, 10, 30)).toBeCloseTo(5, 6)
    expect(scrubTimeAt(50, 200, 10, 30)).toBeCloseTo(2.5, 6)
    // 33.33 px of a 200 px wide 10 s clip is 1.667 s, which is frame 50 exactly.
    expect(scrubTimeAt(33.333, 200, 10, 30) * 30).toBeCloseTo(50, 3)
  })

  it('never lands on the very end, where a file shows black instead of its last frame', () => {
    expect(scrubTimeAt(200, 200, 10, 30)).toBeCloseTo(10 - 1 / 30, 6)
    expect(scrubTimeAt(999, 200, 10, 30)).toBeCloseTo(10 - 1 / 30, 6)
  })

  it('clamps the pointer to the picture and is safe on empty inputs', () => {
    expect(scrubTimeAt(-40, 200, 10, 30)).toBe(0)
    expect(scrubTimeAt(50, 0, 10, 30)).toBe(0)
    expect(scrubTimeAt(50, 200, 0, 30)).toBe(0)
    expect(scrubTimeAt(50, 200, 10, 0)).toBeCloseTo(2.5, 6)
  })
})

describe('movedAFrame', () => {
  it('is false inside half a frame and true from half a frame on', () => {
    expect(movedAFrame(1, 1 + 1 / 90, 30)).toBe(false)
    expect(movedAFrame(1, 1 + 1 / 50, 30)).toBe(true)
    expect(movedAFrame(1, 0.9, 30)).toBe(true)
  })
})
