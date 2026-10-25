// Word pop, the pure half: which word is lit at a moment, where the word times
// come from, and that the title handed on is the same object whenever nothing
// about it changed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultTitleDef, newTitleClip, type Clip, type TitleDef } from '../types'
import { resolveFrame } from '../render/resolve'
import type { RenderLayer } from '../render/types'
import type { Sequence, Track } from '../types'
import { DERIVED_CAP, WORD_POP_COLOR, WORD_POP_SIZE, activeWordAt, popScaleAt, popWordsFor, wordPopTitle } from './wordPop'

const w = (startS: number, endS: number, text = 'x') => ({ text, startS, endS })

/** A caption "one two three" said at 0.2, 0.6 and 1.0, on a clip that starts at 10 s. */
function caption(over: Partial<Clip> = {}, title: Partial<TitleDef> = {}): Clip {
  const clip = newTitleClip({ ...defaultTitleDef('one two three'), wordPop: { color: '#A3FF12' }, ...title }, 10, 1.4)
  return {
    ...clip,
    captionWords: [
      { text: 'one', startS: 0.2, endS: 0.55 },
      { text: 'two', startS: 0.6, endS: 0.95 },
      { text: 'three', startS: 1.0, endS: 1.4 },
    ],
    ...over,
  }
}

describe('activeWordAt', () => {
  const words = [w(0.2, 0.5), w(0.6, 0.9), w(1.0, 1.3)]

  it('is -1 before the first word starts', () => {
    expect(activeWordAt(words, 0)).toBe(-1)
    expect(activeWordAt(words, 0.1999)).toBe(-1)
  })

  it('lights a word from the instant it starts', () => {
    expect(activeWordAt(words, 0.2)).toBe(0)
    expect(activeWordAt(words, 0.6)).toBe(1)
    expect(activeWordAt(words, 1.0)).toBe(2)
  })

  it('keeps the previous word lit through a gap until the next one starts', () => {
    expect(activeWordAt(words, 0.55)).toBe(0)
    expect(activeWordAt(words, 0.5999)).toBe(0)
    expect(activeWordAt(words, 0.95)).toBe(1)
  })

  it('keeps the last word lit after it ends', () => {
    expect(activeWordAt(words, 1.3)).toBe(2)
    expect(activeWordAt(words, 99)).toBe(2)
  })

  it('lets a word that starts at the same instant beat a zero length word, either order', () => {
    expect(activeWordAt([w(1, 1), w(1, 1.4)], 1)).toBe(1)
    expect(activeWordAt([w(1, 1.4), w(1, 1)], 1)).toBe(0)
    expect(activeWordAt([w(1, 1), w(1, 1.4)], 2)).toBe(1)
  })

  it('lets the later of two equal words win', () => {
    expect(activeWordAt([w(1, 1.4), w(1, 1.4)], 1.1)).toBe(1)
  })

  it('lights a lone zero length word when nothing real starts with it', () => {
    expect(activeWordAt([w(0.2, 0.5), w(1, 1)], 1)).toBe(1)
  })

  it('finds the word by time even when the list is not in order', () => {
    const shuffled = [w(1.0, 1.3), w(0.2, 0.5), w(0.6, 0.9)]
    expect(activeWordAt(shuffled, 0.7)).toBe(2)
    expect(activeWordAt(shuffled, 1.1)).toBe(0)
    expect(activeWordAt(shuffled, 0.3)).toBe(1)
  })

  it('is -1 for no words and for a time that is not a number', () => {
    expect(activeWordAt([], 1)).toBe(-1)
    expect(activeWordAt(words, Number.NaN)).toBe(-1)
  })
})

describe('popWordsFor', () => {
  it('trusts the times he said the words while the caption still reads them', () => {
    const words = popWordsFor(caption())
    expect(words.map((x) => x.text)).toEqual(['one', 'two', 'three'])
    expect(words.map((x) => x.startS)).toEqual([0.2, 0.6, 1.0])
  })

  it('spreads the words across the clip by letter count once he retyped the caption', () => {
    const clip = caption({}, { text: 'one two three four' })
    const words = popWordsFor(clip)
    expect(words).toHaveLength(4)
    expect(words[0]!.startS).toBeCloseTo(clip.inS, 9)
    expect(words[3]!.endS).toBeCloseTo(clip.outS, 9)
    // "three" is longer than "one", so it gets more of the time.
    expect(words[2]!.endS - words[2]!.startS).toBeGreaterThan(words[0]!.endS - words[0]!.startS)
  })

  it('spreads a caption that has no word times at all', () => {
    const bare = { ...caption(), captionWords: undefined } as Clip
    const words = popWordsFor(bare)
    expect(words.map((x) => x.text)).toEqual(['one', 'two', 'three'])
    expect(words[0]!.startS).toBe(0)
  })

  it('pulls a first word that starts a hair after the caption back to its start', () => {
    const clip = caption({
      captionWords: [
        { text: 'one', startS: 0.03, endS: 0.5 },
        { text: 'two', startS: 0.6, endS: 0.9 },
        { text: 'three', startS: 1.0, endS: 1.3 },
      ],
    })
    expect(popWordsFor(clip)[0]!.startS).toBe(0)
    // Further off than that is a real pause before the first word, and stays.
    const late = caption({
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.5 },
        { text: 'two', startS: 0.6, endS: 0.9 },
        { text: 'three', startS: 1.0, endS: 1.3 },
      ],
    })
    expect(popWordsFor(late)[0]!.startS).toBe(0.2)
  })

  it('follows the clip in time: a clip whose in point moved reads the words at their own times', () => {
    // Cut at 0.5 s into the content: the second half starts there, its words keep their times.
    const after = caption({ inS: 0.5, outS: 1.4, startS: 20 })
    const words = popWordsFor(after)
    expect(words.map((x) => x.startS)).toEqual([0.2, 0.6, 1.0])
    // At the clip's start (content 0.5) the first word, said before it, is already the one lit.
    expect(activeWordAt(words, after.inS)).toBe(0)
    expect(activeWordAt(words, 0.6)).toBe(1)
  })

  it('is memoised per clip and re-reads once the clip changes', () => {
    const clip = caption()
    expect(popWordsFor(clip)).toBe(popWordsFor(clip))
    const other = { ...clip, title: { ...clip.title!, text: 'one two' } }
    expect(popWordsFor(other)).not.toBe(popWordsFor(clip))
  })

  it('is empty for an empty caption', () => {
    expect(popWordsFor(caption({}, { text: '   ' }))).toEqual([])
  })
})

