import { describe, expect, it } from 'vitest'
import { colorRuns, fitScaleAbout, locateWord, wordBoxRect, wordSlots } from './titleRaster'
import { splitWords } from '../types'

// A deterministic measurer: each char is 10px wide. No canvas needed in node.
const measure10 = (s: string): number => s.length * 10

describe('splitWords', () => {
  it('splits on any white space and drops the empties', () => {
    expect(splitWords('one  two\tthree four')).toEqual(['one', 'two', 'three', 'four'])
    expect(splitWords('  one ')).toEqual(['one'])
    expect(splitWords('')).toEqual([])
    expect(splitWords('   ')).toEqual([])
  })
})

describe('one word split for the lit word, the box and the pop', () => {
  // Two spaces and a trailing space: a split on one plain space would count the
  // empty strings as words and name a different word than the others do.
  const lines = ['one  two ', 'three four']

  it('locateWord counts words the way every other caller does', () => {
    expect(locateWord(lines, { at: 1, word: 'two' })).toEqual({ line: 0, col: 1, index: 1 })
    expect(locateWord(lines, { at: 3, word: 'four' })).toEqual({ line: 1, col: 1, index: 3 })
  })

  it('wordBoxRect boxes the same word locateWord names', () => {
    const rect = wordBoxRect(lines, { at: 1, word: 'two' }, measure10, 0, 'left', 100, 80, 70)!
    // "one two" is one word then two; the box starts after "one " (40 px), not "one  ".
    const slot = wordSlots(lines, measure10, 0, 'left', 100, 80)[1]!
    expect(slot.text).toBe('two')
    expect(slot.x).toBe(40)
    expect(rect.x).toBeLessThan(slot.x)
    expect(rect.x + rect.w).toBeGreaterThan(slot.x + 30)
  })

  it('colorRuns lights the same word', () => {
    const runs = colorRuns(lines, [{ at: 1, word: 'two', color: '#f00' }], '#fff', measure10, 0, 'left')!
    expect(runs[0]!.find((r) => r.color === '#f00')).toEqual({ text: 'two', x: 40, color: '#f00' })
  })
})

describe('locateWord', () => {
  const lines = ['i hit a new', 'record on bench']

  it('finds a word on a later line and counts across lines', () => {
    expect(locateWord(lines, { at: 4, word: 'record' })).toEqual({ line: 1, col: 0, index: 4 })
  })

  it('matches letters and digits only, any case', () => {
    expect(locateWord(lines, { at: 4, word: 'Record,' })).toEqual({ line: 1, col: 0, index: 4 })
  })

  it('takes the nearest of a repeated word, the first of two equally near', () => {
    expect(locateWord(['go go go'], { at: 2, word: 'go' })).toEqual({ line: 0, col: 2, index: 2 })
    expect(locateWord(['go x go'], { at: 1, word: 'go' })).toEqual({ line: 0, col: 0, index: 0 })
  })

  it('is null when the word is gone', () => {
    expect(locateWord(lines, { at: 0, word: 'gone' })).toBeNull()
    expect(locateWord(lines, { at: 0, word: '!!' })).toBeNull()
  })

  it('finds a word of no letters or digits as itself', () => {
    const marked = ['so fire \u{1F525} now', 'wow !! ok']
    expect(locateWord(marked, { at: 2, word: '\u{1F525}' })).toEqual({ line: 0, col: 2, index: 2 })
    expect(locateWord(marked, { at: 5, word: '!!' })).toEqual({ line: 1, col: 1, index: 5 })
    // Only that exact mark: another one is not it.
    expect(locateWord(marked, { at: 5, word: '??' })).toBeNull()
  })

  it('an empty word names nothing', () => {
    expect(locateWord(lines, { at: 0, word: '' })).toBeNull()
    expect(locateWord(lines, { at: 0, word: '   ' })).toBeNull()
  })

  it('still strips punctuation from a real word', () => {
    expect(locateWord(['stay awake, now'], { at: 1, word: 'awake' })).toEqual({ line: 0, col: 1, index: 1 })
    expect(locateWord(['stay awake now'], { at: 1, word: 'AWAKE,' })).toEqual({ line: 0, col: 1, index: 1 })
  })
})

describe('wordSlots', () => {
  it('puts each word where the whole line puts it', () => {
    const slots = wordSlots(['ab cd', 'efg'], measure10, 0, 'left', 100, 80)
    expect(slots.map((s) => [s.text, s.x, s.baseline, s.index])).toEqual([
      ['ab', 0, 100, 0],
      ['cd', 30, 100, 1],
      ['efg', 0, 180, 2],
    ])
  })

  it('centres and right aligns each line on its own width', () => {
    const centre = wordSlots(['ab cd'], measure10, 100, 'center', 50, 80)
    expect(centre.map((s) => s.x)).toEqual([75, 105])
    const right = wordSlots(['ab cd'], measure10, 100, 'right', 50, 80)
    expect(right.map((s) => s.x)).toEqual([50, 80])
  })

  it('agrees with the colour runs on where a lit word sits', () => {
    const lines = ['one two three']
    const slots = wordSlots(lines, measure10, 200, 'center', 0, 0)
    const runs = colorRuns(lines, [{ at: 2, word: 'three', color: '#f00' }], '#fff', measure10, 200, 'center')!
    expect(runs[0]!.find((r) => r.color === '#f00')!.x).toBe(slots[2]!.x)
  })
})

describe('fitScaleAbout', () => {
  const ext = { x0: 40, y0: 40, x1: 60, y1: 60 }

  it('gives the wanted scale when there is room', () => {
    expect(fitScaleAbout(50, 50, ext, 100, 100, 1.15)).toBe(1.15)
  })

  it('holds back when the grown word would leave the canvas', () => {
    // 10 px from the centre to the right edge of the extent, 15 px of room: at most 1.5.
    const s = fitScaleAbout(50, 50, { x0: 40, y0: 40, x1: 60, y1: 60 }, 65, 100, 2)
    expect(s).toBeCloseTo(1.5, 6)
    const top = fitScaleAbout(50, 50, { x0: 40, y0: 40, x1: 60, y1: 60 }, 100, 100, 9)
    expect(top).toBeCloseTo(5, 6)
  })

  it('never shrinks a word that already reaches the edge', () => {
    expect(fitScaleAbout(50, 50, { x0: 40, y0: 40, x1: 110, y1: 60 }, 100, 100, 1.15)).toBe(1)
  })

  it('stays at 1 for numbers that are not usable', () => {
    expect(fitScaleAbout(NaN, 50, ext, 100, 100, 1.15)).toBe(1)
    expect(fitScaleAbout(50, 50, ext, 100, 100, NaN)).toBe(1)
  })
})
