// The picker's frame shapes. The new one is the phone screen shape (his ask, 2026-10-05), and
// the three that were there before must come out exactly as they were: old projects and YouTube
// Shorts still use 9:16.

import { describe, expect, it } from 'vitest'
import { CUSTOM_FORMAT_KEY, FORMAT_OPTIONS, FORMATS, aspectKeyFor, startFrame } from './frameFormats'

const byKey = (key: string) => FORMATS.find((f) => f.key === key)!

describe('the frame shapes', () => {
  it('keeps 16:9 Wide, 9:16 Shorts and 1:1 Square exactly as they were', () => {
    expect(byKey('16:9')).toMatchObject({ short: '16:9', label: '16:9 Wide', w: 1920, h: 1080 })
    expect(byKey('9:16')).toMatchObject({ short: '9:16', label: '9:16 Shorts', w: 1080, h: 1920 })
    expect(byKey('1:1')).toMatchObject({ short: '1:1', label: '1:1 Square', w: 1080, h: 1080 })
  })

  it('adds the phone screen shape, 1080 x 2112, right after 9:16 Shorts', () => {
    expect(FORMATS.map((f) => f.key)).toEqual(['16:9', '9:16', 'phone', '1:1'])
    expect(byKey('phone')).toMatchObject({
      short: 'Phone',
      label: 'Phone screen: TikTok and Reels',
      w: 1080,
      h: 2112,
    })
  })

  it('says the short name on the closed select and the full one in the list', () => {
    expect(FORMAT_OPTIONS.map((o) => [o.value, o.short, o.long])).toEqual([
      ['16:9', '16:9', '16:9 Wide'],
      ['9:16', '9:16', '9:16 Shorts'],
      ['phone', 'Phone', 'Phone screen: TikTok and Reels'],
      ['1:1', '1:1', '1:1 Square'],
    ])
  })

  it('keeps the closed select as compact as it was: no short name longer than five characters', () => {
    // His ask, 2026-10-04: no blank space in the bar. The select is as wide as its short label.
    for (const f of FORMATS) expect(f.short.length, f.key).toBeLessThanOrEqual(5)
    expect(byKey('phone').short).toBe('Phone')
  })

  it('has even sides on every shape, which yuv420p needs for the export', () => {
    for (const f of FORMATS) {
      expect(f.w % 2, `${f.key} width`).toBe(0)
      expect(f.h % 2, `${f.key} height`).toBe(0)
    }
  })

  it('has a different key and a different shape for each one', () => {
    expect(new Set(FORMATS.map((f) => f.key)).size).toBe(FORMATS.length)
    expect(new Set(FORMATS.map((f) => (f.w / f.h).toFixed(5))).size).toBe(FORMATS.length)
  })

  it('makes the phone shape the one TikTok and Reels play in, which is what he measured', () => {
    // iPhone screen 1179 x 2556, minus the 83 pt (249 px) bottom bar: 1179 x 2307.
    const area = 1179 / (2556 - 83 * 3)
    const phone = byKey('phone')
    const ratio = phone.w / phone.h
    expect(area).toBeCloseTo(0.5111, 4)
    expect(Math.abs(ratio - area)).toBeLessThan(0.001)
    // Across current iPhones the area runs 0.504 to 0.5125, and this sits inside all of it.
    expect(ratio).toBeGreaterThan(0.504)
    expect(ratio).toBeLessThan(0.5125)
    // 1080 wide asks for 2113.3 tall. 2112 is within two pixels of that and is a whole 132 rows of 16.
    expect(Math.abs(phone.h - phone.w / area)).toBeLessThan(2)
    expect(phone.h % 16).toBe(0)
  })
})

describe('aspectKeyFor', () => {
  it('names each preset by its own size', () => {
    for (const f of FORMATS) expect(aspectKeyFor(f.w, f.h), f.key).toBe(f.key)
  })

  it('reads 1080 x 2112 as the phone shape, and 1080 x 1920 as 9:16 still', () => {
    expect(aspectKeyFor(1080, 2112)).toBe('phone')
    expect(aspectKeyFor(1080, 1920)).toBe('9:16')
  })

  it('goes by the shape, so a smaller or bigger copy of it reads the same', () => {
    expect(aspectKeyFor(540, 1056)).toBe('phone')
    expect(aspectKeyFor(720, 1408)).toBe('phone')
    expect(aspectKeyFor(1440, 2816)).toBe('phone')
    expect(aspectKeyFor(720, 1280)).toBe('9:16')
  })

  it('never mistakes the phone shape for the Shorts shape or the other way round', () => {
    // Half a percent apart is plenty: 0.5114 against 0.5625.
    expect(aspectKeyFor(1080, 2112)).not.toBe('9:16')
    expect(aspectKeyFor(1080, 1920)).not.toBe('phone')
  })

  it('calls a shape no preset covers custom, so the picker shows its size and cannot pick it', () => {
    expect(aspectKeyFor(1080, 1350)).toBe(CUSTOM_FORMAT_KEY) // 4:5
    expect(aspectKeyFor(1080, 2160)).toBe(CUSTOM_FORMAT_KEY) // 1:2, close to the phone shape but not it
    expect(aspectKeyFor(1080, 2400)).toBe(CUSTOM_FORMAT_KEY) // a taller phone
    expect(aspectKeyFor(0, 0)).toBe(CUSTOM_FORMAT_KEY)
    expect(aspectKeyFor(1080, 0)).toBe(CUSTOM_FORMAT_KEY)
    expect(aspectKeyFor(Number.NaN, 1920)).toBe(CUSTOM_FORMAT_KEY)
  })
})

describe('the shape a new project starts in', () => {
  it('a plain new project is 16:9 Wide, as it always was', () => {
    expect(startFrame('wide')).toEqual({ w: 1920, h: 1080 })
    expect(aspectKeyFor(startFrame('wide').w, startFrame('wide').h)).toBe('16:9')
  })

  it('a Shorts project is the phone screen shape, the one TikTok and Reels play', () => {
    expect(startFrame('shorts')).toEqual({ w: 1080, h: 2112 })
    expect(aspectKeyFor(startFrame('shorts').w, startFrame('shorts').h)).toBe('phone')
  })

  it('is always one of the shapes the picker offers, so the select reads true', () => {
    for (const start of ['wide', 'shorts'] as const) {
      const { w, h } = startFrame(start)
      expect(aspectKeyFor(w, h)).not.toBe(CUSTOM_FORMAT_KEY)
    }
  })
})
