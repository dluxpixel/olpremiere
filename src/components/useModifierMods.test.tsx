/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeLanesEl } from './timelineDomFixtures'
import { useModifierMods } from './useModifierMods'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const key = (type: 'keydown' | 'keyup', mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) =>
  window.dispatchEvent(new KeyboardEvent(type, mods))

describe('useModifierMods', () => {
  it('writes the held modifiers onto the lanes and clears them on release', () => {
    const el = makeLanesEl()
    const lanesRef = { current: el }
    renderHook(() => useModifierMods(lanesRef))
    key('keydown', { altKey: true })
    expect(el.dataset.mods).toBe('alt')
    key('keydown', { altKey: true, ctrlKey: true })
    expect(el.dataset.mods).toBe('ctrl-alt')
    key('keydown', { metaKey: true })
    expect(el.dataset.mods).toBe('ctrl')
    key('keyup', {})
    expect(el.dataset.mods).toBeUndefined()
  })

  it('clears on window blur, where Alt+Tab steals the keyup', () => {
    const el = makeLanesEl()
    const lanesRef = { current: el }
    renderHook(() => useModifierMods(lanesRef))
    key('keydown', { altKey: true })
    window.dispatchEvent(new Event('blur'))
    expect(el.dataset.mods).toBeUndefined()
  })

  it('stops listening on unmount', () => {
    const el = makeLanesEl()
    const lanesRef = { current: el }
    const { unmount } = renderHook(() => useModifierMods(lanesRef))
    unmount()
    key('keydown', { altKey: true })
    expect(el.dataset.mods).toBeUndefined()
  })
})
