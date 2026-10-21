// The forced aligner's maths on made-up emission tables, where the right
// answer is known to the frame. The model is not here; alignRunner.ts owns it.

import { describe, expect, it } from 'vitest'
import {
  END_TAIL_S,
  FRAME_S,
  ONSET_BIAS_S,
  STAR,
  alignWords,
  alignmentWindows,
  extendAlignedEnds,
  forcedAlign,
  isSilentText,
  makeAlignVocab,
  vocabTokens,
  type AlignInput,
  type AlignedWord,
  type RoughWord,
} from './ctcAlign'

// A toy vocabulary: 0 is the blank, 1..6 are a..f, 7 is the delimiter.
const V = 8
const vocab = makeAlignVocab({ '<pad>': 0, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, '|': 7 }, '<pad>')

/** A peaky CTC table: blank nearly everywhere, a letter at each spike frame. */
function table(T: number, spikes: Record<number, number>): Float32Array {
  const lp = new Float32Array(T * V)
  for (let t = 0; t < T; t++) {
    const p = new Array<number>(V).fill(0.01)
    const spike = spikes[t]
    if (spike === undefined) p[0] = 0.9
    else {
      p[spike] = 0.9
      p[0] = 0.02
    }
    const sum = p.reduce((a, b) => a + b, 0)
    for (let v = 0; v < V; v++) lp[t * V + v] = Math.log(p[v] / sum)
  }
  return lp
}

describe('forcedAlign', () => {
  it('recovers known spans exactly', () => {
    const lp = table(20, { 5: 1, 9: 2, 14: 3 })
    const path = forcedAlign(lp, 20, V, [1, 2, 3], 0)!
    expect(path.spans).toEqual([
      { start: 5, end: 6 },
      { start: 9, end: 10 },
      { start: 14, end: 15 },
    ])
    expect(path.scores.every((s) => s > -0.2)).toBe(true)
  })

  it('keeps a doubled letter apart with the blank between', () => {
    // "ll": the model says it with a blank frame between the two.
    const apart = forcedAlign(table(12, { 4: 1, 6: 1 }), 12, V, [1, 1], 0)!
    expect(apart.spans).toEqual([
      { start: 4, end: 5 },
      { start: 6, end: 7 },
    ])
    // Two spikes with no blank frame between them cannot be two letters on
    // the same frame run: the path has to spend a frame on the blank.
    const glued = forcedAlign(table(12, { 4: 1, 5: 1 }), 12, V, [1, 1], 0)!
    expect(glued.spans[1].start).toBeGreaterThanOrEqual(glued.spans[0].end + 1)
  })

  it('lets two different letters sit on neighbouring frames', () => {
    const path = forcedAlign(table(12, { 4: 1, 5: 2 }), 12, V, [1, 2], 0)!
    expect(path.spans).toEqual([
      { start: 4, end: 5 },
      { start: 5, end: 6 },
    ])
  })

  it('has no path when there are fewer frames than letters', () => {
    expect(forcedAlign(table(2, {}), 2, V, [1, 2, 3], 0)).toBeNull()
    // "aa" needs three frames at least: a, blank, a.
    expect(forcedAlign(table(2, {}), 2, V, [1, 1], 0)).toBeNull()
  })

  it('has nothing to do for no tokens or no frames', () => {
    expect(forcedAlign(table(10, {}), 10, V, [], 0)).toBeNull()
    expect(forcedAlign(new Float32Array(0), 0, V, [1], 0)).toBeNull()
  })

  it('lets a star take the stretch of speech that has no spelling', () => {
    // a, then something said aloud (spikes of "e" and "f" the text does not
    // have) over frames 10 to 18, then d.
    const spikes = { 3: 1, 6: 7, 10: 5, 12: 6, 14: 5, 16: 6, 18: 5, 21: 7, 24: 4 }
    const path = forcedAlign(table(30, spikes), 30, V, [1, 7, STAR, 7, 4], 0)!
    expect(path.spans[0]).toEqual({ start: 3, end: 4 })
    expect(path.spans[1].start).toBe(6)
    // The star starts at the first sound and runs to the last.
    expect(path.spans[2].start).toBe(10)
    expect(path.spans[2].end).toBe(19)
    expect(path.spans[4]).toEqual({ start: 24, end: 25 })
    expect(Number.isNaN(path.scores[2])).toBe(true)
  })

  it('refuses a table too big to hold', () => {
    // 20000 frames by 4001 states is 80 million bytes of backpointers.
    const tokens = new Array<number>(2000).fill(1).map((_, i) => (i % 2 === 0 ? 1 : 2))
    expect(forcedAlign(new Float32Array(20000 * V), 20000, V, tokens, 0)).toBeNull()
  })
})

