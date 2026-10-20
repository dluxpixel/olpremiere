import { describe, expect, it } from 'vitest'
import { WORD_BOX_CAP_EM, WORD_BOX_EM, blockLayout, colorRuns, wordBoxRect, wordColorsOn, wrapLinesWith } from './titleRaster'

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
})
