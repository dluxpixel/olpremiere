// Caption styles, the pure half: how a style's length cuts words, how its look
// dresses a caption, and that a look saved before styles existed still makes
// exactly the captions it made then.

import { describe, expect, it } from 'vitest'
import { newTitleClip, type Clip, type TitleDef } from '../types'
import {
  AUTO_CAPTION_OPTIONS,
  CAPTION_POP_DUR_S,
  captionClips,
  captionHouseCase,
  chunkWords,
  jettismCaptionDef,
  type CaptionWord,
} from './captions'
import {
  AUTO_SHAPE,
  BUILTIN_CAPTION_STYLES,
  breakLines,
  captionDefFor,
  captionFitterFor,
  chunkOptionsFor,
  cleanShape,
  cleanStyle,
  dressCaption,
  lookOfTitle,
  recutCaptions,
  sameShape,
  scaleLook,
  styleFromLegacyPreset,
  type CaptionShape,
  type CaptionStyle,
} from './captionStyle'
import { captionLineWidthPx, captionTextWidthPx } from './captionFit'
import { COMIC_STACK, OSWALD_STACK } from '../render/titleFonts'

const HOUSE = BUILTIN_CAPTION_STYLES[0]!

/** Words said back to back, `each` seconds apiece, starting at `from`. */
function said(text: string, from = 0, each = 0.25): CaptionWord[] {
  return text.split(' ').map((t, i) => ({ text: t, startS: from + i * each, endS: from + (i + 1) * each }))
}

const fixed = (over: Partial<CaptionShape> = {}): CaptionShape => cleanShape({ ...AUTO_SHAPE, length: 'fixed', ...over })

const style = (over: Partial<CaptionStyle> = {}): CaptionStyle => ({
  id: 's1',
  name: 'Mine',
  look: {},
  shape: AUTO_SHAPE,
  emphasisColor: '#FFD400',
  updatedAt: 1,
  ...over,
})

const wordsIn = (chunks: { text: string }[]): string[] => chunks.flatMap((c) => c.text.split(/\s+/))

describe('a style that leaves the length on auto', () => {
  it('cuts exactly what every caption run has cut since the length was measured, on the frames', () => {
    const words = [...said('so i went to the store and bought some apples'), ...said('then i came home', 3)]
    expect(chunkWords(words, chunkOptionsFor(AUTO_SHAPE, 30))).toEqual(chunkWords(words, { ...AUTO_CAPTION_OPTIONS, fps: 30 }))
  })

  it('puts every caption edge on a frame of the sequence', () => {
    const words = [...said('so i went to the store and bought some apples'), ...said('then i came home', 3)]
    for (const fps of [24, 25, 30, 60]) {
      for (const c of chunkWords(words, chunkOptionsFor(AUTO_SHAPE, fps))) {
        expect(c.startS * fps).toBeCloseTo(Math.round(c.startS * fps), 6)
        expect(c.endS * fps).toBeCloseTo(Math.round(c.endS * fps), 6)
      }
    }
  })
})

