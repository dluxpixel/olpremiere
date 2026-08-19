import { describe, expect, it } from 'vitest'
import { defaultTitleDef } from '../types'
import {
  AUTO_CAPTION_OPTIONS,
  CAPTION_EMPHASIS_COLORS,
  CAPTION_POP_DUR_S,
  PHRASE_CAPTION_OPTIONS,
  captionClips,
  captionHouseCase,
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

describe('chunkWords: phrase mode (PHRASE_CAPTION_OPTIONS)', () => {
  it('groups into SHORT bursts, never one word each, never a subtitle line', () => {
    const words = [
      w('so', 0, 0.3), w('I', 0.3, 0.5), w('went', 0.5, 0.9), w('to', 0.9, 1.1),
      w('the', 1.1, 1.3), w('store', 1.3, 1.8), w('and', 1.8, 2.0), w('bought', 2.0, 2.5),
      w('some', 2.5, 2.8), w('milk', 2.8, 3.3),
    ]
    const chunks = chunkWords(words, PHRASE_CAPTION_OPTIONS)
    expect(chunks.length).toBeGreaterThan(2) // still keeping pace with the voice
    expect(chunks.length).toBeLessThan(words.length) // but genuinely grouped
    for (const c of chunks) expect(c.text.split(' ').length).toBeLessThanOrEqual(3)
    assertNonOverlapping(chunks)
  })

  it("keeps David's cadence: fast 1-3 word bursts are NOT swallowed by the merge pass", () => {
    // His own example of what captions should look like:
    //   minecraft | but i'm going | to try | and find | diamonds | without | touching the | color | green!
    // The old 1.0s readability floor merged exactly these short bursts into long
    // lines, which is what made auto-captions read as subtitles instead.
    const words = [
      w('minecraft', 0.0, 0.62), w('but', 0.62, 0.78), w("i'm", 0.78, 0.9), w('going', 0.9, 1.16),
      w('to', 1.16, 1.28), w('try', 1.28, 1.55), w('and', 1.55, 1.7), w('find', 1.7, 2.0),
      w('diamonds', 2.0, 2.66), w('without', 2.66, 3.1), w('touching', 3.1, 3.5),
      w('the', 3.5, 3.62), w('color', 3.62, 4.0), w('green!', 4.0, 4.5),
    ]
    const chunks = chunkWords(words, PHRASE_CAPTION_OPTIONS)
    for (const c of chunks) expect(c.text.split(' ').length).toBeLessThanOrEqual(3)
    // Bursts, not lines: 14 words must land in a run of short captions.
    expect(chunks.length).toBeGreaterThanOrEqual(5)
    // No caption hogs the screen for a second and a half.
    for (const c of chunks) expect(c.endS - c.startS).toBeLessThan(1.5)
    assertNonOverlapping(chunks)
  })

  it('a real pause lets a single word stand alone instead of being absorbed', () => {
    // Where he actually breathes is where the caption breaks: "minecraft" on its
    // own, then the next burst. Under the old 1.0s floor this word was merged
    // forward regardless, because 0.62s looked "too short to show".
    const words = [
      w('minecraft', 0.0, 0.62),
      w('but', 1.2, 1.36), w("i'm", 1.36, 1.5), w('going', 1.5, 1.76),
    ]
    const chunks = chunkWords(words, PHRASE_CAPTION_OPTIONS)
    expect(chunks[0].text).toBe('minecraft')
    // ...and the burst after the pause starts fresh rather than absorbing it.
    expect(chunks[1].text.startsWith('but')).toBe(true)
  })

  it('never leaves a bare function word as its own chunk mid-sentence', () => {
    const words = [w('go', 0, 0.4), w('to', 0.4, 0.6), w('the', 0.6, 0.8), w('shop', 0.8, 1.3)]
    const chunks = chunkWords(words, PHRASE_CAPTION_OPTIONS)
    const fn = new Set(['to', 'the', 'a', 'and', 'of'])
    for (const c of chunks) expect(fn.has(c.text.toLowerCase())).toBe(false)
  })

  it('keeps a sentence boundary and never merges across it', () => {
    const words = [w('end.', 0, 0.5), w('new', 0.6, 1.0), w('start', 1.0, 1.5)]
    const chunks = chunkWords(words, PHRASE_CAPTION_OPTIONS)
    expect(chunks[0].text).toBe('end.')
    assertNonOverlapping(chunks)
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
  // Every expectation below is a MEASURED value (reference frames, 2026-07-29),
  // so a failure here means the house style drifted off the measurement.
  it('produces the measured house style at 1080x1920', () => {
    const def = jettismCaptionDef('hello', 1920)
    expect(def.fontSizePx).toBe(105) // puts Montserrat's caps on the measured 3.8% H
    expect(def.color).toBe('#ffffff')
    expect(def.bold).toBe(true)
    expect(def.fontFamily).toContain('Montserrat')
    // 15 is a canvas lineWidth and a canvas stroke is centred, so about 7px of
    // it shows outside the glyph, which is the measured 10% of cap height.
    expect(def.outline).toEqual({ color: '#000000', widthPx: 15 })
    expect(def.offsetYPx).toBe(0) // dead centre, not the brief's 52%
    expect(def.vAlign).toBe('middle')
    expect(def.align).toBe('center')
    expect(def.shadow).toEqual({ color: 'rgba(0,0,0,0.4)', blurPx: 6, dx: 6, dy: 6 })
  })

  it('scales with the sequence height', () => {
    const def = jettismCaptionDef('hello', 960)
    expect(def.fontSizePx).toBe(53)
    expect(def.outline?.widthPx).toBe(8)
    expect(def.offsetYPx).toBe(0)
  })
})

// Both of these were found on his REAL footage on 2026-07-29, after the first
// measured build shipped. The timeline showed a picket fence of hairlines with
// the odd slab in it, and these were the two causes.
describe('what his real transcript did to the caption run', () => {
  it('never emits a caption with no text (bare punctuation, stage directions)', () => {
    const words = [
      w('minecart', 0, 0.4),
      w('.', 0.42, 0.44),
      w('(laughs)', 0.46, 0.9),
      w(',', 0.92, 0.94),
      w('[Music]', 0.96, 1.4),
      w('kit', 1.45, 1.8),
    ]
    const chunks = chunkWords(words, AUTO_CAPTION_OPTIONS)
    const clips = captionClips(chunks, { seqWidth: 1080, seqHeight: 1920 })
    expect(clips.map((c) => c.title?.text)).toEqual(['minecart', 'kit'])
    // The bug: "." survived chunking, then house-casing stripped it to nothing,
    // so the run carried clips with empty text. Invisible on the frame, and a
    // hairline on the timeline he could see and could not explain.
    expect(clips.filter((c) => (c.title?.text ?? '').trim() === '')).toHaveLength(0)
  })

  it('no caption outstays the measured ceiling, whatever the transcriber claims', () => {
    // A transcriber stretches a word across the pause after it. His real run had
    // a single "i'm" at 1.9s, which parked one caption on screen for nearly two
    // seconds. Every other limit governs GROUPING, so none of them could touch
    // it: there was only ever one word in the block.
    const chunks = chunkWords([w("i'm", 0, 1.9), w('burying', 4, 6.2), w('myself', 6.25, 6.5)], AUTO_CAPTION_OPTIONS)
    for (const c of chunks) {
      expect(c.endS - c.startS).toBeLessThanOrEqual(AUTO_CAPTION_OPTIONS.maxOnScreenS + 1e-6)
    }
    expect(chunks[0].endS - chunks[0].startS).toBeCloseTo(1.3, 6)
  })

  it('the ceiling is OFF for legacy callers, so the manual split is unchanged', () => {
    const chunks = chunkWords([w('one', 0, 3)], { maxWords: 1 })
    expect(chunks[0].endS - chunks[0].startS).toBeGreaterThan(1.3)
  })
})

describe('captionHouseCase', () => {
  it('lowercases ordinary words and drops sentence punctuation', () => {
    expect(captionHouseCase('Minecart kit, but you might notice.')).toBe('minecart kit but you might notice')
  })

  it('keeps acronyms and mixed-caps names', () => {
    expect(captionHouseCase('three shulkers of TNT')).toBe('three shulkers of TNT')
    expect(captionHouseCase('the PvP arena')).toBe('the PvP arena')
  })

  it('keeps apostrophes, question marks and exclamations', () => {
    // The pronoun I keeps its capital (2026-08-06, his request); the rest of
    // the lowercase house style is unchanged.
    expect(captionHouseCase("I'm going in!")).toBe("I'm going in!")
    expect(captionHouseCase("he's going in!")).toBe("he's going in!")
    expect(captionHouseCase('Ready?')).toBe('ready?')
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
    // House style is measured lowercase, EXCEPT the pronoun I (2026-08-06).
    expect(clips[0].title?.text).toBe('so I')
    expect(clips[0].assetId).toBe('')
  })

  describe('what he taught it', () => {
    const profile = {
      model: 'm',
      captions: 40,
      fixes: [{ from: 'boom', to: 'BOOM!!', seen: 4 }],
      candidates: [],
      caseHabit: 'lower' as const,
      stripsPunctuation: null,
      fontSizePx: null,
      animation: null,
      medianDurS: null,
    }

    it('spells a word the way he respells it', () => {
      const clips = captionClips(chunks, { ...opts, profile })
      expect(clips[1].title?.text).toBe('BOOM!!')
    })

    it('⛔ does not re-case his own rewrite, whatever the casing habit says', () => {
      // 'lower' above would hand back "boom!!", which is the feature undoing
      // the one thing it learned.
      const clips = captionClips(chunks, { ...opts, profile, upper: false })
      expect(clips[1].title?.text).toBe('BOOM!!')
    })

    it('⛔ still stamps the MACHINE word as the origin, not his rewrite', () => {
      // Otherwise the next archive reads "he changed nothing" and the habit
      // slowly starves itself out of the profile.
      const clips = captionClips(chunks, { ...opts, profile, model: 'm' })
      expect(clips[1].captionOrigin).toEqual({ text: 'boom', model: 'm' })
    })

    it('leaves everything alone when nothing has been learned', () => {
      const clips = captionClips(chunks, { ...opts, profile: null })
      expect(clips[1].title?.text).toBe('boom')
    })
  })

  it('colors emphasis chunks with the highlight color', () => {
    const clips = captionClips(chunks, opts)
    expect(clips[0].title?.color).toBe('#ffffff')
    expect(clips[1].title?.color).toBe(CAPTION_EMPHASIS_COLORS[0])
  })

  it('hard-cuts by default: no entrance animation on caption clips', () => {
    const clips = captionClips(chunks, opts)
    for (const clip of clips) {
      expect(clip.appearance).toBeUndefined()
      expect(clip.keyframes?.scale?.length ?? 0).toBe(0)
    }
  })

  it('compiles a pop entrance when explicitly asked for', () => {
    const clips = captionClips(chunks, { ...opts, popIn: true })
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

// "make it so it automatically capitalizes some characters, for example, I and
// stuff like that." (2026-08-06)
//
// The house look IS lowercase, measured off his own reference frames, and that
// is not being undone. But a lone "i" is not a style choice, it reads as a typo.
describe('captionHouseCase capitalises the words that are wrong in lowercase', () => {
  it('the pronoun I, on its own', () => {
    expect(captionHouseCase('i think so')).toBe('I think so')
    expect(captionHouseCase('so i said')).toBe('so I said')
  })

  it('and its contractions', () => {
    expect(captionHouseCase("i'm going")).toBe("I'm going")
    expect(captionHouseCase("i'll do it")).toBe("I'll do it")
    expect(captionHouseCase("i've seen it")).toBe("I've seen it")
    expect(captionHouseCase("i'd rather")).toBe("I'd rather")
  })

  it('even when the house style kept an exclamation or a question mark', () => {
    expect(captionHouseCase('i!')).toBe('I!')
    expect(captionHouseCase("i'm?")).toBe("I'm?")
  })

  it('but nothing else: the lowercase house look is still the look', () => {
    expect(captionHouseCase('minecraft is good')).toBe('minecraft is good')
    expect(captionHouseCase('It Was Fine')).toBe('it was fine')
    // A word merely CONTAINING an i is untouched.
    expect(captionHouseCase('it is inside')).toBe('it is inside')
  })

  it('acronyms still win, as before', () => {
    expect(captionHouseCase('the TNT and PvP')).toBe('the TNT and PvP')
  })

  it("capitalises I even when the recogniser used a curly apostrophe", () => {
    // His ask, 2026-08-06: "make it so it automatically capitalizes some
    // characters, for example, I". Whisper often writes U+2019, which the lookup
    // did not hold, so exactly that word came out lowercase on screen.
    expect(captionHouseCase('i’m going')).toBe('I’m going')
    expect(captionHouseCase("i'm going")).toBe("I'm going")
    expect(captionHouseCase('i’ll try')).toBe('I’ll try')
  })

  it('keeps a short acronym whose letters are accented', () => {
    // The acronym test stripped everything outside A-Za-z, so a two letter Czech
    // acronym had nothing left to judge and was flattened.
    expect(captionHouseCase('ČR')).toBe('ČR')
    expect(captionHouseCase('ŠKODA')).toBe('ŠKODA')
    // and an ordinary accented word still goes lowercase, which is the house style
    expect(captionHouseCase('Žije')).toBe('žije')
  })
})

// A CAPTION MUST NOT END ON A FUNCTION WORD.
//
// `FUNCTION_WORDS` says these "shouldn't stand alone as a caption OR END A
// CHUNK" and only the first half was ever built. He was looking at the second
// half on 2026-08-13: his own line came out as `we have | to be | careful of |
// these.`, and "careful of" is a phrase cut in the middle, because grouping is
// decided by clock time and "of" belongs with "these" rather than "careful".
describe('a caption never ends on a function word', () => {
  it('hands a trailing preposition forward to the words it belongs with', () => {
    const chunks = chunkWords([w('careful', 0, 0.3), w('of', 0.3, 0.42), w('these.', 0.42, 0.9)], AUTO_CAPTION_OPTIONS)
    expect(chunks.map((c) => c.text)).toEqual(['careful', 'of these.'])
  })

  it('never hands one across a pause', () => {
    // A real gap is a HARD break and nothing may cross one: the word belongs to
    // the phrase he said it in, not to the one after his breath.
    const chunks = chunkWords([w('careful', 0, 0.3), w('of', 0.3, 0.42), w('these.', 0.9, 1.4)], AUTO_CAPTION_OPTIONS)
    expect(chunks.map((c) => c.text)).toEqual(['careful of', 'these.'])
  })

  it('never trades one lone function word for another', () => {
    // Moving "be" would leave "to" alone, which is the exact thing the merge
    // pass exists to prevent, and the two could ping-pong forever.
    const chunks = chunkWords([w('to', 0, 0.2), w('be', 0.2, 0.4), w('careful', 0.4, 0.8)], AUTO_CAPTION_OPTIONS)
    expect(chunks.map((c) => c.text)).toEqual(['to be', 'careful'])
  })

  it('never leaves a caption too short to read behind it', () => {
    // ⛔ This pass runs AFTER the merge, which is the only thing that repairs a
    // short group, so anything it shortens past the floor STAYS short. Measured
    // over 6000 takes before the guard: 8.5% gained a caption under 0.2s, the
    // worst at 0.10s, three frames. That is the hairline picket fence on the
    // timeline and a word nobody can read.
    const chunks = chunkWords(
      [w('diamonds', 0, 0.15), w('and', 0.15, 0.21), w('green', 0.21, 1.0)],
      AUTO_CAPTION_OPTIONS,
    )
    for (const c of chunks) expect(c.endS - c.startS).toBeGreaterThanOrEqual(AUTO_CAPTION_OPTIONS.minDurS - 1e-6)
  })

  it('never merges a caption past the on-screen ceiling, which would blank it mid-word', () => {
    // ⛔ `maxOnScreenS` is measured from the block's START, so merging a word
    // onto the front moves the start earlier and the ceiling can cut the caption
    // off while its own last word is still being said. Over 3000 takes this one
    // interaction added 30% more blank screen time, all of it from merges that
    // outgrew the ceiling.
    const chunks = chunkWords([w('be', 2.04, 2.64), w('but', 2.64, 3.54), w('green', 3.54, 4.0)], AUTO_CAPTION_OPTIONS)
    for (let i = 0; i < chunks.length - 1; i++) {
      // No blank: each caption hands straight over to the next one.
      expect(chunks[i + 1].startS - chunks[i].endS).toBeLessThanOrEqual(1e-6)
    }
  })

  it('keeps a word that has no plain latin letter in it', () => {
    // ⛔ `isSpeechWord` was ASCII-only, so it threw away "Ó" out of a Czech line
    // and EVERY word of a Russian, Japanese, Korean, Greek or Arabic one. The
    // app offers Czech and Auto-detect, and Auto-detect is the 99 language
    // model, so that path paid for a whole Whisper run and returned nothing.
    expect(chunkWords([w('Ó', 0, 0.3), w('ať', 0.3, 0.6), w('žije', 0.6, 1)], AUTO_CAPTION_OPTIONS).length).toBe(2)
    expect(chunkWords([w('Ó', 0, 0.3), w('ať', 0.3, 0.6), w('žije', 0.6, 1)], AUTO_CAPTION_OPTIONS)[0].text).toContain(
      'Ó',
    )
    for (const word of ['привет', 'こんにちは', '안녕하세요', 'مرحبا', 'γεια', 'ě', '42']) {
      expect(chunkWords([w(word, 0, 0.4)], AUTO_CAPTION_OPTIONS).map((c) => c.text)).toEqual([word])
    }
  })

  it('still throws away a token that is only punctuation or a stage direction', () => {
    // The reason isSpeechWord exists: a bare "." reached the screen as a caption
    // clip with no text, invisible on the frame and a sliver on the timeline.
    for (const junk of ['.', ',', '...', '(laughs)', '[Music]', '♪']) {
      expect(chunkWords([w('real', 0, 0.4), w(junk, 0.4, 0.8)], AUTO_CAPTION_OPTIONS).map((c) => c.text)).toEqual([
        'real',
      ])
    }
  })

  it('leaves it alone when the caption it would join cannot take it', () => {
    // "of extraordinary" is 16 characters against a 14 character frame budget.
    const chunks = chunkWords(
      [w('careful', 0, 0.3), w('of', 0.3, 0.42), w('extraordinary', 0.42, 0.9)],
      AUTO_CAPTION_OPTIONS,
    )
    expect(chunks.map((c) => c.text)).toEqual(['careful of', 'extraordinary'])
  })
})
