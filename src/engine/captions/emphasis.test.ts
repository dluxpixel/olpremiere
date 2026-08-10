// The keyword highlight, tested against the thing that actually goes wrong: the
// WRONG word sitting on screen in yellow for the whole clip.
//
// A miss costs nothing. He records another take, or he lives with a plain
// caption, which is exactly what he has today on every short he has ever
// shipped. A false positive costs him a re-edit and he will not know why it
// happened. So nearly every test below is a REFUSAL test, and the bar is not
// "does it find the lean", it is "does it keep its hands off everything else".
//
// The audio here is synthetic on purpose. `_verify/word-emphasis.mjs` is where
// the thresholds came from, on the one real human take in this repo run through
// real Whisper in real Electron, and no unit test can or should re-do that. What
// these fixtures do is different and complementary: they hold a known right
// answer, so they can prove the ARITHMETIC does what the measurement asked for,
// and they can hold a regression still forever. Each take is steady tone inside
// each word's span and true silence between, laid on the 20 ms grid the envelope
// uses, so a stated "6 dB louder" is exactly 6 dB and nothing is approximate.

import { describe, expect, it } from 'vitest'
import { EMPHASIS_DEFAULTS, markEmphasis, speechEnvelope } from './emphasis'
import { AUTO_CAPTION_OPTIONS, chunkWords, type CaptionWord } from './captions'

const SR = 16000
/** Well inside float range and well above the silence floor. The value is arbitrary; every gate is a DIFFERENCE. */
const BASE_AMP = 0.05
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const ampFor = (db: number): number => BASE_AMP * Math.pow(10, db / 20)

interface Said {
  text: string
  /** How much louder than the rest of the take, dB. Absent means level, and level is the normal case. */
  db?: number
  /** A label with NO sound behind it: what a mistimed or invented word span looks like. */
  silent?: boolean
  /** Silence after this word. Above `AUTO_CAPTION_OPTIONS.maxGapS` it ends a phrase. */
  gapAfterS?: number
}

interface TakeOptions {
  /** Word length. Multiples of the 20 ms envelope hop keep every span exact. */
  wordS?: number
  gapS?: number
  /**
   * Label every word this many seconds LATE, leaving the sound where it is.
   * Whisper does this constantly: 31 of 77 measured words carried a span that
   * was over 40% not speech.
   */
  labelLagS?: number
}

/** A take of speech plus the labels a transcriber would hand back for it. */
function take(said: readonly Said[], opts: TakeOptions = {}): { words: CaptionWord[]; envelope: Float32Array } {
  const wordS = opts.wordS ?? 0.3
  const gapS = opts.gapS ?? 0.1
  const lag = opts.labelLagS ?? 0
  const words: CaptionWord[] = []
  const spans: { fromS: number; toS: number; amp: number }[] = []
  let t = 0
  for (const s of said) {
    words.push({ text: s.text, startS: r3(t + lag), endS: r3(t + lag + wordS) })
    if (!s.silent) spans.push({ fromS: t, toS: t + wordS, amp: ampFor(s.db ?? 0) })
    t = r3(t + wordS + (s.gapAfterS ?? gapS))
  }
  const pcm = new Float32Array(Math.round((t + lag + 0.5) * SR))
  for (const s of spans) {
    const a = Math.round(s.fromS * SR)
    const b = Math.min(pcm.length, Math.round(s.toS * SR))
    // Alternating sign so the RMS of a window is exactly the amplitude and no
    // window carries DC that a real recording would not have.
    for (let i = a; i < b; i++) pcm[i] = i % 2 === 0 ? s.amp : -s.amp
  }
  return { words, envelope: speechEnvelope(pcm, SR) }
}

const picked = (ws: readonly CaptionWord[]): string[] => ws.filter((w) => w.emphasis).map((w) => w.text)

/** Six content words, none of them a stop word, none of them too short to colour. */
const SIX: Said[] = [
  { text: 'trapped' },
  { text: 'diamonds' },
  { text: 'without' },
  { text: 'touching' },
  { text: 'colour' },
  { text: 'green' },
]

/** The same six with one of them leaned on. */
const sixWith = (at: number, over: Partial<Said>): Said[] => SIX.map((s, i) => (i === at ? { ...s, ...over } : s))