describe('a fixed caption length', () => {
  const words = [...said('so i went to the store and bought some apples'), ...said('then i came home', 3)]

  it('never puts more words in a caption than he allowed, and loses none', () => {
    for (const maxWords of [1, 2, 3, 5]) {
      const chunks = chunkWords(words, chunkOptionsFor(fixed({ maxWords, charsPerLine: 60 }), 30))
      expect(chunks.every((c) => c.text.split(' ').length <= maxWords)).toBe(true)
      expect(wordsIn(chunks)).toEqual(words.map((w) => w.text))
    }
  })

  it('fills captions fuller than auto does when he asks for longer ones', () => {
    const auto = chunkWords(words, chunkOptionsFor(AUTO_SHAPE, 30))
    const five = chunkWords(words, chunkOptionsFor(fixed({ maxWords: 5, charsPerLine: 60 }), 30))
    expect(five.length).toBeLessThan(auto.length)
  })

  it('still breaks at every pause, so a long caption never sits there while he is not talking', () => {
    const chunks = chunkWords(words, chunkOptionsFor(fixed({ maxWords: 12, charsPerLine: 60 }), 30))
    // "apples" ends at 2.5, "then" starts at 3: no caption may hold both.
    expect(chunks.some((c) => c.text.includes('apples') && c.text.includes('then'))).toBe(false)
  })

  it('keeps every caption inside its characters per line, times its lines', () => {
    const one = chunkWords(words, chunkOptionsFor(fixed({ maxWords: 12, charsPerLine: 12, lines: 1 }), 30))
    expect(one.filter((c) => c.text.includes(' ')).every((c) => c.text.length <= 12)).toBe(true)
    const two = chunkWords(words, chunkOptionsFor(fixed({ maxWords: 12, charsPerLine: 12, lines: 2 }), 30))
    expect(two.every((c) => c.text.length <= 24)).toBe(true)
    expect(Math.max(...two.map((c) => c.text.length))).toBeGreaterThan(12)
  })

  it('holds a lone word up for at least the shortest time he set', () => {
    const [only] = chunkWords([{ text: 'hey', startS: 1, endS: 1.1 }], chunkOptionsFor(fixed({ minDurS: 0.8 }), 30))
    expect(only!.endS - only!.startS).toBeCloseTo(0.8, 6)
  })

  it('leaves the gap he asked for between captions, without moving any start', () => {
    const plain = chunkWords(words, chunkOptionsFor(fixed({ maxWords: 1 }), 30))
    const gapped = chunkWords(words, chunkOptionsFor(fixed({ maxWords: 1, gapFrames: 3 }), 30))
    expect(gapped.map((c) => c.startS)).toEqual(plain.map((c) => c.startS))
    for (let i = 0; i + 1 < gapped.length; i++) {
      expect(gapped[i + 1]!.startS - gapped[i]!.endS).toBeGreaterThanOrEqual(0.1 - 1e-9)
      expect(gapped[i]!.endS).toBeGreaterThan(gapped[i]!.startS)
    }
  })
})

describe('two lines', () => {
  it('breaks a long caption at the space that balances the lines', () => {
    expect(breakLines('so i went to the store today', fixed({ charsPerLine: 16, lines: 2 }))).toBe('so i went to\nthe store today')
  })

  it('leaves one line, a short caption, and the auto length alone', () => {
    expect(breakLines('so i went to the store today', fixed({ charsPerLine: 16, lines: 1 }))).toBe('so i went to the store today')
    expect(breakLines('short one', fixed({ charsPerLine: 16, lines: 2 }))).toBe('short one')
    expect(breakLines('so i went to the store today', AUTO_SHAPE)).toBe('so i went to the store today')
  })
})

describe('the look', () => {
  it('the house style is the measured house caption, at any height', () => {
    for (const h of [1920, 1280, 1080]) expect(captionDefFor(HOUSE, 'hi', h)).toEqual(jettismCaptionDef('hi', h))
  })

  it('scales with the frame from the height it was set on', () => {
    const big = style({ look: { fontSizePx: 140, outline: { color: '#000', widthPx: 20 } }, refHeight: 1920 })
    expect(captionDefFor(big, 'x', 1920).fontSizePx).toBe(140)
    expect(captionDefFor(big, 'x', 1080).fontSizePx).toBe(79)
    expect(captionDefFor(big, 'x', 1080).outline!.widthPx).toBe(11)
    expect(scaleLook(big.look, 1)).toBe(big.look)
  })

  it('takes the house outline away when the style says none, even after a save', () => {
    const def: TitleDef = { ...jettismCaptionDef('x', 1920) }
    delete def.outline
    const saved = JSON.parse(JSON.stringify(style({ look: lookOfTitle(def), refHeight: 1920 }))) as CaptionStyle
    expect(captionDefFor(cleanStyle(saved)!, 'x', 1920).outline).toBeUndefined()
    expect(captionDefFor(cleanStyle(saved)!, 'x', 1920)).toEqual(def)
  })

  it('paints the word the highlight picked in the style colour, not the plain colour', () => {
    const s = style({ look: { color: '#00ff00' }, emphasisColor: '#ff00ff' })
    const plain = newTitleClip(jettismCaptionDef('the', 1920), 0, 0.5)
    const keyword: Clip = { ...plain, captionEmphasis: true }
    expect(dressCaption(plain, s, 1080, 1920).title!.color).toBe('#00ff00')
    expect(dressCaption(keyword, s, 1080, 1920).title!.color).toBe('#ff00ff')
  })

  it('gives every caption its own copy of the effects, and follows the style on the entrance', () => {
    const fx = { id: 'fx1', type: 'blur', enabled: true, params: { amount: { value: 4, keyframes: [] } } }
    const s = style({ effects: [fx], appearance: { in: 'pop', durS: 0.1 } })
    const a = dressCaption(newTitleClip(jettismCaptionDef('a', 1920), 0, 0.5), s, 1080, 1920)
    const b = dressCaption(newTitleClip(jettismCaptionDef('b', 1920), 1, 0.5), s, 1080, 1920)
    expect(a.effects[0]).not.toBe(b.effects[0])
    expect(a.effects[0]).not.toBe(fx)
    expect(a.appearance?.in).toBe('pop')
    // A hard cut style takes the pop away again.
    expect(dressCaption(a, style(), 1080, 1920).appearance).toBeUndefined()
  })
})

