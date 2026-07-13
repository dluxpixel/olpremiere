import { describe, expect, it } from 'vitest'
import { defaultTitleDef } from '../types'
import {
  CAPTION_EMPHASIS_COLORS,
  CAPTION_POP_DUR_S,
  captionClips,
  chunkWords,
  jettismCaptionDef,
  spreadWords,
  type CaptionWord,
} from './captions'

const w = (text: string, startS: number, endS: number, emphasis?: boolean): CaptionWord => ({
  text,
  startS,
  endS,
  ...(emphasis ? { emphasis: true } : {}),
})

/** The track invariant: chunks must never overlap and must be time-ordered. */
function assertNonOverlapping(chunks: { startS: number; endS: number }[]): void {
  for (let i = 0; i < chunks.length; i++) {
    expect(chunks[i].endS).toBeGreaterThan(chunks[i].startS)
    if (i > 0) expect(chunks[i].startS).toBeGreaterThanOrEqual(chunks[i - 1].endS - 1e-9)
  }
}

describe('chunkWords', () => {
  it('returns nothing for no words', () => {
    expect(chunkWords([])).toEqual([])
    expect(chunkWords([w('  ', 0, 1)])).toEqual([])
  })

  it('groups up to maxWords consecutive words', () => {
    const words = [w('so', 0, 0.2), w('I', 0.2, 0.4), w('built', 0.4, 0.6), w('it', 0.6, 0.8)]
    const chunks = chunkWords(words, { maxWords: 2 })
    expect(chunks.map((c) => c.text)).toEqual(['so I', 'built it'])
    assertNonOverlapping(chunks)
  })

  it('starts a new chunk across a real silence', () => {
    const words = [w('wait', 0, 0.3), w('for', 0.31, 0.5), w('it', 2.0, 2.2)]
    const chunks = chunkWords(words, { maxWords: 3 })
    expect(chunks.map((c) => c.text)).toEqual(['wait for', 'it'])
  })

  it('breaks after sentence punctuation', () => {
    const words = [w('done.', 0, 0.3), w('next', 0.32, 0.5)]
    const chunks = chunkWords(words, { maxWords: 3 })
    expect(chunks.map((c) => c.text)).toEqual(['done.', 'next'])
  })

  it('isolates emphasized words in their own chunk', () => {
    const words = [w('the', 0, 0.2), w('BOOM', 0.2, 0.5, true), w('lands', 0.5, 0.8)]
    const chunks = chunkWords(words, { maxWords: 3 })
    expect(chunks.map((c) => c.text)).toEqual(['the', 'BOOM', 'lands'])
    expect(chunks.map((c) => c.emphasis)).toEqual([false, true, false])
  })

  it('holds each caption until its successor appears (seamless)', () => {
    const words = [w('one', 0, 0.3), w('two', 0.45, 0.7)]
    const chunks = chunkWords(words, { maxWords: 1 })
    expect(chunks[0].endS).toBeCloseTo(0.45, 6) // extended to meet chunk 2
  })

  it('lingers holdS at a silence and after the last word', () => {
    const words = [w('one', 0, 0.3), w('two', 2.0, 2.3)]
    const chunks = chunkWords(words, { maxWords: 1, holdS: 0.3 })
    expect(chunks[0].endS).toBeCloseTo(0.6, 6) // 0.3 + holdS, gap too wide to bridge
    expect(chunks[1].endS).toBeCloseTo(2.6, 6) // last chunk lingers holdS
  })

  it('enforces the readability floor but never an overlap', () => {
    const words = [w('a', 0, 0.05), w('b', 0.06, 0.11), w('c', 0.12, 0.4)]
    const chunks = chunkWords(words, { maxWords: 1, minDurS: 0.18, holdS: 0.3 })
    assertNonOverlapping(chunks)
    // the floor is best-effort: it never shoves a successor off its word timing
    expect(chunks[0].endS - chunks[0].startS).toBeGreaterThanOrEqual(0.06)
  })

  it('sorts out-of-order input by start time', () => {
    const words = [w('two', 0.5, 0.7), w('one', 0, 0.3)]
    const chunks = chunkWords(words, { maxWords: 1 })
    expect(chunks.map((c) => c.text)).toEqual(['one', 'two'])
  })
})

