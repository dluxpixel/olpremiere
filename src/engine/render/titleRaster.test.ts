import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, type TitleDef } from '../types'
import {
  WORD_BOX_CAP_EM,
  WORD_BOX_EM,
  blockLayout,
  clearTitleCache,
  colorRuns,
  inkOfIn,
  rasterizeTitle,
  wordBoxRect,
  wordColorsOn,
  wrapLinesWith,
} from './titleRaster'

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

  it('lights a word of no letters or digits, an emoji or punctuation, as itself', () => {
    const marks = [
      { at: 1, word: '\u{1F525}', color: '#f00' },
      { at: 2, word: '!!', color: '#0f0' },
    ]
    expect(wordColorsOn(['so', '\u{1F525}', '!!', 'now'], marks)).toEqual([null, '#f00', '#0f0', null])
    // A different mark is not it, and an empty word lights nothing.
    expect(wordColorsOn(['so', '??'], marks)).toEqual([null, null])
    expect(wordColorsOn(['so', 'now'], [{ at: 0, word: '', color: '#f00' }])).toEqual([null, null])
  })

  it('lights each emoji sequence as itself: a skin tone, a joined family, a flag, a heart, a keycap', () => {
    const sequences = [
      '\u{1F44D}\u{1F3FD}', // thumbs up, medium skin tone
      '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', // family of four, joined
      '\u{1F1E8}\u{1F1FF}', // flag of Czechia
      '❤\uFE0F', // red heart with its emoji selector
      '1\uFE0F\u20E3', // keycap one
    ]
    sequences.forEach((seq, i) => {
      // Against itself, among plain words: it is found and nothing else is.
      expect(wordColorsOn(['so', seq, 'now'], [{ at: 1, word: seq, color: '#f00' }])).toEqual([null, '#f00', null])
      // And among the other sequences, it lights its own place and no other one.
      const lit = wordColorsOn(sequences, [{ at: i, word: seq, color: '#f00' }])
      expect(lit).toEqual(sequences.map((_, j) => (j === i ? '#f00' : null)))
    })
  })

  it('takes a heart with and without its emoji or text selector as the same word', () => {
    const bare = '❤'
    for (const selector of ['\uFE0F', '\uFE0E']) {
      const dressed = bare + selector
      expect(wordColorsOn(['so', dressed, 'now'], [{ at: 1, word: bare, color: '#f00' }])).toEqual([null, '#f00', null])
      expect(wordColorsOn(['so', bare, 'now'], [{ at: 1, word: dressed, color: '#f00' }])).toEqual([null, '#f00', null])
    }
  })

  it('takes a keycap as its own word, never the digit it wraps', () => {
    const keycap = '1\uFE0F\u20E3'
    // A lit keycap does not light a plain 1, and a lit 1 does not light a keycap.
    expect(wordColorsOn(['1', keycap, '1'], [{ at: 1, word: keycap, color: '#f00' }])).toEqual([null, '#f00', null])
    expect(wordColorsOn(['1', keycap], [{ at: 0, word: '1', color: '#0f0' }])).toEqual(['#0f0', null])
    // Even when the word it was given to is gone, or sits nearer the other: it finds its own, or nothing.
    expect(wordColorsOn(['x', '1'], [{ at: 1, word: keycap, color: '#f00' }])).toEqual([null, null])
    expect(wordColorsOn(['x', keycap], [{ at: 1, word: '1', color: '#0f0' }])).toEqual([null, null])
    expect(wordColorsOn([keycap, '1'], [{ at: 0, word: '1', color: '#0f0' }])).toEqual([null, '#0f0'])
    expect(wordColorsOn([keycap, '1'], [{ at: 1, word: keycap, color: '#f00' }])).toEqual(['#f00', null])
    // The keycap with and without its emoji selector is the one keycap.
    expect(wordColorsOn(['x', '1\u20E3'], [{ at: 1, word: keycap, color: '#f00' }])).toEqual([null, '#f00'])
    // A keycap of another digit, or of the hash sign, is another word.
    expect(wordColorsOn([keycap, '2\uFE0F\u20E3', '#\uFE0F\u20E3'], [{ at: 2, word: '#\uFE0F\u20E3', color: '#f00' }])).toEqual([
      null,
      null,
      '#f00',
    ])
  })

  it('still matches a real word through its punctuation', () => {
    expect(wordColorsOn(['stay', 'AWAKE,'], [{ at: 1, word: 'awake', color: '#f00' }])).toEqual([null, '#f00'])
    expect(wordColorsOn(['stay', 'awake'], [{ at: 1, word: 'AWAKE,', color: '#f00' }])).toEqual([null, '#f00'])
  })
})

