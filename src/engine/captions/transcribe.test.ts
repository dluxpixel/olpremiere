import { describe, expect, it } from 'vitest'
import { defaultTitleDef, newTitleClip } from '../types'
import { tidyTranscribedWords, timelineWords, wordsFromAsrChunks, type AsrChunk } from './transcribe'

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

describe('tidyTranscribedWords', () => {
  const w = (text: string, startS: number, endS: number) => ({ text, startS, endS })

  it('collapses a recogniser loop but keeps a genuine repeat', () => {
    // Whisper skipping: the same token again with no audible gap.
    const looped = tidyTranscribedWords([
      w('the', 0.0, 0.2), w('the', 0.2, 0.4), w('the', 0.4, 0.6), w('wall', 0.6, 1.0),
    ])
    expect(looped.map((x) => x.text)).toEqual(['the', 'wall'])

    // Actually saying a word twice leaves a real gap between them.
    const real = tidyTranscribedWords([w('go', 0.0, 0.3), w('go', 0.9, 1.2)])
    expect(real).toHaveLength(2)
  })

  it('drops tokens that are only punctuation', () => {
    const out = tidyTranscribedWords([w('hi', 0, 0.3), w('.', 0.3, 0.35), w('there', 0.4, 0.8)])
    expect(out.map((x) => x.text)).toEqual(['hi', 'there'])
  })

  it('strips the end-of-silence hallucination, but only after a real pause', () => {
    const invented = tidyTranscribedWords([
      w('diamonds', 0.0, 0.6),
      w('thanks', 3.0, 3.3), w('for', 3.3, 3.5), w('watching', 3.5, 4.0),
    ])
    expect(invented.map((x) => x.text)).toEqual(['diamonds'])

    // Said straight after the previous word, so that is the creator actually
    // signing off, and it stays.
    const spoken = tidyTranscribedWords([
      w('diamonds', 0.0, 0.6),
      w('thanks', 0.7, 1.0), w('for', 1.0, 1.2), w('watching', 1.2, 1.6),
    ])
    expect(spoken).toHaveLength(4)
  })

  it('leaves ordinary punctuation attached, because the chunker breaks captions on it', () => {
    const out = tidyTranscribedWords([w('done.', 0, 0.5), w('next', 0.6, 1.0)])
    expect(out[0].text).toBe('done.')
  })
})