describe('cutting finished captions again', () => {
  const seq = { width: 1080, height: 1920, fps: 30 }
  const run = (): Clip[] =>
    captionClips(chunkWords(said('so i went to the store and bought some apples'), AUTO_CAPTION_OPTIONS), {
      seqWidth: 1080,
      seqHeight: 1920,
      model: 'whisper-small',
    })

  it('regroups at the new length and keeps every word in order', () => {
    const before = run()
    const after = recutCaptions(before, style({ shape: fixed({ maxWords: 3, charsPerLine: 40 }) }), seq)
    expect(after.length).toBeLessThan(before.length)
    expect(after.every((c) => c.title!.text.split(' ').length <= 3)).toBe(true)
    expect(after.flatMap((c) => c.title!.text.split(' '))).toEqual(before.flatMap((c) => c.title!.text.split(' ')))
    expect(after[0]!.startS).toBeCloseTo(before[0]!.startS, 9)
  })

  it('keeps what he typed, and what the machine said for every caption made of whole old ones', () => {
    const before = run()
    // He retyped "store" as "shop" on whichever caption holds it.
    const at = before.findIndex((c) => c.title!.text.split(' ').includes('store'))
    before[at] = { ...before[at]!, title: { ...before[at]!.title!, text: before[at]!.title!.text.replace('store', 'shop') } }
    // Small letters: a 60 letter line only fits across the frame at about 28 px,
    // and a caption never holds more than fits (CA-4).
    const after = recutCaptions(
      before,
      style({ shape: fixed({ maxWords: 12, charsPerLine: 60 }), look: { fontSizePx: 28 }, refHeight: 1920 }),
      seq,
    )
    expect(after.map((c) => c.title!.text).join(' ')).toContain('the shop and')
    const origins = after.map((c) => c.captionOrigin)
    expect(origins.every((o) => o?.model === 'whisper-small')).toBe(true)
    expect(origins.map((o) => o!.text).join(' ')).toBe(before.map((c) => c.captionOrigin!.text).join(' '))
  })

  it('cut twice at the same length lands the same captions, not ones that creep later', () => {
    const s = style({ shape: fixed({ maxWords: 3, charsPerLine: 40 }) })
    const once = recutCaptions(run(), s, seq)
    const twice = recutCaptions(once, s, seq)
    expect(twice.map((c) => c.title!.text)).toEqual(once.map((c) => c.title!.text))
    twice.forEach((c, i) => expect(c.startS).toBeCloseTo(once[i]!.startS, 6))
  })
})

describe('shapes', () => {
  it('cleans anything stored into something safe', () => {
    expect(cleanShape({ length: 'weird', maxWords: 99, lines: 3, minDurS: -1, gapFrames: 1e6 })).toEqual({
      ...AUTO_SHAPE,
      maxWords: 12,
      minDurS: 0.1,
      gapFrames: 30,
    })
  })

  it('compares only what changes the cut', () => {
    expect(sameShape(AUTO_SHAPE, { ...AUTO_SHAPE, maxWords: 7 })).toBe(true)
    expect(sameShape(fixed({ maxWords: 3 }), fixed({ maxWords: 4 }))).toBe(false)
    expect(sameShape(AUTO_SHAPE, { ...AUTO_SHAPE, gapFrames: 2 })).toBe(false)
  })
})