describe('markEmphasis, the words themselves', () => {
  it('changes the flag and NOTHING else, not one character and not one timing', () => {
    const t = take(sixWith(2, { db: 6 }))
    const out = markEmphasis(t.words, t.envelope)
    expect(picked(out)).toEqual(['without'])
    expect(out).toHaveLength(t.words.length)
    out.forEach((w, i) => {
      expect(w.text).toBe(t.words[i].text)
      expect(w.startS).toBe(t.words[i].startS)
      expect(w.endS).toBe(t.words[i].endS)
    })
  })

  it('hands back the very same objects for every word it did not pick', () => {
    const t = take(sixWith(2, { db: 6 }))
    const out = markEmphasis(t.words, t.envelope)
    out.forEach((w, i) => {
      if (w.emphasis) expect(w).not.toBe(t.words[i])
      else expect(w).toBe(t.words[i])
    })
  })

  it('THE LOAD BEARING CHECK: the captions on screen still read the same words', () => {
    // Everything the auto path does, both ways, through the real chunker with
    // the real options. The flag is allowed to change where the block BREAKS.
    // It is not allowed to change, drop, reorder or merge a single word.
    const t = take(sixWith(2, { db: 6 }), { wordS: 0.16, gapS: 0.02 })
    const spoken = t.words.map((w) => w.text).join(' ')
    const plain = chunkWords(t.words, AUTO_CAPTION_OPTIONS)
    const marked = chunkWords(markEmphasis(t.words, t.envelope), AUTO_CAPTION_OPTIONS)
    expect(plain.map((c) => c.text).join(' ')).toBe(spoken)
    expect(marked.map((c) => c.text).join(' ')).toBe(spoken)
  })

  it('leaves a non speech token alone and still finds the lean around it', () => {
    // A bare "." and a stage direction are recogniser artifacts. `chunkWords`
    // filters them, so this must filter them the same way or the two disagree
    // about where a phrase begins.
    const t = take([SIX[0], { text: '.' }, SIX[1], { text: '(laughs)' }, { ...SIX[2], db: 6 }, SIX[3], SIX[4], SIX[5]])
    const out = markEmphasis(t.words, t.envelope)
    expect(picked(out)).toEqual(['without'])
    expect(out[1]).toBe(t.words[1])
    expect(out[3]).toBe(t.words[3])
  })

  it('does nothing at all without an envelope to measure', () => {
    const t = take(sixWith(2, { db: 6 }))
    const out = markEmphasis(t.words, new Float32Array(0))
    expect(picked(out)).toEqual([])
    out.forEach((w, i) => expect(w).toBe(t.words[i]))
  })
})

describe('markEmphasis, what earns the colour', () => {
  it('picks the one word he leaned on', () => {
    const t = take(sixWith(2, { db: 6 }))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual(['without'])
  })

  it('picks it wherever it falls, including the last word of the phrase', () => {
    for (const at of [0, 1, 2, 3, 4, 5]) {
      const t = take(sixWith(at, { db: 6 }))
      expect(picked(markEmphasis(t.words, t.envelope))).toEqual([SIX[at].text])
    }
  })

  it('picks at most ONE word however many he leaned on', () => {
    const t = take(SIX.map((s, i) => (i === 1 || i === 4 ? { ...s, db: 8 } : s)))
    expect(picked(markEmphasis(t.words, t.envelope)).length).toBeLessThanOrEqual(1)
  })
})