describe('wordPopTitle', () => {
  it('hands back the very same title when the clip has no word pop', () => {
    const clip = caption({}, { wordPop: undefined })
    expect(wordPopTitle(clip, 0.7)).toBe(clip.title)
  })

  it('hands back the same title for an inverted backdrop title, which cannot take a colour', () => {
    const clip = caption({}, { invertBackdrop: true })
    expect(wordPopTitle(clip, 0.7)).toBe(clip.title)
  })

  it('hands back the same title before the first word is said', () => {
    const clip = caption()
    expect(wordPopTitle(clip, 0.1)).toBe(clip.title)
  })

  it('is undefined for a clip with no title', () => {
    const bare = { ...caption(), title: undefined } as Clip
    expect(wordPopTitle(bare, 0.7)).toBeUndefined()
  })

  it('lights only the word being said, in the pop colour', () => {
    const clip = caption()
    const mid = wordPopTitle(clip, 0.7)!
    expect(mid.wordColors).toEqual([{ at: 1, word: 'two', color: '#A3FF12' }])
    // The text and the look are untouched.
    expect(mid.text).toBe('one two three')
    expect(mid.color).toBe(clip.title!.color)
  })

  it('lights the word from the instant it starts', () => {
    const at = wordPopTitle(caption(), 0.2)!
    expect(at.wordColors).toEqual([{ at: 0, word: 'one', color: '#A3FF12' }])
  })

  it('keeps the word lit to the end and goes back to normal when the next word starts', () => {
    const clip = caption()
    expect(wordPopTitle(clip, 0.5999)!.wordColors).toEqual([{ at: 0, word: 'one', color: '#A3FF12' }])
    const next = wordPopTitle(clip, 0.6)!
    expect(next.wordColors).toEqual([{ at: 1, word: 'two', color: '#A3FF12' }])
  })

  it('gives the word being said the pop colour even when it is a highlighted word', () => {
    const clip = caption({}, { wordColors: [{ at: 1, word: 'two', color: '#FFD400' }, { at: 2, word: 'three', color: '#3B7DFF' }] })
    const t = wordPopTitle(clip, 0.7)!
    // Appended last, and the rasterizer lets the later entry for a word win.
    expect(t.wordColors![t.wordColors!.length - 1]).toEqual({ at: 1, word: 'two', color: '#A3FF12' })
    // The word he leaned on that is not being said keeps its own colour.
    expect(t.wordColors).toContainEqual({ at: 2, word: 'three', color: '#3B7DFF' })
  })

  it('uses the colour on the title, and the default one if it is blank', () => {
    expect(wordPopTitle(caption({}, { wordPop: { color: '#FF0000' } }), 0.7)!.wordColors![0]!.color).toBe('#FF0000')
    expect(wordPopTitle(caption({}, { wordPop: { color: '' } }), 0.7)!.wordColors![0]!.color).toBe(WORD_POP_COLOR)
  })

  it('returns the same object for the same state, a different one for a different state', () => {
    const clip = caption()
    expect(wordPopTitle(clip, 0.7)).toBe(wordPopTitle(clip, 0.71))
    expect(wordPopTitle(clip, 0.7)).not.toBe(wordPopTitle(clip, 1.1))
    expect(wordPopTitle(clip, 0.62)).toBe(wordPopTitle(clip, 0.62))
    // A whole word is one state, from its first frame to its last, so the raster cache hits.
    expect(wordPopTitle(clip, 0.6)).toBe(wordPopTitle(clip, 0.94))
    // The title on the clip is never written to.
    expect(clip.title!.wordColors).toBeUndefined()
  })

  it('keeps the field order stable, so the raster cache key does not wander', () => {
    const clip = caption()
    const a = Object.keys(wordPopTitle(clip, 0.62)!)
    const b = Object.keys(wordPopTitle(clip, 1.05)!)
    expect(a).toEqual(b)
    expect(a.slice(-1)).toEqual(['wordColors'])
  })

  it('keeps answering the right word when the preview is scrubbed over one word', () => {
    const clip = caption()
    for (let i = 0; i < 500; i++) wordPopTitle(clip, 0.6 + (i / 500) * 0.35)
    // Still answers, and still the right word.
    expect(wordPopTitle(clip, 0.7)!.wordColors![0]!.word).toBe('two')
  })

  it('stays bounded past the cap: the right title still comes back and the same state is the same object', () => {
    // More distinct states than the cap holds: one lit word each, on a long caption.
    const n = DERIVED_CAP * 2 + 10
    const names = Array.from({ length: n }, (_, i) => `w${i}`)
    const said = names.map((text, i) => ({ text, startS: i * 0.5, endS: i * 0.5 + 0.4 }))
    const clip = newTitleClip({ ...defaultTitleDef(names.join(' ')), wordPop: { color: '#A3FF12' } }, 0, n * 0.5)
    const long: Clip = { ...clip, captionWords: said }
    const first = wordPopTitle(long, 0.01)!
    expect(first.wordColors![0]!.word).toBe('w0')
    const seen: TitleDef[] = []
    for (let i = 0; i < n; i++) {
      const t = wordPopTitle(long, i * 0.5 + 0.01)!
      // The right word, every time, whether or not the cap was passed on the way.
      expect(t.wordColors).toEqual([{ at: i, word: `w${i}`, color: '#A3FF12' }])
      // The same state asked again at once is the very same object.
      expect(wordPopTitle(long, i * 0.5 + 0.2)).toBe(t)
      seen.push(t)
    }
    // The newest states are still held (a map that kept growing would hold them all).
    expect(wordPopTitle(long, (n - 1) * 0.5 + 0.01)).toBe(seen[n - 1])
    // The oldest were let go when the cap was passed: asked again they are rebuilt, equal but new.
    const again = wordPopTitle(long, 0.01)!
    expect(again).not.toBe(first)
    expect(again).toEqual(first)
    expect(again.wordColors![0]!.word).toBe('w0')
  })
})

