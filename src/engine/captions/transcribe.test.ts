import { describe, expect, it } from 'vitest'
import { defaultTitleDef, newTitleClip } from '../types'
import { timelineWords, wordsFromAsrChunks, type AsrChunk } from './transcribe'

const chunk = (text: string, start: number, end: number | null): AsrChunk => ({
  text,
  timestamp: [start, end],
})

describe('wordsFromAsrChunks', () => {
  it('trims Whisper’s leading spaces and keeps word order', () => {
    const words = wordsFromAsrChunks([chunk(' so', 0, 0.2), chunk(' I', 0.2, 0.35)])
    expect(words.map((w) => w.text)).toEqual(['so', 'I'])
    expect(words[0]).toEqual({ text: 'so', startS: 0, endS: 0.2 })
  })

  it('drops empties and bracketed noise tags', () => {
    const words = wordsFromAsrChunks([
      chunk('  ', 0, 0.1),
      chunk('[BLANK_AUDIO]', 0.1, 0.5),
      chunk('(music)', 0.5, 0.9),
      chunk(' real', 1, 1.2),
    ])
    expect(words.map((w) => w.text)).toEqual(['real'])
  })

  it('repairs null and inverted end times (typical for the final word)', () => {
    const words = wordsFromAsrChunks([chunk(' hello', 1, null), chunk(' hi', 3, 2.5)])
    expect(words[0].endS).toBeGreaterThan(words[0].startS)
    expect(words[1].endS).toBeGreaterThan(words[1].startS)
  })

  it('clamps negative start times to zero', () => {
    const words = wordsFromAsrChunks([chunk(' x', -0.2, 0.1)])
    expect(words[0].startS).toBe(0)
  })
})

describe('timelineWords', () => {
  it('offsets slice-relative times by the clip start', () => {
    const clip = { ...newTitleClip(defaultTitleDef('x'), 10, 5), speed: 1 }
    const words = timelineWords([{ text: 'go', startS: 1, endS: 1.4 }], clip)
    expect(words[0].startS).toBeCloseTo(11, 9)
    expect(words[0].endS).toBeCloseTo(11.4, 9)
  })

  it('compresses times by the playback speed', () => {
    const clip = { ...newTitleClip(defaultTitleDef('x'), 10, 5), speed: 2 }
    const words = timelineWords([{ text: 'go', startS: 1, endS: 2 }], clip)
    expect(words[0].startS).toBeCloseTo(10.5, 9)
    expect(words[0].endS).toBeCloseTo(11, 9)
  })
})
