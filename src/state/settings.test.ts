/**
 * @vitest-environment jsdom
 *
 * jsdom for localStorage and the theme attribute on <html>.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ARTISTIC_THEMES, EASE_SECONDS, reloadSettings, setEaseSeconds, setTheme, useSettings } from './settings'

const DEFAULT = 0.5

const THEME_KEY = 'olpremiere:settings:theme'

afterEach(() => {
  setEaseSeconds(DEFAULT)
  setTheme('dark')
})

describe('ease length', () => {
  it('starts at half a second', () => {
    expect(useSettings.getState().easeSeconds).toBe(DEFAULT)
  })

  it('keeps the length he dialled in', () => {
    // The point of the whole setting: the ease row used to be component state,
    // so this number died with the card the moment he clicked the next clip.
    setEaseSeconds(1.25)
    expect(useSettings.getState().easeSeconds).toBe(1.25)
  })

  it('holds it inside the field envelope', () => {
    setEaseSeconds(999)
    expect(useSettings.getState().easeSeconds).toBe(EASE_SECONDS.max)
    setEaseSeconds(0)
    expect(useSettings.getState().easeSeconds).toBe(EASE_SECONDS.min)
    setEaseSeconds(-3)
    expect(useSettings.getState().easeSeconds).toBe(EASE_SECONDS.min)
  })

  it('ignores a value that is not a number', () => {
    setEaseSeconds(2)
    setEaseSeconds(Number.NaN)
    expect(useSettings.getState().easeSeconds).toBe(DEFAULT)
  })
})

// His ask, 2026-10-12: "make some themes that just look really beautiful, not
// professional". Five artistic themes joined Dark, Light and Claude, each one a
// data-theme block in index.css, so each has to survive a restart and reach <html>.
describe('the artistic themes', () => {
  it('are exactly the five he was promised', () => {
    expect([...ARTISTIC_THEMES]).toEqual(['snow', 'graffiti', 'sakura', 'aurora', 'sunset'])
  })

  for (const name of ARTISTIC_THEMES) {
    it(`${name} loads back from storage and sets data-theme`, () => {
      localStorage.setItem(THEME_KEY, name)
      reloadSettings()
      expect(useSettings.getState().theme).toBe(name)
      expect(document.documentElement.dataset.theme).toBe(name)
    })

    it(`${name} is saved when he picks it, and dark takes it back off`, () => {
      setTheme(name)
      expect(localStorage.getItem(THEME_KEY)).toBe(name)
      expect(document.documentElement.dataset.theme).toBe(name)
      setTheme('dark')
      expect(localStorage.getItem(THEME_KEY)).toBeNull()
      expect(document.documentElement.dataset.theme).toBeUndefined()
    })
  }

  it('falls back to dark for a name that is not a theme', () => {
    localStorage.setItem(THEME_KEY, 'neon')
    reloadSettings()
    expect(useSettings.getState().theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('keeps light and claude working beside them', () => {
    for (const name of ['light', 'claude'] as const) {
      localStorage.setItem(THEME_KEY, name)
      reloadSettings()
      expect(useSettings.getState().theme).toBe(name)
      expect(document.documentElement.dataset.theme).toBe(name)
    }
  })
})
