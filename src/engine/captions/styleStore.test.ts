// @vitest-environment jsdom
//
// The store half of the caption learning: it must survive a re-archive, a
// missing localStorage, and a model swap without ever handing his captions a
// habit he did not settle.

import { beforeEach, describe, expect, it } from 'vitest'
import type { StyleSample } from './styleLearning'
import { HABIT_MIN_SAMPLES } from './styleProfile'
import {
  clearLearnedStyle,
  learnedProfile,
  MAX_PROJECTS,
  rememberProjectStyle,
  resetStyleStoreCache,
  storedSamples,
} from './styleStore'

const MODEL = 'onnx-community/whisper-small.en_timestamped'

/** A sample that rewrites one word `seen` times, with nothing else settled. */
const sampleOf = (from: string, to: string, seen: number, model = MODEL): StyleSample => ({
  model,
  captions: seen,
  untouched: 0,
  wordFixes: [{ from, to, seen }],
  caseCounts: { lower: 0, upper: 0, title: 0, mixed: 0 },
  punctuationKept: 0,
  punctuationStripped: 0,
  sizes: [],
  animations: {},
  durations: [],
})

describe('styleStore', () => {
  beforeEach(() => {
    localStorage.clear()
    clearLearnedStyle()
  })

  it('knows nothing before he has archived anything', () => {
    expect(storedSamples()).toEqual([])
    expect(learnedProfile(MODEL)).toBeNull()
  })

  it('keeps what one archived project taught, across a reload', () => {
    rememberProjectStyle('p1', sampleOf('cs go', 'CS2', 2), 1000)
    resetStyleStoreCache() // as if the app had been closed and reopened
    const p = learnedProfile(MODEL)!
    expect(p.fixes).toEqual([{ from: 'cs go', to: 'CS2', seen: 2 }])
  })

  it('⛔ re-archiving the same project REPLACES it instead of counting it twice', () => {
    rememberProjectStyle('p1', sampleOf('cs go', 'CS2', 2), 1000)
    // He pulled it back out, changed one caption, and filed it away again.
    rememberProjectStyle('p1', sampleOf('cs go', 'CS2', 3), 2000)
    expect(storedSamples()).toHaveLength(1)
    expect(learnedProfile(MODEL)!.fixes[0].seen).toBe(3)
  })

  it('adds up across different projects', () => {
    rememberProjectStyle('p1', sampleOf('cs go', 'CS2', 1), 1000)
    rememberProjectStyle('p2', sampleOf('cs go', 'CS2', 1), 2000)
    const p = learnedProfile(MODEL)!
    expect(p.fixes).toEqual([{ from: 'cs go', to: 'CS2', seen: 2 }])
    expect(p.captions).toBe(2)
  })

  it('⛔ drops the OLDEST project once it is full, never the newest', () => {
    for (let i = 0; i < MAX_PROJECTS + 5; i++) {
      rememberProjectStyle(`p${i}`, sampleOf(`w${i}`, `W${i}`, 2), 1000 + i)
    }
    const kept = storedSamples()
    expect(kept).toHaveLength(MAX_PROJECTS)
    // Newest first, so the head is the last one archived and the five oldest
    // are the ones gone.
    expect(kept[0].wordFixes[0].from).toBe(`w${MAX_PROJECTS + 4}`)
    expect(kept.some((s) => s.wordFixes[0].from === 'w0')).toBe(false)
  })

  it('⛔ will not answer for a model it has never seen corrections for', () => {
    rememberProjectStyle('p1', sampleOf('cs go', 'CS2', 2), 1000)
    expect(learnedProfile('onnx-community/whisper-base.en_timestamped')).toBeNull()
  })

  it('ignores a stored shape it does not understand rather than guessing', () => {
    localStorage.setItem('olpremiere:captions:style-samples', JSON.stringify({ v: 99, byProject: { p1: 'junk' } }))
    resetStyleStoreCache()
    expect(storedSamples()).toEqual([])
  })

  it('ignores unreadable stored text rather than throwing on the way in', () => {
    localStorage.setItem('olpremiere:captions:style-samples', 'not json at all')
    resetStyleStoreCache()
    expect(storedSamples()).toEqual([])
    expect(() => rememberProjectStyle('p1', sampleOf('a', 'A', 2), 1)).not.toThrow()
  })

  it('a casing habit still needs the same evidence once it is stored', () => {
    const s = sampleOf('x', 'X', 2)
    rememberProjectStyle('p1', { ...s, captions: HABIT_MIN_SAMPLES, caseCounts: { lower: 0, upper: HABIT_MIN_SAMPLES, title: 0, mixed: 0 } }, 1)
    expect(learnedProfile(MODEL)!.caseHabit).toBe('upper')
  })
})