describe('wordPopTitle with a word box', () => {
  const BOX = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }
  /** The box alone: no pop colour. */
  const boxOnly = (over: Partial<Clip> = {}, title: Partial<TitleDef> = {}): Clip =>
    caption(over, { wordPop: undefined, wordBox: BOX, ...title })

  it('marks the word being said and nothing else when the box is on its own', () => {
    const t = wordPopTitle(boxOnly(), 0.7)!
    expect(t.boxWord).toEqual({ at: 1, word: 'two' })
    expect(t.wordColors).toBeUndefined()
    // The stored look rides along untouched.
    expect(t.wordBox).toEqual(BOX)
    expect(t.text).toBe('one two three')
  })

  it('moves to the next word the instant it starts, and stays on the last one', () => {
    const clip = boxOnly()
    expect(wordPopTitle(clip, 0.2)!.boxWord).toEqual({ at: 0, word: 'one' })
    expect(wordPopTitle(clip, 0.5999)!.boxWord).toEqual({ at: 0, word: 'one' })
    expect(wordPopTitle(clip, 0.6)!.boxWord).toEqual({ at: 1, word: 'two' })
    expect(wordPopTitle(clip, 1.0)!.boxWord).toEqual({ at: 2, word: 'three' })
    expect(wordPopTitle(clip, 99)!.boxWord).toEqual({ at: 2, word: 'three' })
  })

  it('is the same title before the first word is said', () => {
    const clip = boxOnly()
    expect(wordPopTitle(clip, 0.1)).toBe(clip.title)
  })

  it('gives the very same object for the same word, a different one for the next word', () => {
    const clip = boxOnly()
    // A whole word is one state however many frames it lasts.
    expect(wordPopTitle(clip, 0.61)).toBe(wordPopTitle(clip, 0.9))
    expect(wordPopTitle(clip, 0.61)).not.toBe(wordPopTitle(clip, 1.1))
    // The title on the clip is never written to.
    expect(clip.title!.boxWord).toBeUndefined()
  })

  it('hands back the same title for an inverted backdrop title, box or not', () => {
    const clip = boxOnly({}, { invertBackdrop: true })
    expect(wordPopTitle(clip, 0.7)).toBe(clip.title)
  })

  it('hands back the same title when there is neither a pop nor a box', () => {
    const clip = caption({}, { wordPop: undefined })
    expect(wordPopTitle(clip, 0.7)).toBe(clip.title)
  })

  it('works together with the pop: the lit word and its box are the same word', () => {
    const clip = caption({}, { wordBox: BOX })
    const t = wordPopTitle(clip, 0.7)!
    expect(t.wordColors).toEqual([{ at: 1, word: 'two', color: '#A3FF12' }])
    expect(t.boxWord).toEqual({ at: 1, word: 'two' })
  })

  it('keeps the field order stable with both on, boxWord last', () => {
    const clip = caption({}, { wordBox: BOX })
    const a = Object.keys(wordPopTitle(clip, 0.62)!)
    const b = Object.keys(wordPopTitle(clip, 1.05)!)
    expect(a).toEqual(b)
    expect(a.slice(-2)).toEqual(['wordColors', 'boxWord'])
  })

  it('reads the words he said, and falls back to spread words after a retype', () => {
    const retyped = boxOnly({}, { text: 'one two three four' })
    const t = wordPopTitle(retyped, retyped.inS + 0.01)!
    expect(t.boxWord).toEqual({ at: 0, word: 'one' })
    const late = wordPopTitle(retyped, retyped.outS - 0.01)!
    expect(late.boxWord).toEqual({ at: 3, word: 'four' })
  })
})