describe('a look saved before caption styles existed', () => {
  const legacy = {
    id: 'tp-0-0',
    name: 'Style 1',
    style: { fontSizePx: 140, color: '#ff0000', outline: { color: '#000000', widthPx: 20 }, textCase: 'lower' as const },
    appearance: { in: 'pop', durS: 0.15 },
  }

  it('keeps its id, its name, the auto cut and its absolute sizes', () => {
    const s = styleFromLegacyPreset(legacy, 5)!
    expect(s).toMatchObject({ id: 'tp-0-0', name: 'Style 1', shape: AUTO_SHAPE, updatedAt: 5 })
    expect(s.refHeight).toBeUndefined()
    // Absolute, exactly as it always was: no height to scale from.
    expect(captionDefFor(s, 'x', 1080).fontSizePx).toBe(140)
  })

  it('makes exactly the caption the old preset made', () => {
    const s = styleFromLegacyPreset(legacy, 5)!
    const fresh = newTitleClip(jettismCaptionDef('hello', 1920), 0, 0.5)
    const old: TitleDef = { ...fresh.title!, ...legacy.style }
    expect(dressCaption(fresh, s, 1080, 1920).title).toEqual(old)
  })
})

// ⛔ CA-4. The 14 letter cap was measured for lowercase house captions on a
// 1080x1920 frame. Measured on the shipped Montserrat at the weight bold draws:
// "something else" is 846 px lowercase and 977 px UPPERCASE, against a 950 px
// line. A caption that does not fit wraps onto two lines, or past the frame.
describe('a caption holds only what fits across the frame', () => {
  const SHORT = { width: 1080, height: 1920, fps: 30 }
  const PHONE = { width: 1080, height: 2112, fps: 30 }
  const YELLOW = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-yellow-pop')!
  const cut = (style: CaptionStyle, words: CaptionWord[], seq = SHORT): string[] =>
    chunkWords(words, chunkOptionsFor(style.shape, seq.fps, captionFitterFor(style, seq, captionHouseCase))).map((c) => c.text)
  const pair = said('something else', 0, 0.2)

  it('the house style keeps a pair that fits', () => {
    expect(cut(HOUSE, pair)).toEqual(['something else'])
  })

  it('an UPPERCASE style splits a pair that would wrap', () => {
    expect(cut(YELLOW, pair)).toEqual(['something', 'else'])
  })

  it('a bigger style puts one word in each caption', () => {
    const big: CaptionStyle = { ...HOUSE, id: 'big', builtin: false, look: { fontSizePx: 160 }, refHeight: 1920 }
    expect(cut(big, said('diamonds now', 0, 0.2))).toEqual(['diamonds', 'now'])
  })

  it('a lowercase pair wider than the line is split too', () => {
    // "awesome moment" is 14 letters, inside the old cap, and 1034 px wide.
    expect(cut(HOUSE, said('awesome moment', 0, 0.2))).toEqual(['awesome', 'moment'])
  })

  it('one word too wide for the line is drawn smaller, inside the frame', () => {
    const clip = newTitleClip(jettismCaptionDef('extraordinary', PHONE.height), 0, 1)
    const dressed = dressCaption(clip, YELLOW, PHONE.width, PHONE.height)
    const def = dressed.title!
    expect(captionTextWidthPx('EXTRAORDINARY', def.fontSizePx)).toBeLessThanOrEqual(captionLineWidthPx(PHONE.width))
    expect(def.fontSizePx).toBeLessThan(captionDefFor(YELLOW, 'extraordinary', PHONE.height).fontSizePx)
    // A word that fits keeps the style's size.
    const short = dressCaption(newTitleClip(jettismCaptionDef('diamonds', PHONE.height), 0, 1), YELLOW, PHONE.width, PHONE.height)
    expect(short.title!.fontSizePx).toBe(captionDefFor(YELLOW, 'diamonds', PHONE.height).fontSizePx)
  })
})