// His ask, 2026-10-19: a rounded box round the word being said, off a frame of a
// Short. The numbers below are that frame's table, counted in its em: with a cap
// height of 25 px (his frame) the em is 36 px, so every table entry times 36 is
// the px below.
describe('the word box', () => {
  /** Ten pixels per character, so every x can be counted by hand. */
  const m = measure10
  const CAP = 25
  const EM = CAP / WORD_BOX_CAP_EM
  const rect = (
    lines: string[],
    boxWord: { at: number; word: string },
    anchorX = 200,
    align: 'left' | 'center' | 'right' = 'center',
    cap = CAP,
  ) => wordBoxRect(lines, boxWord, m, anchorX, align, 100, 80, cap)

  it('is his frame in em: the cap is 25 px of a 36 px size', () => {
    expect(EM).toBeCloseTo(36, 9)
    const r = rect(['one two three'], { at: 1, word: 'two' })!
    expect(r.radius).toBeCloseTo(0.22 * 36, 9)
    expect(r.border).toBeCloseTo(0.11 * 36, 9)
    expect(r.edge).toBeCloseTo(0.05 * 36, 9)
    expect(WORD_BOX_EM.side).toBe(0.19)
  })

  it('goes round a centred word with the side margin each side', () => {
    // "one two three" is 130 wide, centred on 200: it starts at 135, "two" at 135 + 40.
    const r = rect(['one two three'], { at: 1, word: 'two' })!
    expect(r.x).toBeCloseTo(175 - 0.19 * 36, 9)
    expect(r.w).toBeCloseTo(30 + 2 * 0.19 * 36, 9)
  })

  it('sits from the top margin above the cap top to the bottom margin below the baseline', () => {
    const r = rect(['one two three'], { at: 1, word: 'two' })!
    expect(r.y).toBeCloseTo(100 - CAP - 0.29 * 36, 9)
    expect(r.h).toBeCloseTo(CAP + (0.29 + 0.18) * 36, 9)
  })

  it('goes round a left aligned word where the whole line puts it', () => {
    expect(rect(['one two three'], { at: 0, word: 'one' }, 50, 'left')!.x).toBeCloseTo(50 - 0.19 * 36, 9)
    expect(rect(['one two three'], { at: 2, word: 'three' }, 50, 'left')!.x).toBeCloseTo(50 + 80 - 0.19 * 36, 9)
  })

  it('goes round a right aligned word where the whole line puts it', () => {
    // 130 wide ending at 200: starts at 70, "three" at 70 + 80.
    expect(rect(['one two three'], { at: 2, word: 'three' }, 200, 'right')!.x).toBeCloseTo(150 - 0.19 * 36, 9)
  })

  it('finds a word on the second line, a line height further down', () => {
    const r = rect(['one two', 'three'], { at: 2, word: 'three' }, 0, 'left')!
    expect(r.x).toBeCloseTo(-0.19 * 36, 9)
    expect(r.y).toBeCloseTo(100 + 80 - CAP - 0.29 * 36, 9)
  })

  it('is null once the word is retyped away, never round whatever sits there now', () => {
    expect(rect(['one three'], { at: 1, word: 'two' })).toBeNull()
    expect(rect([''], { at: 0, word: 'two' })).toBeNull()
  })

  it('finds the word in any case and with its punctuation', () => {
    const r = rect(['Really?'], { at: 0, word: 'really' }, 0, 'left')
    expect(r).not.toBeNull()
    expect(r!.w).toBeCloseTo(70 + 2 * 0.19 * 36, 9)
  })

  it('picks the repeated word nearest where it was, the earlier one on a tie', () => {
    const lines = ['a b a']
    expect(rect(lines, { at: 0, word: 'a' }, 0, 'left')!.x).toBeCloseTo(-0.19 * 36, 9)
    expect(rect(lines, { at: 2, word: 'a' }, 0, 'left')!.x).toBeCloseTo(40 - 0.19 * 36, 9)
    expect(rect(lines, { at: 1, word: 'a' }, 0, 'left')!.x).toBeCloseTo(-0.19 * 36, 9)
  })

  it('measures the side margin from the glyph edge when it is told where the ink is', () => {
    const ink = () => ({ left: 2, right: 28 })
    const r = wordBoxRect(['one two three'], { at: 1, word: 'two' }, m, 200, 'center', 100, 80, CAP, ink)!
    expect(r.x).toBeCloseTo(175 + 2 - 0.19 * 36, 9)
    expect(r.w).toBeCloseTo(26 + 2 * 0.19 * 36, 9)
  })

  it('measures the bottom margin from the glyph edge, so a g or a y stays inside the box', () => {
    const plain = wordBoxRect(['one going'], { at: 1, word: 'going' }, m, 0, 'left', 100, 80, CAP, () => ({ left: 0, right: 50 }))!
    const none = wordBoxRect(['one going'], { at: 1, word: 'going' }, m, 0, 'left', 100, 80, CAP, () => ({
      left: 0,
      right: 50,
      descent: 0,
    }))!
    const deep = wordBoxRect(['one going'], { at: 1, word: 'going' }, m, 0, 'left', 100, 80, CAP, () => ({
      left: 0,
      right: 50,
      descent: 19,
    }))!
    // No descent: the box is exactly what it was, the bottom margin under the baseline.
    expect(plain.h).toBeCloseTo(CAP + (0.29 + 0.18) * 36, 9)
    expect(none).toEqual(plain)
    // A descent: the box grows down by exactly that much, and the top stays put.
    expect(deep.h - plain.h).toBeCloseTo(19, 9)
    expect(deep.y).toBe(plain.y)
  })

  it('measures the top margin from the ink of a letter taller than the caps, so a Czech accent stays inside', () => {
    const at = (ascent?: number) =>
      wordBoxRect(['one ČESKÝ'], { at: 1, word: 'český' }, m, 0, 'left', 100, 80, CAP, () => ({
        left: 0,
        right: 50,
        ...(ascent === undefined ? {} : { ascent }),
      }))!
    const plain = at()
    // At or under the cap height: the box is exactly what it was, the top margin above the cap top.
    expect(plain.y).toBeCloseTo(100 - CAP - 0.29 * 36, 9)
    expect(at(CAP)).toEqual(plain)
    expect(at(CAP - 10)).toEqual(plain)
    expect(at(0)).toEqual(plain)
    // Taller than the caps: the top rises by exactly the excess, and the bottom stays put.
    const tall = at(CAP + 8)
    expect(plain.y - tall.y).toBeCloseTo(8, 9)
    expect(tall.h - plain.h).toBeCloseTo(8, 9)
    expect(tall.y + tall.h).toBeCloseTo(plain.y + plain.h, 9)
  })

  it('counts words across a non breaking space the way wordPop.ts does', () => {
    // wordPop.ts splits on any white space, so "one", "two", "three" are words 0, 1, 2.
    const lines = ['one\u00A0two three']
    expect(rect(lines, { at: 1, word: 'two' }, 0, 'left')!.x).toBeCloseTo(40 - 0.19 * 36, 9)
    expect(rect(lines, { at: 2, word: 'three' }, 0, 'left')!.x).toBeCloseTo(80 - 0.19 * 36, 9)
    // A lit colour counts the same way, so it lands on the word the box goes round.
    const runs = colorRuns(lines, [{ at: 1, word: 'two', color: '#f00' }], '#fff', m, 0, 'left')!
    expect(runs[0]!.map((r) => r.color)).toEqual(['#fff', '#f00', '#fff'])
  })

  it('grows with the cap height and with nothing else', () => {
    const a = rect(['one two three'], { at: 1, word: 'two' }, 0, 'left', 25)!
    const b = rect(['one two three'], { at: 1, word: 'two' }, 0, 'left', 50)!
    expect(b.radius).toBeCloseTo(a.radius * 2, 9)
    expect(b.border).toBeCloseTo(a.border * 2, 9)
    // The margins double; the word does not.
    expect(b.w - 30).toBeCloseTo((a.w - 30) * 2, 9)
  })

  it('is null for a cap height that is not a size, and for a blank word', () => {
    expect(rect(['one two'], { at: 0, word: 'one' }, 0, 'left', 0)).toBeNull()
    expect(rect(['one two'], { at: 0, word: 'one' }, 0, 'left', Number.NaN)).toBeNull()
    expect(rect(['one two'], { at: 0, word: '...' })).toBeNull()
  })

  it('is an overlay: the box for the next word sits exactly one word further along the line', () => {
    // The box is worked out from the line, so the line never has to make room for it.
    const two = rect(['one two three'], { at: 1, word: 'two' })!
    const three = rect(['one two three'], { at: 2, word: 'three' })!
    expect(three.x - two.x).toBeCloseTo(40, 9)
  })

  it('goes round an emoji by its ink, with the side margin each side', () => {
    // "so 🔥 now": the fire is 2 UTF-16 units, so 20 px here, and starts at 30 px. Its ink is told by the meter.
    const ink = vi.fn((word: string) => (word === '\u{1F525}' ? { left: 3, right: 17 } : { left: 0, right: 99 }))
    const r = wordBoxRect(['so \u{1F525} now'], { at: 1, word: '\u{1F525}' }, m, 0, 'left', 100, 80, CAP, ink)!
    expect(ink).toHaveBeenCalledWith('\u{1F525}')
    expect(r.x).toBeCloseTo(30 + 3 - WORD_BOX_EM.side * EM, 9)
    expect(r.w).toBeCloseTo(14 + 2 * WORD_BOX_EM.side * EM, 9)
    // The box is the caps' height, as for any word.
    expect(r.y).toBeCloseTo(100 - CAP - WORD_BOX_EM.top * EM, 9)
  })

  it('goes round "!!" by its ink, with the side margin each side', () => {
    const ink = (word: string) => (word === '!!' ? { left: 2, right: 11 } : { left: 0, right: 99 })
    const r = wordBoxRect(['so !! now'], { at: 1, word: '!!' }, m, 0, 'left', 100, 80, CAP, ink)!
    expect(r.x).toBeCloseTo(30 + 2 - WORD_BOX_EM.side * EM, 9)
    expect(r.w).toBeCloseTo(9 + 2 * WORD_BOX_EM.side * EM, 9)
  })

  it('goes round an emoji by its advance when no ink is told', () => {
    const r = wordBoxRect(['so \u{1F525} now'], { at: 1, word: '\u{1F525}' }, m, 0, 'left', 100, 80, CAP)!
    expect(r.x).toBeCloseTo(30 - WORD_BOX_EM.side * EM, 9)
    expect(r.w).toBeCloseTo(20 + 2 * WORD_BOX_EM.side * EM, 9)
  })
})

