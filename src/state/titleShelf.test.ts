// Every title on the shelf must be a title the app can actually make: a real
// entrance and exit, a size on the Inspector's ladder, its own text, and the
// keyframes compiled the way every other title compiles them.

import { describe, expect, it } from 'vitest'
import { applyAppearanceToClip, isEntranceId, isExitId } from '../engine/anim/appearance'
import { defaultTitleDef, newTitleClip } from '../engine/types'
import { TITLE_SHELF, titleLookById } from './titleShelf'

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
