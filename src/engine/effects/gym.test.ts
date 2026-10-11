import { describe, expect, it } from 'vitest'
import {
  BAR_RATIOS,
  barFractionForRatio,
  barPixels,
  beatGridFrom,
  rgbSplitOffsets,
  strobeAge,
  strobeEnvelope,
  strobeFlash,
  type StrobeSettings,
} from './gym'

const S: StrobeSettings = { everyN: 1, flashMs: 100, bpm: 120, firstBeatS: 0 }

describe('strobe on detected beats', () => {
  const beats = [1.0, 1.5, 2.2, 3.0]

  it('is full on the beat and gone after the flash length', () => {
    expect(strobeFlash(beats, 1.0, 1.0, S)).toBe(1)
    expect(strobeFlash(beats, 1.05, 1.05, S)).toBeCloseTo(0.25, 6)
    expect(strobeFlash(beats, 1.1, 1.1, S)).toBe(0)
    expect(strobeFlash(beats, 1.3, 1.3, S)).toBe(0)
  })

  it('does not flash before the first beat', () => {
    expect(strobeFlash(beats, 0.5, 0.5, S)).toBe(0)
    expect(strobeAge(beats, 0.5, 0.5, S)).toBeNull()
  })

  it('lands on a frame time that is a hair under the beat', () => {
    expect(strobeFlash(beats, 1.5 - 1e-9, 1.5, S)).toBeGreaterThan(0.9)
  })

  it('flashes on every Nth beat only, counting from the first beat', () => {
    const two = { ...S, everyN: 2 }
    expect(strobeFlash(beats, 1.0, 1.0, two)).toBe(1)
    expect(strobeFlash(beats, 1.5, 1.5, two)).toBe(0)
    expect(strobeFlash(beats, 2.2, 2.2, two)).toBe(1)
    expect(strobeFlash(beats, 3.0, 3.0, two)).toBe(0)
  })

  it('a longer flash length holds the flash longer', () => {
    expect(strobeFlash(beats, 1.1, 1.1, { ...S, flashMs: 300 })).toBeGreaterThan(0.3)
  })
})

describe('strobe BPM fallback', () => {
  it('uses the BPM grid when there are no beats, counted from the clip start', () => {
    expect(strobeFlash(undefined, 0, 0, S)).toBe(1)
    expect(strobeFlash([], 0.5, 0.5, S)).toBe(1)
    expect(strobeFlash([], 0.25, 0.25, S)).toBe(0)
    expect(strobeFlash(undefined, 0.55, 0.55, S)).toBeCloseTo(0.25, 6)
  })

  it('counts clip time, not sequence time', () => {
    expect(strobeFlash(undefined, 10.5, 0.5, S)).toBe(1)
  })

  it('honours Every N beats and the first beat offset', () => {
    const two = { ...S, everyN: 2 }
    expect(strobeFlash(undefined, 0.5, 0.5, two)).toBe(0)
    expect(strobeFlash(undefined, 1.0, 1.0, two)).toBe(1)
    expect(strobeFlash(undefined, 0.2, 0.2, { ...S, firstBeatS: 0.2 })).toBe(1)
    expect(strobeAge(undefined, 0.1, 0.1, { ...S, firstBeatS: 0.2 })).toBeNull()
  })

  it('keeps the BPM in a sane range', () => {
    // 0 clamps to 30 BPM, a beat every 2 s, so one second in is 1 s after the beat.
    expect(strobeAge(undefined, 1, 1, { ...S, bpm: 0 })).toBeCloseTo(1, 6)
    expect(strobeAge(undefined, 1, 1, { ...S, bpm: 1e6 })).toBeLessThan(0.2)
  })

  it('the envelope is 0 for no beat and never negative', () => {
    expect(strobeEnvelope(null, 100)).toBe(0)
    expect(strobeEnvelope(0, 0)).toBe(1)
  })
})