describe('vocabTokens', () => {
  const english = makeAlignVocab({ '<pad>': 0, '|': 4, "'": 27, E: 5, T: 6, A: 7, D: 8, O: 9, N: 10, I: 11 }, '<pad>')
  const czech = makeAlignVocab({ '[PAD]': 9910, '|': 9908, a: 1, b: 2, c: 3, č: 4, e: 5, A: 6, z: 7, ž: 8, D: 9 }, '[PAD]')
  const spell = (w: string, v = english) => vocabTokens(w, v)

  it('follows the case of the vocabulary', () => {
    expect(english.fold).toBe('upper')
    expect(czech.fold).toBe('lower')
    expect(spell('Dan')).toEqual(spell('DAN'))
    expect(vocabTokens('Zaza', czech)).toEqual([7, 1, 7, 1])
  })

  it('strips punctuation and maps typographic apostrophes', () => {
    expect(spell('"Dan,"')).toEqual(spell('DAN'))
    expect(spell('don’t')).toEqual(spell("don't"))
    expect(spell("don't")).toContain(27)
    // A vocabulary with no apostrophe just spells it without.
    expect(vocabTokens("a'b", czech)).toEqual([1, 2])
  })

  it('has no spelling for digits, symbols and emoji', () => {
    expect(spell('2026')).toBeNull()
    expect(spell('$49.99')).toBeNull()
    expect(spell('mp3')).toBeNull()
    expect(spell('\u{1F600}')).toBeNull()
    expect(spell('...')).toBeNull()
  })

  it('keeps an accent the vocabulary has and reduces one it does not', () => {
    expect(vocabTokens('čez', czech)).toEqual([4, 5, 7])
    // "é" is not in the English table: its base letter stands in.
    expect(spell('été')).toEqual(spell('ete'))
  })

  it('tells a chunk with nothing to say aloud', () => {
    expect(isSilentText('-')).toBe(true)
    expect(isSilentText('?!')).toBe(true)
    expect(isSilentText('2026')).toBe(false)
    expect(isSilentText('hi')).toBe(false)
  })
})