describe('popScaleAt', () => {
  const PEAK = 1.15

  it('is 1 before the word starts and at the very start', () => {
    expect(popScaleAt(-0.5, PEAK)).toBe(1)
    expect(popScaleAt(-1e-9, PEAK)).toBe(1)
    expect(popScaleAt(0, PEAK)).toBe(1)
  })

  it('reaches exactly the peak a tenth of a second in', () => {
    expect(popScaleAt(0.1, PEAK)).toBe(PEAK)
    expect(popScaleAt(0.1, 1.4)).toBe(1.4)
  })

  it('is exactly 1 from a fifth of a second on, however long the word lasts', () => {
    expect(popScaleAt(0.2, PEAK)).toBe(1)
    expect(popScaleAt(0.2000001, PEAK)).toBe(1)
    expect(popScaleAt(3, PEAK)).toBe(1)
    expect(popScaleAt(1e6, PEAK)).toBe(1)
  })

  it('only grows on the way up and only shrinks on the way down', () => {
    let prev = popScaleAt(0, PEAK)
    for (let i = 1; i <= 100; i++) {
      const v = popScaleAt((i / 100) * 0.1, PEAK)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    expect(prev).toBe(PEAK)
    for (let i = 1; i <= 100; i++) {
      const v = popScaleAt(0.1 + (i / 100) * 0.1, PEAK)
      expect(v).toBeLessThanOrEqual(prev)
      prev = v
    }
    expect(prev).toBe(1)
  })

  it('never leaves the range from 1 to the peak', () => {
    for (let i = -20; i <= 400; i++) {
      const v = popScaleAt(i / 1000, PEAK)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(PEAK)
    }
  })

  it('jumps first and eases in: most of the swell by the middle of the rise, and slow to start settling', () => {
    // Ease out: most of the swell is done by the middle of the rise.
    expect(popScaleAt(0.05, PEAK)).toBeGreaterThan(1 + (PEAK - 1) * 0.8)
    // Ease in and out on the way back: still near the top a quarter of the way down...
    expect(popScaleAt(0.125, PEAK)).toBeGreaterThan(1 + (PEAK - 1) * 0.8)
    // ...and exactly in the middle half way down.
    expect(popScaleAt(0.15, PEAK)).toBeCloseTo(1 + (PEAK - 1) / 2, 12)
  })

  it('pops a word he leaned on a third further: 1 + (peak - 1) * 4/3', () => {
    expect(popScaleAt(0.1, PEAK, true)).toBeCloseTo(1 + (PEAK - 1) * (4 / 3), 12)
    expect(popScaleAt(0.1, PEAK, true)).toBeCloseTo(1.2, 12)
    expect(popScaleAt(0.1, 1.3, true)).toBeCloseTo(1.4, 12)
    // The emphasised pop starts and ends at 1 like any other.
    expect(popScaleAt(0, PEAK, true)).toBe(1)
    expect(popScaleAt(0.2, PEAK, true)).toBe(1)
    // And is bigger than the plain one all the way through.
    for (const dt of [0.02, 0.05, 0.1, 0.13, 0.17]) {
      expect(popScaleAt(dt, PEAK, true)).toBeGreaterThan(popScaleAt(dt, PEAK, false))
    }
  })

  it('is no pop for a peak of 1 or less, or one that is not a number', () => {
    for (const peak of [1, 0.9, 0, -2, NaN, Infinity, -Infinity]) {
      expect(popScaleAt(0.1, peak)).toBe(1)
      expect(popScaleAt(0.1, peak, true)).toBe(1)
    }
  })

  it('is 1 for a time that is not a number', () => {
    expect(popScaleAt(NaN, PEAK)).toBe(1)
  })

  it('starts a new size pop at 15 percent', () => {
    expect(WORD_POP_SIZE).toBe(1.15)
  })

  describe('a word shorter than the pop', () => {
    it('is back at exactly 1 when the next word starts, not cut off mid swell', () => {
      // Said for 0.12 s, the old curve was still 1.149 at 0.119 and snapped to 1 at the next word.
      expect(popScaleAt(0.119, PEAK)).toBeGreaterThan(1.1)
      expect(popScaleAt(0.119, PEAK, false, 0.12)).toBeLessThan(1.005)
      expect(popScaleAt(0.12, PEAK, false, 0.12)).toBe(1)
      expect(popScaleAt(0.5, PEAK, false, 0.12)).toBe(1)
    })

    it('squeezes the rise and the settle by span over 0.2, so the top comes at half the span', () => {
      expect(popScaleAt(0.06, PEAK, false, 0.12)).toBeCloseTo(PEAK, 12)
      expect(popScaleAt(0.03, PEAK, false, 0.12)).toBeCloseTo(popScaleAt(0.05, PEAK), 12)
      expect(popScaleAt(0.09, PEAK, false, 0.12)).toBeCloseTo(popScaleAt(0.15, PEAK), 12)
      // The emphasised pop squeezes the same way and keeps its taller peak.
      expect(popScaleAt(0.06, PEAK, true, 0.12)).toBeCloseTo(1.2, 12)
      expect(popScaleAt(0.12, PEAK, true, 0.12)).toBe(1)
    })

    it('stays continuous, rising then falling, and inside 1 to the peak', () => {
      const span = 0.12
      let prev = popScaleAt(0, PEAK, false, span)
      expect(prev).toBe(1)
      let topAt = 0
      let top = 1
      for (let i = 1; i <= 240; i++) {
        const dt = (i / 240) * span
        const v = popScaleAt(dt, PEAK, false, span)
        expect(Math.abs(v - prev)).toBeLessThan(0.01)
        expect(v).toBeGreaterThanOrEqual(1)
        expect(v).toBeLessThanOrEqual(PEAK + 1e-12)
        if (v > top) {
          top = v
          topAt = dt
        }
        prev = v
      }
      expect(top).toBeCloseTo(PEAK, 9)
      expect(topAt).toBeCloseTo(span / 2, 2)
      expect(prev).toBeLessThan(1 + 1e-9)
    })

    it('leaves a word of a fifth of a second or more exactly as it was', () => {
      for (const span of [0.2, 0.25, 0.3, 1, 60, Infinity]) {
        for (let i = 0; i <= 250; i++) {
          const dt = i / 1000
          expect(popScaleAt(dt, PEAK, false, span)).toBe(popScaleAt(dt, PEAK))
          expect(popScaleAt(dt, PEAK, true, span)).toBe(popScaleAt(dt, PEAK, true))
        }
      }
    })

    it('makes a word with no time at all, or a span that is not a number, no pop', () => {
      for (const span of [0, -0.1, NaN]) expect(popScaleAt(0.05, PEAK, false, span)).toBe(1)
    })

    it('is exactly 1, never NaN, for a span of nothing or less at any time', () => {
      for (const span of [0, -1e-9, -0.05, -0.2, -60, -Infinity, NaN]) {
        for (let i = -5; i <= 300; i += 5) {
          for (const emphasis of [false, true]) {
            const v = popScaleAt(i / 1000, PEAK, emphasis, span)
            expect(Number.isNaN(v), `span ${span}, dt ${i / 1000}`).toBe(false)
            expect(v).toBe(1)
          }
        }
      }
    })
  })
})

describe('wordPopTitle with a size pop', () => {
  /** The size pop alone: no colour, no box. */
  const sizeOnly = (over: Partial<Clip> = {}, title: Partial<TitleDef> = {}): Clip =>
    caption(over, { wordPop: undefined, wordPopSize: WORD_POP_SIZE, ...title })

  it('hands back the plain title at the start of a word, where the pop has not begun', () => {
    const clip = sizeOnly()
    expect(wordPopTitle(clip, 0.6)).toBe(clip.title)
  })

  it('marks the word being said with its size, a tenth of a second in', () => {
    const t = wordPopTitle(sizeOnly(), 0.7)!
    expect(t.popWord).toEqual({ at: 1, word: 'two', scale: 1.15 })
    // Nothing else is marked: the colour and the box are their own switches.
    expect(t.wordColors).toBeUndefined()
    expect(t.boxWord).toBeUndefined()
    // The stored look rides along untouched.
    expect(t.wordPopSize).toBe(1.15)
    expect(t.text).toBe('one two three')
  })

  it('swells on the way up and shrinks on the way back, word by word', () => {
    const clip = sizeOnly()
    const scaleAt = (t: number): number => wordPopTitle(clip, t)!.popWord?.scale ?? 1
    expect(scaleAt(0.62)).toBeGreaterThan(1)
    expect(scaleAt(0.66)).toBeGreaterThan(scaleAt(0.62))
    expect(scaleAt(0.7)).toBe(1.15)
    expect(scaleAt(0.75)).toBeLessThan(scaleAt(0.7))
    // The next word starts its own pop from the beginning.
    expect(scaleAt(1.0)).toBe(1)
    expect(wordPopTitle(clip, 1.1)!.popWord).toEqual({ at: 2, word: 'three', scale: 1.15 })
  })

  it('is the plain title again once the pop has settled, until the next word starts', () => {
    const clip = sizeOnly()
    expect(wordPopTitle(clip, 0.8)).toBe(clip.title)
    expect(wordPopTitle(clip, 0.99)).toBe(clip.title)
    expect(wordPopTitle(clip, 0.8)!.popWord).toBeUndefined()
  })

  it('is the plain title before the first word is said', () => {
    const clip = sizeOnly()
    expect(wordPopTitle(clip, 0.1)).toBe(clip.title)
  })

  it('pops a word he leaned on further', () => {
    const clip = sizeOnly({
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.55 },
        { text: 'two', startS: 0.6, endS: 0.95, emphasis: true },
        { text: 'three', startS: 1.0, endS: 1.4 },
      ],
    })
    expect(wordPopTitle(clip, 0.7)!.popWord!.scale).toBeCloseTo(1.2, 3)
    // The words next to it pop the usual amount.
    expect(wordPopTitle(clip, 0.3)!.popWord!.scale).toBe(1.15)
    expect(wordPopTitle(clip, 1.1)!.popWord!.scale).toBe(1.15)
  })

  it('does not pop for null, 1 or less, or a size that is not a number', () => {
    for (const size of [null, 1, 0.8, 0, NaN, Infinity]) {
      const clip = sizeOnly({}, { wordPopSize: size })
      expect(wordPopTitle(clip, 0.7)).toBe(clip.title)
    }
  })

  it('hands back the same title for an inverted backdrop title', () => {
    const clip = sizeOnly({}, { invertBackdrop: true })
    expect(wordPopTitle(clip, 0.7)).toBe(clip.title)
  })

  it('draws the size in steps of half a percent, so frames that look alike share one raster', () => {
    const clip = sizeOnly()
    const seen = new Set<TitleDef>()
    for (let i = 0; i < 400; i++) {
      const t = wordPopTitle(clip, 0.6 + (i / 400) * 0.4)!
      if (t.popWord) {
        seen.add(t)
        expect(Math.round(t.popWord.scale * 1000) % 5).toBe(0)
        expect(t.popWord.scale).toBeGreaterThan(1)
        expect(t.popWord.scale).toBeLessThanOrEqual(1.2)
      }
    }
    // A peak of 1.15 is 30 steps above 1, and a step on the way up is the same state as on the way back.
    expect(seen.size).toBeGreaterThan(10)
    expect(seen.size).toBeLessThanOrEqual(30)
  })

  it('returns the same object for the same state, a different one for a different state', () => {
    const clip = sizeOnly()
    expect(wordPopTitle(clip, 0.7)).toBe(wordPopTitle(clip, 0.7))
    // Just either side of the top the size is the same step.
    expect(wordPopTitle(clip, 0.7)).toBe(wordPopTitle(clip, 0.7 + 1 / 240))
    expect(wordPopTitle(clip, 0.64)).not.toBe(wordPopTitle(clip, 0.7))
    // The title on the clip is never written to.
    expect(clip.title!.popWord).toBeUndefined()
  })

  it('works with the colour and the box: the same word, popWord last', () => {
    const BOX = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }
    const clip = caption({}, { wordBox: BOX, wordPopSize: WORD_POP_SIZE })
    const t = wordPopTitle(clip, 0.7)!
    expect(t.wordColors).toEqual([{ at: 1, word: 'two', color: '#A3FF12' }])
    expect(t.boxWord).toEqual({ at: 1, word: 'two' })
    expect(t.popWord).toEqual({ at: 1, word: 'two', scale: 1.15 })
    expect(Object.keys(t).slice(-3)).toEqual(['wordColors', 'boxWord', 'popWord'])
    // Settled: the colour and the box stay, the pop is gone.
    const settled = wordPopTitle(clip, 0.9)!
    expect(settled.boxWord).toEqual({ at: 1, word: 'two' })
    expect(settled.popWord).toBeUndefined()
    expect(Object.keys(settled).slice(-2)).toEqual(['wordColors', 'boxWord'])
  })

  it('keeps the field order stable across pop states, so the raster cache key does not wander', () => {
    const clip = caption({}, { wordPopSize: WORD_POP_SIZE })
    const a = Object.keys(wordPopTitle(clip, 0.62)!)
    const b = Object.keys(wordPopTitle(clip, 0.7)!)
    const c = Object.keys(wordPopTitle(clip, 1.05)!)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(a.slice(-2)).toEqual(['wordColors', 'popWord'])
  })

  it('spreads the words after a retype, and the pop follows the spread word', () => {
    const retyped = sizeOnly({}, { text: 'one two three four' })
    const first = wordPopTitle(retyped, retyped.inS + 0.01)!
    expect(first.popWord!.word).toBe('one')
    expect(first.popWord!.at).toBe(0)
  })

  it('copies the lean on a word into the words it pops', () => {
    const clip = sizeOnly({
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.55, emphasis: true },
        { text: 'two', startS: 0.6, endS: 0.95 },
        { text: 'three', startS: 1.0, endS: 1.4 },
      ],
    })
    expect(popWordsFor(clip).map((x) => x.emphasis === true)).toEqual([true, false, false])
  })

  it('squeezes the pop of a word said in under a fifth of a second, so it is its own size when the next starts', () => {
    // 'one' lasts 0.12 s (0.2 to 0.32): it swells and is back to 1 by 0.32, not snapped back from near the top.
    const quick = sizeOnly({
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.32 },
        { text: 'two', startS: 0.32, endS: 0.95 },
        { text: 'three', startS: 1.0, endS: 1.4 },
      ],
    })
    const scaleAt = (t: number): number => wordPopTitle(quick, t)!.popWord?.scale ?? 1
    expect(scaleAt(0.26)).toBe(1.15) // half the span, the top
    expect(scaleAt(0.23)).toBeGreaterThan(1.1)
    // The last moments of the word: nearly settled, where the old curve was still at the top.
    expect(scaleAt(0.3199)).toBeLessThanOrEqual(1.005)
    // And the next word starts its own pop from the beginning, so nothing is left over.
    expect(wordPopTitle(quick, 0.32)).toBe(quick.title)
    expect(scaleAt(0.32 + 0.1)).toBe(1.15)
    // The same word said for 0.4 s keeps the pop it always had (the top at 0.1 s in, at 0.3 s still 1).
    const slow = sizeOnly()
    expect(wordPopTitle(slow, 0.3)!.popWord).toEqual({ at: 0, word: 'one', scale: 1.15 })
    expect(wordPopTitle(slow, 0.5)).toBe(slow.title)
  })

  it('gives the last word the full pop while the caption runs on past it, because no word follows it to give way to', () => {
    const last = sizeOnly({
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.55 },
        { text: 'two', startS: 0.6, endS: 0.95 },
        { text: 'three', startS: 1.0, endS: 1.05 },
      ],
    })
    expect(wordPopTitle(last, 1.1)!.popWord).toEqual({ at: 2, word: 'three', scale: 1.15 })
  })

  it('squeezes the pop of the last word into what is left of the caption, so it is not cut off at the end', () => {
    // The caption ends at 1.4 and 'three' starts at 1.35: it has 0.05 s, a quarter of the pop.
    const late = sizeOnly({
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.55 },
        { text: 'two', startS: 0.6, endS: 0.95 },
        { text: 'three', startS: 1.35, endS: 1.4 },
      ],
    })
    expect(late.outS).toBe(1.4)
    const scaleAt = (t: number): number => wordPopTitle(late, t)!.popWord?.scale ?? 1
    expect(scaleAt(1.375)).toBe(1.15) // half the span, the top
    expect(scaleAt(1.36)).toBeGreaterThan(1.05)
    // The last moments of the caption: settled, where the full curve was still near the top.
    expect(scaleAt(1.399)).toBeLessThanOrEqual(1.005)
    expect(scaleAt(1.4)).toBe(1)
    expect(wordPopTitle(late, 1.4)).toBe(late.title)
  })

  it('does not pop a word that starts at or after the end of the caption', () => {
    for (const startS of [1.4, 1.5, 3]) {
      const beyond = sizeOnly({
        captionWords: [
          { text: 'one', startS: 0.2, endS: 0.55 },
          { text: 'two', startS: 0.6, endS: 0.95 },
          { text: 'three', startS, endS: startS + 0.2 },
        ],
      })
      for (const t of [startS, startS + 0.02, startS + 0.1, startS + 0.3]) {
        expect(wordPopTitle(beyond, t), `three at ${startS}, looked at ${t}`).toBe(beyond.title)
      }
    }
  })

  it('caps the last word at the caption end in its own time after a trim and a speed change', () => {
    const t = sizeOnly({
      inS: 0.5,
      outS: 1.04,
      speed: 2,
      captionWords: [
        { text: 'one', startS: 0.2, endS: 0.55 },
        { text: 'two', startS: 0.6, endS: 0.95 },
        { text: 'three', startS: 1.0, endS: 1.4 },
      ],
    })
    expect(wordPopTitle(t, 1.02)!.popWord).toEqual({ at: 2, word: 'three', scale: 1.15 })
    expect(wordPopTitle(t, 1.04)).toBe(t.title)
  })

  it('gives a short word the pop up to the next word start, not to the end of the word itself', () => {
    // 'one' is over at 0.27 but 'two' does not start until 1.0: it has the whole gap, so the full pop.
    const gap = sizeOnly(
      {
        captionWords: [
          { text: 'one', startS: 0.2, endS: 0.27 },
          { text: 'two', startS: 1.0, endS: 1.4 },
        ],
      },
      { text: 'one two' },
    )
    const scaleAt = (t: number): number => wordPopTitle(gap, t)!.popWord?.scale ?? 1
    expect(scaleAt(0.3)).toBe(1.15)
    expect(scaleAt(0.35)).toBeLessThan(1.15)
    expect(scaleAt(0.35)).toBeGreaterThan(1)
    expect(scaleAt(0.5)).toBe(1)
  })

  it('has a word give way when the next one starts, even though it is still being said', () => {
    // 'one' runs to 0.9 but 'two' starts at 0.3: 'one' has 0.1 s, so it is back to 1 by 0.3.
    const overlap = sizeOnly(
      {
        captionWords: [
          { text: 'one', startS: 0.2, endS: 0.9 },
          { text: 'two', startS: 0.3, endS: 1.0 },
        ],
      },
      { text: 'one two' },
    )
    const scaleAt = (t: number): number => wordPopTitle(overlap, t)!.popWord?.scale ?? 1
    expect(scaleAt(0.25)).toBe(1.15) // half of its 0.1 s, the top
    expect(scaleAt(0.2999)).toBeLessThanOrEqual(1.005)
    expect(scaleAt(0.3)).toBe(1)
    expect(wordPopTitle(overlap, 0.3)).toBe(overlap.title)
    // And 'two' starts its own pop from the beginning.
    expect(wordPopTitle(overlap, 0.4)!.popWord).toEqual({ at: 1, word: 'two', scale: 1.15 })
  })

  it('pops, boxes and lights an emoji and a word of marks as itself', () => {
    const BOX = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }
    const marks = caption(
      {
        captionWords: [
          { text: '!!', startS: 0.2, endS: 0.55 },
          { text: '\u{1F525}', startS: 0.6, endS: 0.95 },
          { text: 'now', startS: 1.0, endS: 1.4 },
        ],
      },
      { text: '!! \u{1F525} now', wordBox: BOX, wordPopSize: WORD_POP_SIZE },
    )
    const bang = wordPopTitle(marks, 0.3)!
    expect(bang.boxWord).toEqual({ at: 0, word: '!!' })
    expect(bang.popWord).toEqual({ at: 0, word: '!!', scale: 1.15 })
    expect(bang.wordColors).toEqual([{ at: 0, word: '!!', color: '#A3FF12' }])
    const fire = wordPopTitle(marks, 0.7)!
    expect(fire.boxWord).toEqual({ at: 1, word: '\u{1F525}' })
    expect(fire.popWord).toEqual({ at: 1, word: '\u{1F525}', scale: 1.15 })
    expect(fire.wordColors).toEqual([{ at: 1, word: '\u{1F525}', color: '#A3FF12' }])
    // The words are told apart by place and by name, so the two states are two titles.
    expect(fire).not.toBe(bang)
  })
})

