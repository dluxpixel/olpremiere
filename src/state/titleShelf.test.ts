// Every title on the shelf must be a title the app can actually make: a real
// entrance and exit, a size on the Inspector's ladder, its own text, and the
// keyframes compiled the way every other title compiles them.

import { describe, expect, it } from 'vitest'
import { applyAppearanceToClip, isEntranceId, isExitId } from '../engine/anim/appearance'
import { defaultTitleDef, newTitleClip } from '../engine/types'
import { bundledFontForStack, TIKTOK_SANS_STACK } from '../engine/render/titleFonts'
import { tiktokLineBox } from '../engine/render/lineBox'
import { TITLE_SHELF, titleLookById, titleLooksInGroup } from './titleShelf'

describe('the title shelf', () => {
  it('has unique ids and a starting text on every look', () => {
    const ids = TITLE_SHELF.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const l of TITLE_SHELF) {
      expect(l.text.trim().length).toBeGreaterThan(0)
      expect(l.name.trim().length).toBeGreaterThan(0)
      expect(l.hint.trim().length).toBeGreaterThan(0)
      expect(l.durationS).toBeGreaterThan(0)
    }
  })

  it('moves with an entrance and an exit that exist', () => {
    for (const l of TITLE_SHELF) {
      expect(isEntranceId(l.appearance.in), l.id).toBe(true)
      expect(isExitId(l.appearance.out), l.id).toBe(true)
    }
  })

  it('sizes type on the ladder the Inspector uses', () => {
    for (const l of TITLE_SHELF) {
      const size = l.style.fontSizePx ?? defaultTitleDef().fontSizePx
      expect(size, l.id).toBeGreaterThanOrEqual(40)
      expect(size, l.id).toBeLessThanOrEqual(240)
    }
  })

  it('compiles to a title clip with its text and keyframes on it', () => {
    for (const l of TITLE_SHELF) {
      const def = { ...defaultTitleDef(l.text), ...l.style }
      const clip = applyAppearanceToClip(newTitleClip(def, 0, l.durationS), l.appearance, 1080, 1920)
      expect(clip.title?.text).toBe(l.text)
      expect(Object.keys(clip.keyframes ?? {}).length, l.id).toBeGreaterThan(0)
    }
  })

  it('finds a look by id and nothing for a stranger', () => {
    expect(titleLookById('lower-third')?.name).toBe('Lower third')
    expect(titleLookById('nope')).toBeUndefined()
  })
})

// His ask: text that looks like the text TikTok's own app adds. Four looks in a
// group the shelf can show together, all in the bundled TikTok Sans.
describe('the TikTok looks', () => {
  const IDS = ['tiktok-plain', 'tiktok-outline', 'tiktok-highlight', 'tiktok-soft']
  const defOf = (id: string) => ({ ...defaultTitleDef(titleLookById(id)!.text), ...titleLookById(id)!.style })

  it('are four, named as asked, in one group no other look is in', () => {
    expect(IDS.map((id) => titleLookById(id)?.name)).toEqual(['TikTok', 'TikTok outline', 'TikTok highlight', 'TikTok soft'])
    expect(titleLooksInGroup('tiktok').map((l) => l.id)).toEqual(IDS)
    expect(TITLE_SHELF.filter((l) => l.group === 'tiktok')).toHaveLength(4)
    expect(TITLE_SHELF.filter((l) => !IDS.includes(l.id)).every((l) => l.group === undefined)).toBe(true)
  })

  it('use a font family the title fonts know, the bundled TikTok Sans, bold, centred at 64 px', () => {
    for (const id of IDS) {
      const style = titleLookById(id)!.style
      expect(style.fontFamily, id).toBe(TIKTOK_SANS_STACK)
      expect(bundledFontForStack(style.fontFamily!)?.family, id).toBe('TikTok Sans')
      expect(style.bold, id).toBe(true)
      expect(style.align, id).toBe('center')
      expect(style.fontSizePx, id).toBe(64)
    }
  })

  it('plain is white text with a soft dark shadow and nothing else', () => {
    const d = defOf('tiktok-plain')
    expect(d.color).toBe('#ffffff')
    expect(d.shadow?.color).toMatch(/^rgba\(0,\s*0,\s*0,/)
    expect(d.shadow!.blurPx).toBeGreaterThan(0)
    expect(d.outline).toBeUndefined()
    expect(d.lineBox).toBeUndefined()
    expect(d.box).toBeUndefined()
  })

  it('outline is white text with a black outline', () => {
    const d = defOf('tiktok-outline')
    expect(d.color).toBe('#ffffff')
    expect(d.outline).toEqual({ color: '#000000', widthPx: expect.any(Number) })
    expect(d.outline!.widthPx).toBeGreaterThan(0)
    expect(d.lineBox).toBeUndefined()
  })

  it('highlight is black text on a white line box at full opacity, at the shared TikTok measures', () => {
    const d = defOf('tiktok-highlight')
    expect(d.color).toBe('#000000')
    expect(d.lineBox).toEqual(tiktokLineBox('#ffffff', 1))
    expect(d.outline).toBeUndefined()
    expect(d.shadow).toBeUndefined()
  })

  it('soft is white text on a black line box at half opacity, at the shared TikTok measures', () => {
    const d = defOf('tiktok-soft')
    expect(d.color).toBe('#ffffff')
    expect(d.lineBox).toEqual(tiktokLineBox('#000000', 0.5))
    expect(d.outline).toBeUndefined()
    expect(d.shadow).toBeUndefined()
  })

  it('only the two highlight looks carry a line box, and each compiles to a title clip', () => {
    for (const id of IDS) {
      const l = titleLookById(id)!
      const clip = applyAppearanceToClip(newTitleClip(defOf(id), 0, l.durationS), l.appearance, 1080, 1920)
      expect(clip.title?.lineBox !== undefined, id).toBe(id === 'tiktok-highlight' || id === 'tiktok-soft')
      expect(Object.keys(clip.keyframes ?? {}).length, id).toBeGreaterThan(0)
    }
  })
})