describe('the beat grid from the music clips', () => {
  it('maps beats to sequence time, over speed, sorted and merged', () => {
    const grid = beatGridFrom([
      { startS: 10, inS: 4, outS: 20, speed: 2, beats: [0, 1, 2] },
      { startS: 0, inS: 0, outS: 5, speed: 1, beats: [1, 1.1, 3] },
    ])
    expect(grid).toEqual([1, 3, 10, 10.5, 11])
  })

  it('drops beats outside the clip and walks a reversed clip backward', () => {
    expect(beatGridFrom([{ startS: 0, inS: 0, outS: 4, speed: 1, beats: [-1, 5] }])).toEqual([])
    expect(beatGridFrom([{ startS: 2, inS: 0, outS: 4, speed: -1, beats: [1, 3] }])).toEqual([3, 5])
  })
})

describe('RGB split offsets', () => {
  it('slides along the angle, y down', () => {
    expect(rgbSplitOffsets(10, 0)).toEqual({ dx: 10, dy: 0 })
    const down = rgbSplitOffsets(10, 90)
    expect(down.dx).toBeCloseTo(0, 9)
    expect(down.dy).toBeCloseTo(10, 9)
    expect(rgbSplitOffsets(10, 180).dx).toBeCloseTo(-10, 9)
    expect(rgbSplitOffsets(0, 33)).toEqual({ dx: 0, dy: 0 })
  })
})

describe('cinematic bar sizes', () => {
  it('measures the ratio against the frame width on the wide frame', () => {
    expect(barFractionForRatio(2.39, 1920, 1080)).toBeCloseTo(0.12808, 4)
    expect(barPixels(barFractionForRatio(2.39, 1920, 1080), 1080)).toBe(138)
    expect(barFractionForRatio(2, 1920, 1080)).toBeCloseTo(0.05556, 4)
    expect(barPixels(barFractionForRatio(2, 1920, 1080), 1080)).toBe(60)
    expect(barFractionForRatio(1.85, 1920, 1080)).toBeCloseTo(0.01952, 4)
  })

  it('works on the tall Phone frame, where the bars are huge', () => {
    expect(barFractionForRatio(2.39, 1080, 1920)).toBeCloseTo(0.38232, 4)
    expect(barPixels(barFractionForRatio(2.39, 1080, 1920), 1920)).toBe(734)
    expect(barFractionForRatio(2, 1080, 1920)).toBeCloseTo(0.359375, 5)
    expect(barFractionForRatio(1.85, 1080, 1920)).toBeCloseTo(0.34797, 4)
  })

  it('is 0 when the frame is already that wide, and for nonsense', () => {
    expect(barFractionForRatio(1.5, 1920, 1080)).toBe(0)
    expect(barFractionForRatio(0, 1920, 1080)).toBe(0)
    expect(barFractionForRatio(2.39, 0, 1080)).toBe(0)
  })

  it('offers 2.39:1, 2:1 and 1.85:1, widest first', () => {
    expect(BAR_RATIOS.map((r) => r.label)).toEqual(['2.39:1', '2:1', '1.85:1'])
  })
})

describe('a short flash is at least one frame long', () => {
  it('at 30 fps a 20 ms flash still lands on a frame for every beat', () => {
    const fps = 30
    const beats = Array.from({ length: 40 }, (_, i) => 1 + i * 0.5 + (i % 7) * 0.0123)
    const s: StrobeSettings = { everyN: 1, flashMs: 20, bpm: 120, firstBeatS: 0 }
    for (const b of beats) {
      let lit = false
      for (let f = Math.floor(b * fps) - 1; f <= Math.ceil(b * fps) + 1; f++) {
        const t = f / fps
        if (strobeFlash(beats, t, t, s, fps) > 0) lit = true
      }
      expect(lit).toBe(true)
    }
  })

  it('without the frame length the same flash misses beats', () => {
    const fps = 30
    const beats = Array.from({ length: 40 }, (_, i) => 1 + i * 0.5 + (i % 7) * 0.0123)
    const s: StrobeSettings = { everyN: 1, flashMs: 20, bpm: 120, firstBeatS: 0 }
    let missed = 0
    for (const b of beats) {
      let lit = false
      for (let f = Math.floor(b * fps) - 1; f <= Math.ceil(b * fps) + 1; f++) {
        const t = f / fps
        if (strobeFlash(beats, t, t, s) > 0) lit = true
      }
      if (!lit) missed++
    }
    expect(missed).toBeGreaterThan(0)
  })
})