// The Oveon style, 2026-10-12: his ask was to copy Oveon's captions exactly, and
// every number below was measured off the frames of one of Oveon's own Shorts.
describe('the Oveon style', () => {
  const SHORT = { width: 1080, height: 1920, fps: 30 }
  const OVEON = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-oveon')!
  const dressed = (text: string): TitleDef =>
    dressCaption(newTitleClip(jettismCaptionDef(text, SHORT.height), 0, 1), OVEON, SHORT.width, SHORT.height).title!

  it('is Lilita One, white, a black outline, no shadow or box, centred on the frame', () => {
    const def = captionDefFor(OVEON, 'more', SHORT.height)
    expect(def.fontFamily).toBe(COMIC_STACK)
    expect(def.fontSizePx).toBe(218)
    // One weight only: 700 would draw a fake bold.
    expect(def.bold).toBe(false)
    expect(def.color).toBe('#ffffff')
    expect(def.outline).toEqual({ color: '#000000', widthPx: 25 })
    expect(def.shadow).toBeUndefined()
    expect(def.box).toBeUndefined()
    expect(def.textCase).toBeUndefined()
    expect([def.align, def.vAlign, def.offsetYPx]).toEqual(['center', 'middle', 0])
  })

  it('puts one word in each caption, in the case it was said', () => {
    const words = said('Everybody is here', 0, 0.3)
    expect(chunkWords(words, chunkOptionsFor(OVEON.shape, SHORT.fps, captionFitterFor(OVEON, SHORT)))).toHaveLength(3)
    expect(OVEON.caseRule).toBe('spoken')
  })

  it('pops in on the house pop and cuts straight out', () => {
    const clip = dressCaption(newTitleClip(jettismCaptionDef('more', SHORT.height), 0, 1), OVEON, SHORT.width, SHORT.height)
    expect(clip.appearance).toEqual({ in: 'pop', durS: CAPTION_POP_DUR_S })
  })

  it('draws a short word at full size and a long one just small enough to fit', () => {
    expect(dressed('more').fontSizePx).toBe(218)
    const long = dressed('Everybody')
    // Lilita's own widths: about 207, where Montserrat's would have shrunk it to about 170.
    expect(long.fontSizePx).toBeGreaterThan(200)
    expect(long.fontSizePx).toBeLessThan(218)
    expect(captionTextWidthPx('Everybody', long.fontSizePx, long.fontFamily)).toBeLessThanOrEqual(captionLineWidthPx(SHORT.width))
  })
})

// The Word box style, 2026-10-19: his ask was to copy the captions of a frame he
// sent, white capitals three at a time with a rounded crimson box on the word
// being said, and to have the box as an option on any style.
describe('the Word box style', () => {
  const SHORT = { width: 1080, height: 1920, fps: 30 }
  const WORD_BOX = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-word-box')!
  const BOX = { color: 'rgba(55,6,16,0.8)', borderColor: '#C02749' }

  it('is built in, named Word box, and cannot be edited in place', () => {
    expect(WORD_BOX).toBeDefined()
    expect(WORD_BOX.name).toBe('Word box')
    expect(WORD_BOX.builtin).toBe(true)
  })

  it('is white capitals in Oswald with a dark outline, no shadow or background, and the crimson box', () => {
    const def = captionDefFor(WORD_BOX, 'awake', SHORT.height)
    expect(def.fontFamily).toBe(OSWALD_STACK)
    expect(def.bold).toBe(true)
    expect(def.color).toBe('#ffffff')
    expect(def.textCase).toBe('upper')
    expect(def.outline).toEqual({ color: '#000000', widthPx: 13 })
    expect(def.shadow).toBeUndefined()
    expect(def.box).toBeUndefined()
    expect(def.wordBox).toEqual(BOX)
    expect([def.align, def.vAlign, def.offsetYPx]).toEqual(['center', 'middle', 0])
  })

  it('puts three words on the screen at a time, on one line', () => {
    expect(WORD_BOX.shape).toMatchObject({ length: 'fixed', maxWords: 3, lines: 1 })
    const words = said("awake doesn't really mean what you think", 0, 0.3)
    const chunks = chunkWords(words, chunkOptionsFor(WORD_BOX.shape, SHORT.fps, captionFitterFor(WORD_BOX, SHORT, captionHouseCase)))
    expect(wordsIn(chunks)).toEqual(words.map((w) => w.text))
    expect(chunks.every((c) => c.text.split(/\s+/).length <= 3)).toBe(true)
    expect(chunks[0]!.text).toBe("awake doesn't really")
  })

  // Oswald is condensed (captionFit.ts has its own widths for it). Measured with
  // Montserrat's widths a run like "awake doesn't really" read 1216 px against a
  // 950 px line, and the style's three words were cut to two on a 1080x1920 Short.
  describe('keeps three words a caption on a tall frame', () => {
    const PHONE = { width: 1080, height: 2112, fps: 30 }
    const cut = (text: string, seq = SHORT): string[] =>
      chunkWords(
        said(text, 0, 0.3),
        chunkOptionsFor(WORD_BOX.shape, seq.fps, captionFitterFor(WORD_BOX, seq, captionHouseCase)),
      ).map((c) => c.text)
    // Each of these is wider than the line in Montserrat's widths and narrower in Oswald's.
    const BOTH = ["they didn't believe", 'most people never', 'people never realize']
    const SHORT_ONLY = ["awake doesn't really", 'everybody knows that']

    it('on the 1080x1920 Short, for ordinary words', () => {
      for (const run of [...BOTH, ...SHORT_ONLY]) expect(cut(run), run).toEqual([run])
      expect(cut('so i went to the store and then home')).toEqual(['so i went', 'to the store', 'and then home'])
    })

    it('on the Phone frame, which draws the font bigger in the same width', () => {
      for (const run of BOTH) expect(cut(run, PHONE), run).toEqual([run])
      expect(cut('so i went to the store and then home', PHONE)).toEqual(['so i went', 'to the store', 'and then home'])
    })

    it('still cuts a run that is really too wide for the line', () => {
      // 987 px at the Short size and 1085 px on the Phone frame, against 950.
      expect(cut('something else entirely')).toEqual(['something else', 'entirely'])
      expect(cut('something else entirely', PHONE)).toEqual(['something else', 'entirely'])
    })
  })

  it('dresses a caption with the box colours and keeps the words he said', () => {
    const plain = newTitleClip(jettismCaptionDef("awake doesn't really", SHORT.height), 0, 1)
    const spoken = said("awake doesn't really", 0, 0.3).map(({ text, startS, endS }) => ({ text, startS, endS }))
    const clip: Clip = { ...plain, captionWords: spoken }
    const out = dressCaption(clip, WORD_BOX, SHORT.width, SHORT.height)
    expect(out.title!.wordBox).toEqual(BOX)
    expect(out.captionWords).toEqual(clip.captionWords)
    // What is stored is the colours only: which word is boxed is worked out per frame.
    expect(out.title!.boxWord).toBeUndefined()
  })

  it('scales its text with the frame and leaves the box colours alone', () => {
    const small = captionDefFor(WORD_BOX, 'x', 1080)
    expect(small.fontSizePx).toBe(51)
    expect(small.wordBox).toEqual(BOX)
  })

  it('is the only built in with a box: every other style draws exactly as it did', () => {
    for (const s of BUILTIN_CAPTION_STYLES) {
      if (s.id === WORD_BOX.id) continue
      expect(captionDefFor(s, 'x', 1920).wordBox).toBeUndefined()
    }
  })
})