describe('markEmphasis, what it refuses', () => {
  it('picks NOTHING when every word is level', () => {
    const t = take(SIX)
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('picks NOTHING out of ordinary wobble, which is the null control', () => {
    // A dB apart at most, against the 0.9 to 1.1 dB measurement floor the
    // flattened fixture showed. There is nothing here to find.
    const jitter = [0, 0.4, -0.3, 0.5, -0.2, 0.3]
    const t = take(SIX.map((s, i) => ({ ...s, db: jitter[i] })))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('picks NOTHING when the phrase has no range in it', () => {
    // Under `minSpreadDb`. A 4 word phrase in the real take carried 1.4 dB and
    // that is indistinguishable from the floor.
    const t = take(sixWith(2, { db: 2 }))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('picks NOTHING when two words are leaned on equally', () => {
    // Range enough to pass the first gate, no winner by `minMarginDb`. Refusing
    // is right: colouring either one is a coin toss he has to look at.
    const t = take(SIX.map((s, i) => (i === 2 || i === 4 ? { ...s, db: 3.5 } : s)))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('NEVER a function word, and the vocabulary is the only thing that changed', () => {
    // The same audio twice, the same lean in the same slot, at the same dB. The
    // ONLY difference is what the word is. Measured 2026-08-09, raw loudness
    // picks a function word in 7 of 14 phrases, so without the veto "it" would
    // be the highlight on his screen.
    const stop = take(sixWith(2, { text: 'it', db: 6 }))
    const content = take(sixWith(2, { text: 'trapped', db: 6 }))
    expect(picked(markEmphasis(stop.words, stop.envelope))).toEqual([])
    expect(picked(markEmphasis(content.words, content.envelope))).toEqual(['trapped'])
  })

  it('never lets a vetoed word hand the colour to a bystander', () => {
    // The refusal above must be a refusal, not a redirection to whichever word
    // happens to sit next to the loud one.
    const t = take(sixWith(2, { text: 'it', db: 9 }))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('never a word too short to read as a deliberate highlight', () => {
    const short = take(sixWith(2, { text: 'go', db: 6 }))
    const long = take(sixWith(2, { text: 'gold', db: 6 }))
    expect(picked(markEmphasis(short.words, short.envelope))).toEqual([])
    expect(picked(markEmphasis(long.words, long.envelope))).toEqual(['gold'])
  })

  it('counts letters the way Czech needs, not as a to z', () => {
    // Czech is a selectable caption language. "stava" with its diacritics has
    // five letters and only two of them are ASCII, so an ASCII length check
    // would veto it and quietly switch the whole feature off in his language.
    const t = take(sixWith(2, { text: 'šťáva', db: 6 }))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual(['šťáva'])
  })

  it('never a word that sits BELOW the voice around it', () => {
    const t = take(sixWith(2, { db: -6 }))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('never picks out of a phrase too short to have a shape', () => {
    const t = take([{ text: 'diamonds', db: 9 }, { text: 'green', gapAfterS: 0.6 }, { text: 'trapped' }])
    // The first two are one phrase, "trapped" is alone after the silence and can
    // never be picked whatever it measures.
    expect(picked(markEmphasis(t.words, t.envelope))).not.toContain('trapped')
  })
})

describe('markEmphasis, a label with no sound behind it', () => {
  // The regression that made this file worth writing. Whisper's word spans are
  // not the word: 31 of 77 measured words carried a span over 40% not speech,
  // and a span can miss its word completely. The reading is then a floor value,
  // which is the ABSENCE of a measurement, not a quiet one.

  it('never carries the colour itself', () => {
    const t = take(SIX.map((s, i) => (i === 2 ? { ...s, silent: true } : s)))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('never decides another word\'s contrast', () => {
    // WAS BROKEN, and this is the exact shape of it. One silent label at slot 2
    // plus a real +6 dB lean at slot 4. The neighbour window used to be CLIPPED
    // at the phrase edge, so the first word had only two neighbours, a two
    // element median is their MEAN, the floored reading dragged it to -30 dB and
    // handed "trapped" +30 dB of invented contrast. It beat the genuine lean and
    // put the colour on a word nobody leaned on, for the whole clip.
    const t = take(SIX.map((s, i) => (i === 2 ? { ...s, silent: true } : i === 4 ? { ...s, db: 6 } : s)))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual(['colour'])
  })

  it('cannot manufacture a range out of its own floor', () => {
    // Level speech plus one silent label. The floor value is 57 dB below the
    // rest, so counting it would clear `minSpreadDb` many times over on a phrase
    // that has nothing in it.
    const t = take(SIX.map((s, i) => (i === 3 ? { ...s, silent: true } : s)))
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })

  it('does not change the pick when a real lean is present', () => {
    const clean = take(sixWith(4, { db: 6 }))
    const ghosted = take(SIX.map((s, i) => (i === 2 ? { ...s, silent: true } : i === 4 ? { ...s, db: 6 } : s)))
    expect(picked(markEmphasis(ghosted.words, ghosted.envelope))).toEqual(
      picked(markEmphasis(clean.words, clean.envelope)),
    )
  })
})

describe('markEmphasis, Whisper labels the words late', () => {
  it('finds the word by sliding the window, and finds NOTHING without sliding', () => {
    // Every label 200 ms after its own sound, which is the middle of the range
    // measured on the real take (130 ms dry, 50 ms under one music bed, 130 ms
    // under another). Read at face value the words land in the pauses AFTER
    // themselves and every one of them measures as silence.
    const t = take(sixWith(2, { db: 6 }), { labelLagS: 0.2 })
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual(['without'])
    expect(picked(markEmphasis(t.words, t.envelope, { maxLagS: 0 }))).toEqual([])
  })

  it('does not invent a lean out of a late label on a level take', () => {
    const t = take(SIX, { labelLagS: 0.2 })
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual([])
  })
})

describe('markEmphasis, one highlight per caption block', () => {
  /** Short words and tight gaps, so the chunker really does put TWO words in a block. */
  const FAST: TakeOptions = { wordS: 0.16, gapS: 0.02 }

  it('the fixture is honest: these settings really do group words together', () => {
    const t = take(SIX, FAST)
    expect(chunkWords(t.words, AUTO_CAPTION_OPTIONS).some((c) => c.text.includes(' '))).toBe(true)
  })

  it('a sentence end and a real silence each start a fresh phrase', () => {
    const t = take(
      [
        { text: 'trapped' },
        { text: 'diamonds', db: 6 },
        { text: 'green.' },
        { text: 'colour' },
        { text: 'without', db: 6 },
        { text: 'touching', gapAfterS: 0.6 },
        { text: 'blocks' },
        { text: 'melting', db: 6 },
        { text: 'redstone' },
      ],
      FAST,
    )
    expect(picked(markEmphasis(t.words, t.envelope))).toEqual(['diamonds', 'without', 'melting'])
  })

  it('every highlight gets its own caption block, and no block gets two', () => {
    const t = take(
      [
        { text: 'trapped' },
        { text: 'diamonds', db: 6 },
        { text: 'green.' },
        { text: 'colour' },
        { text: 'without', db: 6 },
        { text: 'touching', gapAfterS: 0.6 },
        { text: 'blocks' },
        { text: 'melting', db: 6 },
        { text: 'redstone' },
      ],
      FAST,
    )
    const marked = markEmphasis(t.words, t.envelope)
    const chunks = chunkWords(marked, AUTO_CAPTION_OPTIONS)
    const hot = chunks.filter((c) => c.emphasis)
    // One coloured block per picked word, and each holds exactly that one word.
    expect(hot).toHaveLength(picked(marked).length)
    expect(hot.map((c) => c.text)).toEqual(picked(marked))
    for (const c of hot) expect(c.text.split(' ')).toHaveLength(1)
  })
})

describe('markEmphasis, the invariant the guarantee rests on', () => {
  it('splits phrases on exactly the silence the chunker breaks blocks on', () => {
    // The whole one-per-block guarantee is this one equality. Every auto caption
    // door lands in `addCaptionsFromWords`, which chunks with
    // AUTO_CAPTION_OPTIONS, so a phrase boundary here is a block boundary there.
    // Smaller here and a phrase could END inside a block, which is how two
    // highlights land in one caption.
    expect(EMPHASIS_DEFAULTS.maxGapS).toBe(AUTO_CAPTION_OPTIONS.maxGapS)
  })

  it('a gap the chunker breaks on is a gap the picker breaks on', () => {
    // Behavioural version of the same thing, so the pin above cannot be kept
    // true by editing one number in two places.
    const gap = AUTO_CAPTION_OPTIONS.maxGapS + 0.1
    const t = take(
      [
        { text: 'trapped' },
        { text: 'diamonds', db: 6 },
        { text: 'green', gapAfterS: gap },
        { text: 'colour' },
        { text: 'without', db: 6 },
        { text: 'touching' },
      ],
      { wordS: 0.16, gapS: 0.02 },
    )
    const marked = markEmphasis(t.words, t.envelope)
    expect(picked(marked)).toEqual(['diamonds', 'without'])
    const chunks = chunkWords(marked, AUTO_CAPTION_OPTIONS)
    expect(chunks.filter((c) => c.emphasis)).toHaveLength(2)
  })
})
