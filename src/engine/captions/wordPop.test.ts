// Word pop, the pure half: which word is lit at a moment, where the word times
// come from, and that the title handed on is the same object whenever nothing
// about it changed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultTitleDef, newTitleClip, type Clip, type TitleDef } from '../types'
import { WORD_POP_COLOR, activeWordAt, popWordsFor, wordPopTitle } from './wordPop'

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

  it('does not grow without bound when the preview is scrubbed over one word', () => {
    const clip = caption()
    for (let i = 0; i < 500; i++) wordPopTitle(clip, 0.6 + (i / 500) * 0.35)
    // Still answers, and still the right word.
    expect(wordPopTitle(clip, 0.7)!.wordColors![0]!.word).toBe('two')
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