describe('the word box in a saved look', () => {
  const BOX = { color: 'rgba(10,20,30,0.5)', borderColor: '#336699' }

  it('round trips through lookOfTitle, a save and cleanStyle', () => {
    const def: TitleDef = { ...jettismCaptionDef('x', 1920), wordBox: BOX }
    const look = lookOfTitle(def)
    expect(look.wordBox).toEqual(BOX)
    // A copy, not the title's own object.
    expect(look.wordBox).not.toBe(BOX)
    const saved = JSON.parse(JSON.stringify(style({ look, refHeight: 1920 }))) as CaptionStyle
    expect(captionDefFor(cleanStyle(saved)!, 'x', 1920)).toEqual(def)
  })

  it('writes a title with no box as null, so the box stays off after a save', () => {
    const def: TitleDef = { ...jettismCaptionDef('x', 1920) }
    expect(lookOfTitle(def).wordBox).toBeNull()
    const saved = JSON.parse(JSON.stringify(style({ look: lookOfTitle(def), refHeight: 1920 }))) as CaptionStyle
    expect(captionDefFor(cleanStyle(saved)!, 'x', 1920).wordBox).toBeUndefined()
    expect('wordBox' in captionDefFor(cleanStyle(saved)!, 'x', 1920)).toBe(false)
  })

  it('takes a box away that the caption had, when the style says none', () => {
    const boxed = dressCaption(newTitleClip({ ...jettismCaptionDef('x', 1920), wordBox: BOX }, 0, 1), style({ look: { wordBox: BOX } }), 1080, 1920)
    expect(boxed.title!.wordBox).toEqual(BOX)
    const off = dressCaption(boxed, style({ look: { wordBox: null } }), 1080, 1920)
    expect('wordBox' in off.title!).toBe(false)
  })

  it('a style that says nothing about the box leaves the house caption without one', () => {
    expect(captionDefFor(style({ look: { color: '#00ff00' } }), 'x', 1920).wordBox).toBeUndefined()
  })
})
