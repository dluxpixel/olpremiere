// Caption styles, the pure half: how a style's length cuts words, how its look
// dresses a caption, and that a look saved before styles existed still makes
// exactly the captions it made then.

import { describe, expect, it } from 'vitest'
import { newTitleClip, type Clip, type TitleDef } from '../types'
import {
  AUTO_CAPTION_OPTIONS,
  captionClips,
  chunkWords,
  jettismCaptionDef,
  type CaptionWord,
} from './captions'
import {
  AUTO_SHAPE,
  BUILTIN_CAPTION_STYLES,
  breakLines,
  captionDefFor,
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
  it('cuts exactly what every caption run has cut since the length was measured', () => {
    const words = [...said('so i went to the store and bought some apples'), ...said('then i came home', 3)]
    expect(chunkWords(words, chunkOptionsFor(AUTO_SHAPE, 30))).toEqual(chunkWords(words, AUTO_CAPTION_OPTIONS))
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
    const after = recutCaptions(before, style({ shape: fixed({ maxWords: 12, charsPerLine: 60 }) }), seq)
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
