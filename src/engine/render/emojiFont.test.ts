import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { appleEmojiFor, EMOJI_FACE_JOINS_SEQUENCES, EMOJI_STACK, EMOJI_UNICODE_RANGE, emojiFontAvailable, hasEmoji } from './emojiFont'
import { titleFontStacksIn } from './titleFonts'

// His ask, 2026-09-28: *"make it so when I play, paste in emojis, it's the
// Apple emojis."*

/** Does a unicode-range string cover this code point? */
function covers(range: string, cp: number): boolean {
  return range.split(',').some((part) => {
    const [a, b] = part.trim().replace('U+', '').split('-')
    const lo = parseInt(a!, 16)
    const hi = b ? parseInt(b, 16) : lo
    return cp >= lo && cp <= hi
  })
}

describe('hasEmoji', () => {
  it('finds the emoji he pastes, alone or in a caption', () => {
    for (const t of ['😂', 'no way 💀', '🔥🔥', '❤️', '👍🏽', '🇨🇿', '🫠']) expect(hasEmoji(t)).toBe(true)
  })

  it('leaves plain captions alone, numbers and Czech included', () => {
    for (const t of ['', 'Big 1 day!', 'Příliš žluťoučký kůň', '100%', '#1 tip', undefined]) expect(hasEmoji(t)).toBe(false)
  })
})

describe('the Apple face answers for emoji only', () => {
  it('covers the emoji and the joiners that hold a combined emoji together', () => {
    for (const ch of ['😂', '🔥', '💀', '❤', '🫠', '🇨']) expect(covers(EMOJI_UNICODE_RANGE, ch.codePointAt(0)!)).toBe(true)
    for (const cp of [0x200d, 0xfe0f, 0x20e3, 0x1f3fd]) expect(covers(EMOJI_UNICODE_RANGE, cp)).toBe(true)
  })

  it('never takes letters, digits, # or *, so his text keeps its own font', () => {
    const text = 'AZaz09#*!?.,:; ĚŠČŘŽÝÁÍÉŮÚ©®'
    for (const ch of text) expect(covers(EMOJI_UNICODE_RANGE, ch.codePointAt(0)!)).toBe(false)
  })
})

describe('appleEmojiFor', () => {
  it('uses the Apple face for the emoji he pastes', () => {
    for (const t of ['so good 😭', '😂🔥💀', '❤️ love it', '✨ new ✨', 'plain text']) expect(appleEmojiFor(t)).toBe(true)
  })

  it('keeps the system emoji for what the fetched copy cannot put together, so nothing comes out split', () => {
    expect(EMOJI_FACE_JOINS_SEQUENCES).toBe(false)
    for (const t of ['👍🏽', '💪🏻 day', '👨‍👩‍👧', '❤️‍🔥', '🇨🇿', '1️⃣']) expect(appleEmojiFor(t)).toBe(false)
  })
})

describe('loading it', () => {
  const seq = (text: string) => ({ tracks: [{ clips: [{ title: { fontFamily: "'TikTok Sans', sans-serif", text } }] }] })

  it('the export worker is told to load it when a title has an emoji', () => {
    expect(titleFontStacksIn(seq('so good 😭'))).toContain(EMOJI_STACK)
  })

  it('and only then', () => {
    expect(titleFontStacksIn(seq('so good'))).not.toContain(EMOJI_STACK)
  })

  it('is never tried outside the desktop app, which is where it is fetched from', () => {
    expect(emojiFontAvailable()).toBe(false)
  })

  it('goes in front of the title font in the one place the font string is built', () => {
    const src = readFileSync(fileURLToPath(new URL('./titleRaster.ts', import.meta.url)), 'utf8')
    expect(src).toContain('${EMOJI_STACK}, ${def.fontFamily}')
  })
})