describe('where a word ink sits (inkOfIn)', () => {
  /** A measure with the numbers a canvas would give; any field left out is not reported. */
  const meter = (m: Partial<Record<keyof TextMetrics, number>>) => ({ measureText: () => m as TextMetrics })

  it('reads the glyph edges, the left as a distance from the origin, with the reach above and below', () => {
    const ink = inkOfIn(
      meter({ width: 40, actualBoundingBoxLeft: -3, actualBoundingBoxRight: 36, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 7 }),
      'Hello',
    )
    expect(ink).toEqual({ left: 3, right: 36, ascent: 30, descent: 7 })
  })

  it('falls back to the advance where the canvas reports no ink at all', () => {
    expect(inkOfIn(meter({ width: 40 }), 'Hello')).toEqual({ left: 0, right: 40 })
    expect(inkOfIn(meter({ width: 40, actualBoundingBoxLeft: Number.NaN, actualBoundingBoxRight: 30 }), 'Hello')).toEqual({
      left: 0,
      right: 40,
    })
  })

  it('leaves out an ascent or descent that is not a number', () => {
    const ink = inkOfIn(meter({ width: 40, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 40, actualBoundingBoxAscent: Number.NaN }), 'Hello')
    expect(ink).toEqual({ left: -0, right: 40 })
    expect('ascent' in ink).toBe(false)
    expect('descent' in ink).toBe(false)
  })

  it('takes an emoji whose reported ink is a sliver as its whole advance, keeping the vertical reach', () => {
    const sliver = meter({
      width: 40,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 3,
      actualBoundingBoxAscent: 28,
      actualBoundingBoxDescent: 4,
    })
    expect(inkOfIn(sliver, '\u{1F525}')).toEqual({ left: 0, right: 40, ascent: 28, descent: 4 })
    // A keycap holds a digit (or # or *) but is an emoji all the same: it is widened too.
    expect(inkOfIn(sliver, '1\uFE0F\u20E3')).toEqual({ left: 0, right: 40, ascent: 28, descent: 4 })
    expect(inkOfIn(sliver, '7\u20E3')).toEqual({ left: 0, right: 40, ascent: 28, descent: 4 })
    // Nothing at all reported (a box of no width) is the same.
    const empty = meter({ width: 40, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 })
    expect(inkOfIn(empty, '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}')).toEqual({ left: 0, right: 40, ascent: 0, descent: 0 })
  })

  it('keeps the ink of an emoji whose bounds are sane, and of "!!" (a tight ink on a short mark)', () => {
    const sane = meter({ width: 40, actualBoundingBoxLeft: -2, actualBoundingBoxRight: 37, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 3 })
    expect(inkOfIn(sane, '\u{1F525}')).toEqual({ left: 2, right: 37, ascent: 30, descent: 3 })
    // "!!": 24 wide, the marks themselves 18 of it: well over 0.3 of the advance.
    const bangs = meter({ width: 24, actualBoundingBoxLeft: -3, actualBoundingBoxRight: 21, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 0 })
    expect(inkOfIn(bangs, '!!')).toEqual({ left: 3, right: 21, ascent: 30, descent: 0 })
    // Just over the line is kept, just under is not.
    expect(inkOfIn(meter({ width: 100, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 31 }), '!!')).toEqual({ left: -0, right: 31 })
    expect(inkOfIn(meter({ width: 100, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 29 }), '!!')).toEqual({ left: 0, right: 100 })
  })

  it('never widens a word with a letter or a digit, however thin its ink', () => {
    const thin = meter({ width: 40, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 3, actualBoundingBoxAscent: 28, actualBoundingBoxDescent: 0 })
    for (const word of ['I', 'l1', 'Č', 'x\u{1F525}', '7']) {
      expect(inkOfIn(thin, word)).toEqual({ left: -0, right: 3, ascent: 28, descent: 0 })
    }
  })
})