describe('spreadWords', () => {
  it('returns nothing for empty text or zero duration', () => {
    expect(spreadWords('', 0, 5)).toEqual([])
    expect(spreadWords('hi there', 0, 0)).toEqual([])
  })

  it('covers exactly the given window, contiguously', () => {
    const words = spreadWords('so I built a trap', 2, 3)
    expect(words).toHaveLength(5)
    expect(words[0].startS).toBeCloseTo(2, 9)
    expect(words[words.length - 1].endS).toBeCloseTo(5, 9)
    for (let i = 1; i < words.length; i++) expect(words[i].startS).toBeCloseTo(words[i - 1].endS, 9)
  })

  it('gives longer words more screen time', () => {
    const words = spreadWords('a extraordinary', 0, 2)
    const durA = words[0].endS - words[0].startS
    const durB = words[1].endS - words[1].startS
    expect(durB).toBeGreaterThan(durA)
  })

  it('parses *asterisk* emphasis markers and strips them', () => {
    const words = spreadWords('the *boom* lands', 0, 3)
    expect(words.map((x) => x.text)).toEqual(['the', 'boom', 'lands'])
    expect(words.map((x) => !!x.emphasis)).toEqual([false, true, false])
  })
})

describe('jettismCaptionDef', () => {
  it('produces the house style at 1080x1920', () => {
    const def = jettismCaptionDef('HELLO', 1920)
    expect(def.fontSizePx).toBe(154)
    expect(def.color).toBe('#ffffff')
    expect(def.bold).toBe(true)
    expect(def.outline).toEqual({ color: '#000000', widthPx: 9 })
    expect(def.offsetYPx).toBe(422)
    expect(def.align).toBe('center')
  })

  it('scales with the sequence height', () => {
    const def = jettismCaptionDef('HELLO', 960)
    expect(def.fontSizePx).toBe(77)
    expect(def.outline?.widthPx).toBe(5)
  })
})

describe('captionClips', () => {
  const opts = { seqWidth: 1080, seqHeight: 1920 }
  const chunks = [
    { text: 'so I', startS: 1, endS: 1.5, emphasis: false },
    { text: 'boom', startS: 1.5, endS: 2.1, emphasis: true },
  ]

  it('creates one title clip per chunk at the chunk window', () => {
    const clips = captionClips(chunks, opts)
    expect(clips).toHaveLength(2)
    expect(clips[0].startS).toBe(1)
    expect(clips[0].outS).toBeCloseTo(0.5, 9)
    expect(clips[0].title?.text).toBe('SO I') // house style is ALL-CAPS
    expect(clips[0].assetId).toBe('')
  })

  it('colors emphasis chunks with the highlight color', () => {
    const clips = captionClips(chunks, opts)
    expect(clips[0].title?.color).toBe('#ffffff')
    expect(clips[1].title?.color).toBe(CAPTION_EMPHASIS_COLORS[0])
  })

  it('compiles a pop entrance onto every clip', () => {
    const clips = captionClips(chunks, opts)
    for (const clip of clips) {
      expect(clip.appearance).toEqual({ in: 'pop', durS: CAPTION_POP_DUR_S })
      expect(clip.keyframes?.scale?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('inherits a base style verbatim (manual split) without upper-casing', () => {
    const base = { ...defaultTitleDef('src'), fontSizePx: 60, color: '#ff00ff' }
    const clips = captionClips(chunks, { ...opts, baseDef: base })
    expect(clips[0].title?.text).toBe('so I')
    expect(clips[0].title?.fontSizePx).toBe(60)
    expect(clips[0].title?.color).toBe('#ff00ff')
    // emphasis still wins over the inherited color
    expect(clips[1].title?.color).toBe(CAPTION_EMPHASIS_COLORS[0])
  })
})