// The size is worked out where the frame is: once per layer, at the frame's own
// time. The motion blur takes a second look at the TRANSFORM half a frame later
// and never re-resolves the title, so a popping word cannot smear into two sizes
// or cost a second raster.
describe('the size pop at resolve time', () => {
  const FPS = 30
  const poppingTrack = (over: Partial<Clip> = {}): Track => ({
    id: 'pop-track',
    kind: 'video',
    name: 'V1',
    height: 64,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips: [
      {
        ...caption({}, { wordPop: undefined, wordPopSize: WORD_POP_SIZE }),
        startS: 5,
        assetId: '',
        // A title that travels, so the resolver hands out a second transform sample.
        keyframes: {
          posX: [
            { t: 0, value: -500, ease: 'linear' },
            { t: 1, value: 0, ease: 'linear' },
          ],
        },
        ...over,
      },
    ],
  })
  const seqOf = (tracks: Track[], over: Partial<Sequence> = {}): Sequence =>
    ({
      id: 'pop-seq',
      name: 'Seq',
      fps: FPS,
      width: 1920,
      height: 1080,
      sampleRate: 48000,
      durationS: 0,
      tracks,
      markers: [],
      ...over,
    }) as Sequence
  const layerAt = (seq: Sequence, t: number): RenderLayer => {
    const op = resolveFrame(seq, t).ops[0]
    if (op?.type !== 'layer') throw new Error('expected a layer op')
    return op.layer
  }

  it('hands the renderer the size at the frame time', () => {
    const seq = seqOf([poppingTrack()])
    // Clip content time 0.7 is inside the word "two", a tenth in: the top of the pop.
    expect(layerAt(seq, 5.7).title?.popWord).toEqual({ at: 1, word: 'two', scale: 1.15 })
    // A frame earlier and later are not.
    expect(layerAt(seq, 5.7 - 1 / FPS).title?.popWord?.scale).toBeLessThan(1.15)
    expect(layerAt(seq, 5.7 + 1 / FPS).title?.popWord?.scale).toBeLessThan(1.15)
    // Settled.
    expect(layerAt(seq, 5.9).title?.popWord).toBeUndefined()
  })

  it('resolves the title once for the frame, so the shutter sample carries no second size', () => {
    const seq = seqOf([poppingTrack()], { shutterAngle: 360 })
    const l = layerAt(seq, 5.7)
    // The blur really is on for this layer...
    expect(l.transformAtShutter).toBeDefined()
    // ...and the title is one object with the frame's own size, however wide the shutter.
    expect(l.title?.popWord?.scale).toBe(1.15)
    // A frame later in the same pop is a different, smaller size: the frame decides, not the shutter.
    expect(layerAt(seq, 5.7 + 1 / FPS).title?.popWord?.scale).toBeLessThan(l.title!.popWord!.scale)
  })

  it('gives every frame in the same pop state the very same title, so the raster is drawn once', () => {
    const t = poppingTrack()
    const seq = seqOf([t])
    expect(layerAt(seq, 5.7).title).toBe(layerAt(seq, 5.7).title)
    // Shutter on or off makes no difference to the title.
    const blurred = seqOf([t], { shutterAngle: 360 })
    expect(layerAt(blurred, 5.7).title).toBe(layerAt(seq, 5.7).title)
  })
})

