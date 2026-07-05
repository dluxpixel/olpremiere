// Pure export math (node env): PCM slicing, contain-fit, frame ranges,
// codec fallback. The worker/DOM paths are covered by the Playwright golden
// export test, not here.

import { describe, expect, it } from 'vitest'
import {
  AUDIO_CHUNK_FRAMES,
  H264_CODECS,
  clipFrameRange,
  containRect,
  firstSupported,
  packPlanarChunk,
  pcmChunks,
} from './messages'

describe('pcmChunks', () => {
  it('slices into full chunks plus a partial tail', () => {
    const chunks = pcmChunks(10_000, 4800, 48_000)
    expect(chunks).toEqual([
      { offset: 0, frames: 4800, timestampUs: 0 },
      { offset: 4800, frames: 4800, timestampUs: 100_000 },
      { offset: 9600, frames: 400, timestampUs: 200_000 },
    ])
  })

  it('has no tail when total is an exact multiple', () => {
    const chunks = pcmChunks(9600, 4800, 48_000)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toEqual({ offset: 4800, frames: 4800, timestampUs: 100_000 })
  })

  it('returns nothing for zero frames', () => {
    expect(pcmChunks(0, 4800, 48_000)).toEqual([])
  })

  it('rounds timestamps at non-integral chunk durations', () => {
    // 1000 frames at 44.1 kHz = 22675.7… µs per chunk
    const chunks = pcmChunks(3000, 1000, 44_100)
    expect(chunks.map((c) => c.timestampUs)).toEqual([0, 22_676, 45_351])
  })

  it('AUDIO_CHUNK_FRAMES is 0.1 s at 48 kHz', () => {
    expect(AUDIO_CHUNK_FRAMES / 48_000).toBeCloseTo(0.1, 10)
  })
})

describe('packPlanarChunk', () => {
  it('packs channel slices consecutively (f32-planar)', () => {
    const ch0 = Float32Array.from([0, 1, 2, 3, 4])
    const ch1 = Float32Array.from([10, 11, 12, 13, 14])
    const out = packPlanarChunk([ch0, ch1], 2, 3)
    expect(Array.from(out)).toEqual([2, 3, 4, 12, 13, 14])
  })

  it('handles a single channel and zero offset', () => {
    const out = packPlanarChunk([Float32Array.from([5, 6, 7])], 0, 2)
    expect(Array.from(out)).toEqual([5, 6])
  })
})

describe('containRect', () => {
  it('matches exactly when aspect ratios agree', () => {
    expect(containRect(1920, 1080, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('pillarboxes a narrow source, centered', () => {
    expect(containRect(100, 100, 200, 100)).toEqual({ x: 50, y: 0, w: 100, h: 100 })
  })

  it('letterboxes a wide source, centered', () => {
    expect(containRect(200, 100, 100, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 })
  })

  it('rejects degenerate sources', () => {
    expect(containRect(0, 100, 200, 100)).toBeNull()
    expect(containRect(100, -1, 200, 100)).toBeNull()
  })
})

describe('clipFrameRange', () => {
  it('covers [startS, endS) at exact frame boundaries', () => {
    expect(clipFrameRange(1, 2, 30)).toEqual({ first: 30, end: 60 })
  })

  it('excludes the frame landing exactly on endS', () => {
    expect(clipFrameRange(0, 1, 30).end).toBe(30)
  })

  it('absorbs float error at the start boundary', () => {
    // 0.1 + 0.2 = 0.30000000000000004 → frame 3, not 4, at 10 fps
    expect(clipFrameRange(0.1 + 0.2, 1, 10).first).toBe(3)
  })

  it('clamps negative starts to frame 0', () => {
    expect(clipFrameRange(-1, 0.5, 30)).toEqual({ first: 0, end: 15 })
  })

  it('never returns end < first', () => {
    expect(clipFrameRange(2, 2, 30)).toEqual({ first: 60, end: 60 })
    expect(clipFrameRange(2, 1, 30)).toEqual({ first: 60, end: 60 })
  })
})

describe('firstSupported', () => {
  it('returns the first accepted candidate and stops probing', async () => {
    const tried: string[] = []
    const pick = await firstSupported(['a', 'b', 'c'], async (c) => {
      tried.push(c)
      return c === 'b'
    })
    expect(pick).toBe('b')
    expect(tried).toEqual(['a', 'b'])
  })

  it('returns null when nothing is supported', async () => {
    expect(await firstSupported(['a', 'b'], async () => false)).toBeNull()
  })

  it('prefers High profile first in the H.264 ladder', () => {
    expect(H264_CODECS[0]).toBe('avc1.640028')
    expect(H264_CODECS).toHaveLength(3)
  })
})
