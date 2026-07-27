import { describe, expect, it } from 'vitest'
import { parseTranscript, tapsToWords } from './transcript'

describe('parseTranscript: JSON word lists', () => {
  it('accepts [{text,startS,endS}] with exact timings', () => {
    const words = parseTranscript('[{"text":"so","startS":0,"endS":0.3},{"text":"I","startS":0.3,"endS":0.5}]')!
    expect(words.map((w) => w.text)).toEqual(['so', 'I'])
    expect(words[0].endS).toBeCloseTo(0.3, 9)
  })

  it('repairs missing end times from the successor and sorts by start', () => {
    const words = parseTranscript('[{"text":"two","startS":1},{"text":"one","startS":0}]')!
    expect(words.map((w) => w.text)).toEqual(['one', 'two'])
    expect(words[0].endS).toBeCloseTo(1, 9) // capped at the next word
    expect(words[1].endS).toBeGreaterThan(1)
  })

  it('keeps emphasis flags and drops empty texts', () => {
    const words = parseTranscript('[{"text":"BOOM","startS":0,"emphasis":true},{"text":"  ","startS":1}]')!
    expect(words).toHaveLength(1)
    expect(words[0].emphasis).toBe(true)
  })

  it('rejects malformed entries rather than guessing', () => {
    expect(parseTranscript('[{"startS":0}]')).toBeNull()
    expect(parseTranscript('{"text":"x"}')).toBeNull()
  })
})

describe('parseTranscript: SRT', () => {
  const SRT = `1
00:00:01,000 --> 00:00:02,000
so I built

2
00:00:03,500 --> 00:00:04,000
<i>a trap</i>`

  it('spreads each cue across its window, word by word', () => {
    const words = parseTranscript(SRT)!
    expect(words.map((w) => w.text)).toEqual(['so', 'I', 'built', 'a', 'trap'])
    expect(words[0].startS).toBeCloseTo(1, 9)
    expect(words[2].endS).toBeCloseTo(2, 9) // cue 1 fills exactly its window
    expect(words[3].startS).toBeCloseTo(3.5, 9)
    expect(words[4].endS).toBeCloseTo(4, 9)
  })

  it('handles dot-separated millis and ignores index lines', () => {
    const words = parseTranscript('00:00:00.500 --> 00:00:01.000\nhey there')!
    expect(words).toHaveLength(2)
    expect(words[0].startS).toBeCloseTo(0.5, 9)
  })

  it('returns null for plain prose', () => {
    expect(parseTranscript('just some words with no timing')).toBeNull()
    expect(parseTranscript('')).toBeNull()
  })
})

describe('tapsToWords', () => {
  it('each tap starts a word; the word runs to the next tap', () => {
    const words = tapsToWords(['so', 'I', 'won'], [1, 1.4, 2])
    expect(words).toEqual([
      { text: 'so', startS: 1, endS: 1.4 },
      { text: 'I', startS: 1.4, endS: 2 },
      { text: 'won', startS: 2, endS: 2.4 },
    ])
  })

  it('stopping early keeps only the tapped words', () => {
    expect(tapsToWords(['a', 'b', 'c'], [1, 2])).toHaveLength(2)
  })

  it('drops out-of-order taps instead of overlapping captions', () => {
    const words = tapsToWords(['a', 'b', 'c'], [1, 0.5, 2])
    expect(words.map((w) => w.text)).toEqual(['a', 'c'])
  })
})
