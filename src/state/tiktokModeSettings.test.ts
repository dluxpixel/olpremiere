// @vitest-environment jsdom
//
// TikTok text mode is a switch he chooses, and it stays the way he left it, like the app guides.
// Turning it on never touches his own guides choice.

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  localStorage.clear()
  vi.resetModules()
})

const restart = async () => (await import('./settings')).useSettings.getState()

describe('TikTok text mode setting', () => {
  it('starts off on a fresh profile', async () => {
    expect((await restart()).tiktokMode).toBe(false)
  })

  it('is still on after a restart, under its own key', async () => {
    const { setTiktokMode } = await import('./settings')
    setTiktokMode(true)
    expect(localStorage.getItem('olpremiere:settings:tiktok-mode')).toBe('on')
    vi.resetModules()
    expect((await restart()).tiktokMode).toBe(true)
  })

  it('goes back to the stored default once he turns it off', async () => {
    const { setTiktokMode } = await import('./settings')
    setTiktokMode(true)
    setTiktokMode(false)
    expect(localStorage.getItem('olpremiere:settings:tiktok-mode')).toBeNull()
    vi.resetModules()
    expect((await restart()).tiktokMode).toBe(false)
  })

  it('travels with his other settings in their file, and comes back with reloadSettings', async () => {
    const { PREFS_KEYS } = await import('./prefsHome')
    expect(PREFS_KEYS).toContain('olpremiere:settings:tiktok-mode')
    const { reloadSettings, useSettings } = await import('./settings')
    localStorage.setItem('olpremiere:settings:tiktok-mode', 'on')
    reloadSettings()
    expect(useSettings.getState().tiktokMode).toBe(true)
  })

  it('does not overwrite his saved guides choice, on or off', async () => {
    const { setTiktokMode, setAppGuides, setAppGuidesApp, useSettings } = await import('./settings')
    setTiktokMode(true)
    expect(useSettings.getState().appGuides).toBe(false)
    expect(localStorage.getItem('olpremiere:settings:app-guides')).toBeNull()
    setAppGuides(true)
    setAppGuidesApp('reels')
    setTiktokMode(false)
    setTiktokMode(true)
    expect(useSettings.getState().appGuides).toBe(true)
    expect(useSettings.getState().appGuidesApp).toBe('reels')
    expect(localStorage.getItem('olpremiere:settings:app-guides-app')).toBe('reels')
  })
})