describe('alignWords', () => {
  const rough = (text: string, startS: number, endS: number): AlignInput => ({ text, startS, endS })

  // abc | def : spikes a@10 b@14 c@18, |@22, d@26 e@30 f@34, in a window that
  // starts at 100 s.
  const spikes = { 10: 1, 14: 2, 18: 3, 22: 7, 26: 4, 30: 5, 34: 6 }
  const emissions = { logProbs: table(50, spikes), T: 50, V }

  it('times each word from its first and last letter', () => {
    const r = alignWords([rough('abc', 100.3, 100.6), rough('def', 100.6, 100.9)], emissions, FRAME_S, 100, vocab, { biasS: 0 })
    expect(r.words.map((w) => w.aligned)).toEqual([true, true])
    expect(r.words[0].startS).toBeCloseTo(100 + 10 * FRAME_S, 6)
    expect(r.words[0].endS).toBeCloseTo(100 + 19 * FRAME_S, 6)
    expect(r.words[1].startS).toBeCloseTo(100 + 26 * FRAME_S, 6)
    expect(r.words[1].endS).toBeCloseTo(100 + 35 * FRAME_S, 6)
    expect(r.meanLogProb).toBeGreaterThan(-0.2)
  })

  it('applies the measured onset bias unless told otherwise', () => {
    const r = alignWords([rough('abc', 100.3, 100.6), rough('def', 100.6, 100.9)], emissions, FRAME_S, 100, vocab)
    expect(ONSET_BIAS_S).toBeLessThan(0)
    expect(r.words[0].startS).toBeCloseTo(100 + 10 * FRAME_S + ONSET_BIAS_S, 6)
    expect(r.words[0].endS).toBeCloseTo(100 + 19 * FRAME_S + ONSET_BIAS_S, 6)
  })

  it('adds the onset bias it is given', () => {
    const r = alignWords([rough('abc', 100.3, 100.6), rough('def', 100.6, 100.9)], emissions, FRAME_S, 100, vocab, { biasS: -0.01 })
    expect(r.words[0].startS).toBeCloseTo(100 + 10 * FRAME_S - 0.01, 6)
  })

  it('gives a number the stretch of speech between its neighbours', () => {
    // abc, a number said aloud as e..f..e..f (frames 26 to 38), then def.
    const s = { 10: 1, 14: 2, 18: 3, 22: 7, 26: 5, 30: 6, 34: 5, 38: 6, 42: 7, 46: 4, 50: 5, 54: 6 }
    const e = { logProbs: table(64, s), T: 64, V }
    const r = alignWords([rough('abc', 100.3, 100.6), rough('2026', 100.6, 101), rough('def', 101, 101.2)], e, FRAME_S, 100, vocab, { biasS: 0 })
    expect(r.words.map((w) => w.aligned)).toEqual([true, true, true])
    expect(r.words[1].startS).toBeCloseTo(100 + 26 * FRAME_S, 6)
    expect(r.words[1].endS).toBeCloseTo(100 + 39 * FRAME_S, 6)
    expect(r.words[2].startS).toBeCloseTo(100 + 46 * FRAME_S, 6)
  })

  it('keeps the recogniser time of a word that moved more than a second', () => {
    const r = alignWords([rough('abc', 100.3, 100.6), rough('def', 102, 102.3)], emissions, FRAME_S, 100, vocab)
    expect(r.words[0].aligned).toBe(true)
    expect(r.words[1]).toEqual({ startS: 102, endS: 102.3, aligned: false })
  })

  it('keeps every time when the words were not the audio', () => {
    // The table spells abc, the text says fed: the letters score far below the floor.
    const words = [rough('fed', 100.3, 100.6), rough('cab', 100.6, 100.9)]
    const r = alignWords(words, emissions, FRAME_S, 100, vocab)
    expect(r.words).toEqual(words.map((w) => ({ startS: w.startS, endS: w.endS, aligned: false })))
    expect(r.meanLogProb).toBeLessThan(-3)
  })

  it('leaves a chunk of punctuation at its time and aligns around it', () => {
    const r = alignWords([rough('abc', 100.3, 100.6), rough('-', 100.4, 100.42), rough('def', 100.6, 100.9)], emissions, FRAME_S, 100, vocab)
    expect(r.words[1]).toEqual({ startS: 100.4, endS: 100.42, aligned: false })
    expect(r.words.map((w) => w.aligned)).toEqual([true, false, true])
  })

  it('does not let an unaligned word run over the aligned one after it', () => {
    const r = alignWords([rough('abc', 100.3, 100.6), rough('-', 100.5, 100.9), rough('def', 100.6, 100.9)], emissions, FRAME_S, 100, vocab)
    expect(r.words[1].endS).toBeLessThanOrEqual(r.words[2].startS)
  })

  it('has nothing to say for no words, only punctuation, or too few frames', () => {
    expect(alignWords([], emissions, FRAME_S, 100, vocab)).toEqual({ words: [], meanLogProb: null })
    const dash = [rough('-', 1, 1.1)]
    expect(alignWords(dash, emissions, FRAME_S, 100, vocab).words).toEqual([{ startS: 1, endS: 1.1, aligned: false }])
    const tiny = { logProbs: table(3, {}), T: 3, V }
    expect(alignWords([rough('abc', 100.3, 100.6)], tiny, FRAME_S, 100, vocab).words[0].aligned).toBe(false)
  })
})