// ⛔ DECIDED IN ONE PLACE (the header of wordPop.ts). The monitor and the export worker
// both draw layer.title, so the lit word and the box agree between the preview and the
// file only while layerFor in render/resolve.ts is the one place that works them out.
// A second caller of wordPopTitle, or a direct call to activeWordAt, is a
// second answer to "which word is it", and this reads the source to catch one.
const SRC = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** A file's code with its comments cut, so a name in a comment is not a call. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

/** Every source file outside wordPop.ts that calls `name(`, with how many calls it makes. */
function callersOf(name: string): string[] {
  const own = join(SRC, 'engine', 'captions', 'wordPop.ts')
  const call = new RegExp(`\\b${name}\\s*\\(`, 'g')
  return sourceFiles(SRC)
    .filter((path) => path !== own)
    .flatMap((path) => {
      const n = codeOf(path).match(call)?.length ?? 0
      return n > 0 ? [`${relative(SRC, path).replace(/\\/g, '/')} x${n}`] : []
    })
}

describe('wordPopTitle has exactly one caller', () => {
  it('is layerFor in render/resolve.ts, once', () => {
    expect(callersOf('wordPopTitle')).toEqual(['engine/render/resolve.ts x1'])
  })

  it('is called there as the layer title, inside layerFor', () => {
    const code = codeOf(join(SRC, 'engine', 'render', 'resolve.ts'))
    const start = code.indexOf('function layerFor(')
    expect(start).toBeGreaterThan(-1)
    // A top level function ends at the first closing brace in column 0.
    const layerFor = code.slice(start, code.indexOf('\n}\n', start))
    expect(layerFor).toContain('title: wordPopTitle(clip, sourceTimeS)')
  })

  it('leaves activeWordAt to wordPop.ts alone', () => {
    expect(callersOf('activeWordAt')).toEqual([])
  })
})