// The popping word is drawn grown, about its own centre, and where it grows over a
// neighbour it must not cover the neighbour's letters: the box goes down under
// every word, the grown letters over them. A fake canvas that writes down what it
// is asked to draw, in order, with the size it is drawn at, reads that off.
describe('the order a popping word is drawn in', () => {
  const BOX = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }
  const POPPED = '#A3FF12'

  interface Drawn {
    op: 'fillText' | 'strokeText' | 'box'
    text: string
    x: number
    y: number
    /** The box's width and height (0 for text), read off its path, where `x` and `y` are the box's corner. */
    w: number
    h: number
    /** How much bigger than the plain title this was drawn. */
    k: number
    /** Where the transform sends the origin: a point p is drawn at k * p + (tx, ty). */
    tx: number
    ty: number
    fillStyle: string
    strokeStyle: string
    shadowBlur: number
  }

  let drawn: Drawn[] = []

  /** A 2D context that records the text and the word box it is asked to draw. Ten px a character. */
  function fakeContext(): unknown {
    // The transform is only ever translate and uniform scale, so it is a size k and a shift (tx, ty).
    let k = 1
    let tx = 0
    let ty = 0
    const stack: { k: number; tx: number; ty: number }[] = []
    // The corners of the path being built, so the box's rectangle can be read off when it is filled.
    let path: { x: number; y: number }[] = []
    const note = (op: Drawn['op'], text: string, x: number, y: number, w = 0, h = 0): void =>
      void drawn.push({ op, text, x, y, w, h, k, tx, ty, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, shadowBlur: ctx.shadowBlur })
    const ctx = {
      font: '',
      textAlign: 'center',
      textBaseline: 'alphabetic',
      fillStyle: '' as string,
      strokeStyle: '' as string,
      lineWidth: 0,
      lineCap: 'round',
      lineJoin: 'round',
      shadowBlur: 0,
      shadowColor: '',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      measureText: (s: string) => ({
        width: s.length * 10,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: s.length * 10,
        actualBoundingBoxAscent: 28,
        actualBoundingBoxDescent: s === 'H' ? 0 : 6,
      }),
      save: () => void stack.push({ k, tx, ty }),
      restore: () => {
        const top = stack.pop() ?? { k: 1, tx: 0, ty: 0 }
        k = top.k
        tx = top.tx
        ty = top.ty
      },
      // Moves the origin by (dx, dy) in the current, already scaled, units.
      translate: (dx: number, dy: number) => {
        tx += k * dx
        ty += k * dy
      },
      scale: (sx: number) => void (k *= sx),
      beginPath: () => void (path = []),
      closePath: () => undefined,
      moveTo: (x: number, y: number) => void path.push({ x, y }),
      arcTo: (x1: number, y1: number) => void path.push({ x: x1, y: y1 }),
      stroke: () => undefined,
      // The only filled path in these titles is the word box: its rectangle is the bounds of its corners.
      fill: () => {
        const xs = path.map((p) => p.x)
        const ys = path.map((p) => p.y)
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        note('box', '', x, y, Math.max(...xs) - x, Math.max(...ys) - y)
      },
      fillText: (text: string, x: number, y: number) => note('fillText', text, x, y),
      strokeText: (text: string, x: number, y: number) => note('strokeText', text, x, y),
    }
    return ctx
  }

  class FakeCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(): unknown {
      return fakeContext()
    }
  }

  beforeEach(() => {
    drawn = []
    clearTitleCache()
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearTitleCache()
  })

  /** "one two three" on a canvas wide enough to leave the pop room, 'two' lit, boxed and (by `scale`) popped. */
  const titleFor = (scale: number, over: Partial<TitleDef> = {}): TitleDef => ({
    ...defaultTitleDef('one two three'),
    fontSizePx: 40,
    outline: { color: '#000000', widthPx: 6 },
    shadow: { color: 'rgba(0,0,0,0.5)', blurPx: 6, dx: 3, dy: 3 },
    wordColors: [{ at: 1, word: 'two', color: POPPED }],
    wordBox: BOX,
    boxWord: { at: 1, word: 'two' },
    wordPopSize: 1.15,
    popWord: { at: 1, word: 'two', scale },
    ...over,
  })

  const draw = (def: TitleDef): Drawn[] => {
    drawn = []
    rasterizeTitle(def, 800, 400)
    return drawn
  }
  const ofWord = (calls: Drawn[], text: string): Drawn[] => calls.filter((c) => c.op !== 'box' && c.text === text)
  const strip = (calls: Drawn[]): Omit<Drawn, never>[] => calls.map((c) => ({ ...c }))

  it('draws the neighbours of a popping word exactly as it draws them when nothing pops', () => {
    const still = draw(titleFor(1))
    const popping = draw(titleFor(1.15))
    for (const word of ['one', 'three']) {
      const before = ofWord(still, word)
      expect(before.length, `${word} is drawn on the plain frame`).toBeGreaterThan(0)
      expect(strip(ofWord(popping, word))).toEqual(strip(before))
      for (const c of before) expect(c.k).toBe(1)
    }
  })

  it('puts the popping word box down first, then the other words, then the popping letters last', () => {
    const calls = draw(titleFor(1.15))
    const boxAt = calls.findIndex((c) => c.op === 'box')
    const indexesOf = (word: string): number[] => calls.flatMap((c, i) => (c.op !== 'box' && c.text === word ? [i] : []))
    const others = [...indexesOf('one'), ...indexesOf('three')]
    const two = indexesOf('two')
    expect(boxAt).toBeGreaterThanOrEqual(0)
    expect(calls.filter((c) => c.op === 'box')).toHaveLength(1)
    // The box is under every other word, the grown letters are over every one.
    expect(boxAt).toBeLessThan(Math.min(...others))
    expect(Math.max(...others)).toBeLessThan(Math.min(...two))
    // Outline, then fill, and the fill is the very last thing drawn.
    expect(calls.slice(-2).map((c) => [c.op, c.text])).toEqual([
      ['strokeText', 'two'],
      ['fillText', 'two'],
    ])
    expect(calls[calls.length - 1]!.fillStyle).toBe(POPPED)
  })

  it('grows the box and the letters about the same size, the shadow with them, and no other word at all', () => {
    const calls = draw(titleFor(1.15))
    const box = calls.find((c) => c.op === 'box')!
    const [outline, fill] = ofWord(calls, 'two')
    expect(box.k).toBeGreaterThan(1)
    expect(box.k).toBeLessThanOrEqual(1.15 + 1e-9)
    expect(outline!.k).toBe(box.k)
    expect(fill!.k).toBe(box.k)
    // The shadow is scaled by hand (a canvas shadow ignores the transform): the outline casts it.
    expect(outline!.shadowBlur).toBeCloseTo(6 * box.k, 9)
    expect(fill!.shadowBlur).toBe(0)
    // The other words cast theirs at the plain size.
    const oneOutline = ofWord(calls, 'one').find((c) => c.op === 'strokeText')!
    expect(oneOutline.shadowBlur).toBe(6)
    for (const c of [...ofWord(calls, 'one'), ...ofWord(calls, 'three')]) expect(c.k).toBe(1)
  })

  it('grows the box and the letters about one centre: the middle of the word, and of its box up and down', () => {
    const calls = draw(titleFor(1.15))
    const box = calls.find((c) => c.op === 'box')!
    const [outline, fill] = ofWord(calls, 'two')
    expect(box.k).toBeGreaterThan(1)
    // A point p is drawn at k * p + t, so the one point that stays where it was is t / (1 - k).
    const centreOf = (c: Drawn): { x: number; y: number } => ({ x: c.tx / (1 - c.k), y: c.ty / (1 - c.k) })
    const about = centreOf(box)
    for (const c of [outline!, fill!]) {
      expect(centreOf(c).x).toBeCloseTo(about.x, 9)
      expect(centreOf(c).y).toBeCloseTo(about.y, 9)
    }
    // Up and down it is the middle of the box. Across it is the middle of the word's ink ("two" is 30 wide).
    expect(about.y).toBeCloseTo(box.y + box.h / 2, 9)
    expect(about.x).toBeCloseTo(fill!.x + 15, 9)
    // Every other word is drawn where the plain title draws it: no shift at all.
    for (const c of [...ofWord(calls, 'one'), ...ofWord(calls, 'three')]) {
      expect(c.tx).toBe(0)
      expect(c.ty).toBe(0)
    }
  })

  it('holds the grown box back to the canvas, as the letters are', () => {
    // "three" ends a line that nearly fills a 160 px canvas, so it has no room to swell the whole 15
    // percent: its shadow would run off the right edge. The box is held to the same smaller size.
    const last = { wordColors: [{ at: 2, word: 'three', color: POPPED }], boxWord: { at: 2, word: 'three' } }
    drawn = []
    rasterizeTitle(titleFor(1.15, { ...last, popWord: { at: 2, word: 'three', scale: 1.15 } }), 160, 400)
    const calls = drawn
    const box = calls.find((c) => c.op === 'box')!
    expect(box.k).toBeGreaterThan(1)
    expect(box.k).toBeLessThan(1.15)
    expect(ofWord(calls, 'three')[0]!.k).toBe(box.k)
    expect(ofWord(calls, 'three')[1]!.k).toBe(box.k)
  })

  it('draws the box under everything when nothing pops, as it always was', () => {
    const calls = draw(titleFor(1))
    expect(calls.findIndex((c) => c.op === 'box')).toBe(0)
    expect(calls.filter((c) => c.op === 'box')).toHaveLength(1)
    expect(calls.find((c) => c.op === 'box')!.k).toBe(1)
    // All three words, in line order, outline then fill: two draws each.
    expect(calls.filter((c) => c.op === 'fillText').map((c) => c.text)).toEqual(['one', 'two', 'three'])
  })

  it('still draws the popping letters last with no box at all', () => {
    const calls = draw(titleFor(1.15, { wordBox: undefined, boxWord: undefined }))
    expect(calls.some((c) => c.op === 'box')).toBe(false)
    expect(calls.slice(-2).map((c) => [c.op, c.text])).toEqual([
      ['strokeText', 'two'],
      ['fillText', 'two'],
    ])
    expect(calls[calls.length - 1]!.k).toBeGreaterThan(1)
  })

  it('draws a box that sits round a word that is not the popping one behind the text, at the plain size', () => {
    const calls = draw(titleFor(1.15, { boxWord: { at: 0, word: 'one' } }))
    const box = calls.findIndex((c) => c.op === 'box')
    expect(box).toBe(0)
    expect(calls[box]!.k).toBe(1)
    expect(calls[calls.length - 1]!.text).toBe('two')
  })
})