describe('alignmentWindows', () => {
  /** n words spaced `step` apart, each `len` long, with a long pause every `every` words. */
  function words(n: number, step: number, len: number, every = 0, pause = 0): RoughWord[] {
    const out: RoughWord[] = []
    let t = 0.5
    for (let i = 0; i < n; i++) {
      out.push({ startS: t, endS: t + len })
      t += step + (every > 0 && (i + 1) % every === 0 ? pause : 0)
    }
    return out
  }

  it('has no windows for no words', () => {
    expect(alignmentWindows([], 10)).toEqual([])
  })

  it('puts every word in exactly one window, in order', () => {
    const w = words(500, 0.45, 0.3, 17, 0.8)
    const dur = w[w.length - 1].endS + 1
    const wins = alignmentWindows(w, dur)
    let next = 0
    for (const win of wins) {
      expect(win.first).toBe(next)
      expect(win.end).toBeGreaterThan(win.first)
      next = win.end
    }
    expect(next).toBe(500)
  })

  it('keeps each window to 20 s with its padding, inside the recording', () => {
    const w = words(500, 0.45, 0.3, 17, 0.8)
    const dur = w[w.length - 1].endS + 1
    for (const win of alignmentWindows(w, dur)) {
      expect(win.toS - win.fromS).toBeLessThanOrEqual(20 + 1e-9)
      expect(win.fromS).toBeGreaterThanOrEqual(0)
      expect(win.toS).toBeLessThanOrEqual(dur + 1e-9)
    }
  })

  it('cuts at the biggest pause it can reach', () => {
    // 12 s of words, a 2 s pause, then 14 s of words: the first window could
    // run on into the second group, but the pause is where it ends.
    const a = words(40, 0.3, 0.25)
    const b = words(40, 0.35, 0.3).map((x) => ({ startS: x.startS + 14, endS: x.endS + 14 }))
    const wins = alignmentWindows([...a, ...b], 30)
    expect(wins.map((w) => [w.first, w.end])).toEqual([
      [0, 40],
      [40, 80],
    ])
  })

  it('never cuts a window under half full just to reach a pause', () => {
    // A pause after 3 s would leave a nearly empty first window; the cut waits for a later gap.
    const a = words(10, 0.3, 0.25)
    const b = words(60, 0.35, 0.3).map((x) => ({ startS: x.startS + 5, endS: x.endS + 5 }))
    const wins = alignmentWindows([...a, ...b], 40)
    expect(wins[0].end).toBeGreaterThan(10)
  })

  it('pads one second each side and clamps to the recording', () => {
    const wins = alignmentWindows([{ startS: 0.4, endS: 0.8 }, { startS: 1, endS: 1.4 }], 1.9)
    expect(wins).toEqual([{ first: 0, end: 2, fromS: 0, toS: 1.9 }])
  })

  it('copes with times that overlap or run backwards', () => {
    const wins = alignmentWindows(
      [
        { startS: 2, endS: 2.5 },
        { startS: 1.9, endS: 2.0 },
        { startS: 2.4, endS: 2.2 },
      ],
      10,
    )
    expect(wins.length).toBe(1)
    expect(wins[0].end).toBe(3)
  })

  it('stays within a window of memory for an hour of speech', () => {
    // 8000 words over an hour: the largest table is one window, never the hour.
    const w = words(8000, 0.45, 0.3, 17, 0.8)
    const dur = w[w.length - 1].endS + 1
    const wins = alignmentWindows(w, dur)
    const longest = Math.max(...wins.map((x) => x.toS - x.fromS))
    expect(longest).toBeLessThanOrEqual(20 + 1e-9)
    // A 20 s window at 50 frames a second with its longest run of letters:
    const frames = Math.ceil(20 / FRAME_S)
    const states = 2 * 450 + 1
    expect(frames * states).toBeLessThan(2_000_000)
    const biggest = Math.max(...wins.map((x) => x.end - x.first))
    expect(biggest).toBeLessThan(80)
  })
})

describe('extendAlignedEnds', () => {
  const w = (startS: number, endS: number, aligned = true): AlignedWord => ({ startS, endS, aligned })

  it('lets an aligned end run on by the tail, to the next start at most', () => {
    const out = extendAlignedEnds([w(1, 1.1), w(1.2, 1.3), w(2, 2.1)])
    // 1.1 + tail would pass the next start at 1.2, so it stops there: the two words tile.
    expect(out[0].endS).toBeCloseTo(1.2, 9)
    // 1.3 + 0.16 is before the next start at 2: a real gap stays, shorter by nothing but the tail.
    expect(out[1].endS).toBeCloseTo(1.3 + END_TAIL_S, 9)
    // The last word has nothing after it, so it takes the whole tail.
    expect(out[2].endS).toBeCloseTo(2.1 + END_TAIL_S, 9)
  })

  it('leaves starts, order and unaligned words alone, and never shortens an end', () => {
    const input = [w(1, 1.5), w(1.2, 1.3, false), w(1.4, 1.45)]
    const out = extendAlignedEnds(input)
    expect(out.map((x) => x.startS)).toEqual([1, 1.2, 1.4])
    // The word after starts inside this one: the end stays where it was.
    expect(out[0].endS).toBe(1.5)
    expect(out[1]).toEqual(input[1])
    expect(input[0].endS).toBe(1.5)
  })

  it('keeps a pause a pause: a gap over tail plus 0.05 s still breaks captions', () => {
    const out = extendAlignedEnds([w(1, 1.1), w(1.5, 1.6)])
    expect(out[1].startS - out[0].endS).toBeGreaterThan(0.05)
    const touching = extendAlignedEnds([w(1, 1.1), w(1.2, 1.3)])
    expect(touching[1].startS - touching[0].endS).toBeLessThanOrEqual(0.05)
  })
})
