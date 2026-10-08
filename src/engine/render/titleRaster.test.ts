import { describe, expect, it } from 'vitest'
import { blockLayout, colorRuns, wordColorsOn, wrapLinesWith } from './titleRaster'

// A deterministic measurer: each char is 10px wide. No canvas needed in node.
const measure10 = (s: string): number => s.length * 10

describe('wrapLinesWith', () => {
  it('keeps a short line intact', () => {
    expect(wrapLinesWith(measure10, 'hi there', 1000)).toEqual(['hi there'])
  })

  it('honors explicit \\n hard breaks', () => {
    expect(wrapLinesWith(measure10, 'a\nb\nc', 1000)).toEqual(['a', 'b', 'c'])
  })

  it('hard-wraps first, then word-wraps each paragraph', () => {
    // maxWidth 50px = 5 chars. "one two" (7 chars) must split.
    const out = wrapLinesWith(measure10, 'one two\nthree', 50)
    expect(out).toEqual(['one', 'two', 'three'])
  })

  it('greedy-wraps words to maxWidth', () => {
    // 60px = 6 chars. "aa bb cc" → "aa bb" (5) fits, "cc" starts a new line.
    expect(wrapLinesWith(measure10, 'aa bb cc', 60)).toEqual(['aa bb', 'cc'])
  })

  it('packs as many words as fit before breaking', () => {
    // 90px = 9 chars. "a a a a a" → "a a a a a" is 9 chars exactly, fits.
    expect(wrapLinesWith(measure10, 'a a a a a', 90)).toEqual(['a a a a a'])
    // 70px = 7 chars → "a a a a" (7) fits, trailing "a" wraps.
    expect(wrapLinesWith(measure10, 'a a a a a', 70)).toEqual(['a a a a', 'a'])
  })

  it('leaves an over-long single word alone (no mid-word break)', () => {
    // "supercalifragilistic" (20 chars = 200px) exceeds 50px but is not broken.
    expect(wrapLinesWith(measure10, 'supercalifragilistic', 50)).toEqual([
      'supercalifragilistic',
    ])
  })

  it('puts an over-long word on its own line after preceding words', () => {
    // 50px=5 chars. "hi" fits; the giant word can't share, goes alone; "ok" alone.
    expect(wrapLinesWith(measure10, 'hi enormouslylongword ok', 50)).toEqual([
      'hi',
      'enormouslylongword',
      'ok',
    ])
  })

  it('empty string yields a single empty line', () => {
    expect(wrapLinesWith(measure10, '', 100)).toEqual([''])
  })

  it('a blank paragraph between text is preserved as an empty line', () => {
    expect(wrapLinesWith(measure10, 'a\n\nb', 100)).toEqual(['a', '', 'b'])
  })

  it('collapses doubled interior spaces without forcing blank lines', () => {
    expect(wrapLinesWith(measure10, 'a  b', 100)).toEqual(['a b'])
  })
})

describe('blockLayout', () => {
  const base = {
    lines: ['one', 'two'],
    lineHeightPx: 100,
    frameH: 1000,
    padPx: 60,
    offsetYPx: 0,
  }

  it('top places the block padPx from the top', () => {
    const r = blockLayout({ ...base, vAlign: 'top' })
    expect(r.blockTop).toBe(60)
    // ascent = 0.8 * lineHeight = 80 → first baseline at blockTop + 80.
    expect(r.firstBaselineY).toBe(140)
  })

  it('bottom places the block padPx from the bottom', () => {
    const r = blockLayout({ ...base, vAlign: 'bottom' })
    // blockH = 2 lines * 100 = 200. blockTop = 1000 - 60 - 200 = 740.
    expect(r.blockTop).toBe(740)
    expect(r.blockH).toBe(200)
    expect(r.firstBaselineY).toBe(820)
  })

  it('middle centers the block vertically', () => {
    const r = blockLayout({ ...base, vAlign: 'middle' })
    // (1000 - 200) / 2 = 400.
    expect(r.blockTop).toBe(400)
    expect(r.firstBaselineY).toBe(480)
  })

  it('offsetYPx shifts the whole block down', () => {
    const r = blockLayout({ ...base, vAlign: 'top', offsetYPx: 25 })
    expect(r.blockTop).toBe(85)
    expect(r.firstBaselineY).toBe(165)
  })

  it('negative offsetYPx shifts the block up', () => {
    const r = blockLayout({ ...base, vAlign: 'middle', offsetYPx: -100 })
    expect(r.blockTop).toBe(300)
  })

  it('block height scales with line count', () => {
    const one = blockLayout({ ...base, lines: ['x'], vAlign: 'top' })
    const three = blockLayout({ ...base, lines: ['x', 'y', 'z'], vAlign: 'top' })
    expect(one.blockH).toBe(100)
    expect(three.blockH).toBe(300)
  })

  it('treats zero lines as one line for height', () => {
    const r = blockLayout({ ...base, lines: [], vAlign: 'top' })
    expect(r.blockH).toBe(100)
  })
})

// CA-13. A title could only be one colour, so the key word highlight cut its
// word out into a caption of its own. A lit word is now filled in its own
// colour, in a run laid exactly where the whole line would have put it.
describe('words in their own colour', () => {
  /** One pixel per character, so every x below can be counted by hand. */
  const measure = (s: string): number => s.length
  const lit = [{ at: 3, word: 'record', color: '#ff0' }]

  it('fills a lit word in its own colour, where the whole line put it', () => {
    // "i hit a record" is 14 wide, centred on 100: it starts at 93, "record" at 93 + 8.
    expect(colorRuns(['i hit a record'], lit, '#fff', measure, 100, 'center')).toEqual([
      [
        { text: 'i hit a', x: 93, color: '#fff' },
        { text: 'record', x: 101, color: '#ff0' },
      ],
    ])
  })

  it('counts the words across lines, and lays each line by its own width', () => {
    const runs = colorRuns(['i hit a new', 'record on bench'], [{ at: 4, word: 'record', color: '#ff0' }], '#fff', measure, 0, 'left')!
    expect(runs[0]).toEqual([{ text: 'i hit a new', x: 0, color: '#fff' }])
    expect(runs[1]).toEqual([
      { text: 'record', x: 0, color: '#ff0' },
      { text: 'on bench', x: 7, color: '#fff' },
    ])
  })

  it('draws the line whole when no word wears a colour, as every title did before', () => {
    expect(colorRuns(['i hit a record'], undefined, '#fff', measure, 100, 'center')).toBeNull()
    expect(colorRuns(['i hit a record'], [], '#fff', measure, 100, 'center')).toBeNull()
  })

  it('a retyped caption never lights a word he did not lean on', () => {
    // The word moved: it is found where it went, any case, any full stop.
    expect(wordColorsOn(['so', 'i', 'hit', 'a', 'RECORD.'], lit)).toEqual([null, null, null, null, '#ff0'])
    // The word is gone: nothing is lit, not whatever sits at its place now.
    expect(wordColorsOn(['i', 'hit', 'a', 'pr'], lit)).toEqual([null, null, null, null])
    // Twice in the caption: the one nearest where it was.
    expect(wordColorsOn(['record', 'a', 'b', 'record'], lit)).toEqual([null, null, null, '#ff0'])
  })
})
