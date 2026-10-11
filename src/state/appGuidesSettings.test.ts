// @vitest-environment jsdom
//
// The TikTok / Reels guides stay the way he left them, like safe margins do.

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  localStorage.clear()
  vi.resetModules()
})

const restart = async () => (await import('./settings')).useSettings.getState()

describe('app guides', () => {
  it('start off, for TikTok, on a fresh profile', async () => {
    const s = await restart()
    expect(s.appGuides).toBe(false)
    expect(s.appGuidesApp).toBe('tiktok')
  })

  it('are still on, for the app he picked, after a restart', async () => {
    const { setAppGuides, setAppGuidesApp } = await import('./settings')
    setAppGuides(true)
    setAppGuidesApp('reels')
    vi.resetModules()
    const s = await restart()
    expect(s.appGuides).toBe(true)
    expect(s.appGuidesApp).toBe('reels')
  })

  it('go back to the defaults once he turns them off and picks TikTok', async () => {
    const { setAppGuides, setAppGuidesApp } = await import('./settings')
    setAppGuides(true)
    setAppGuidesApp('reels')
    setAppGuides(false)
    setAppGuidesApp('tiktok')
    expect(localStorage.getItem('olpremiere:settings:app-guides')).toBeNull()
    expect(localStorage.getItem('olpremiere:settings:app-guides-app')).toBeNull()
    vi.resetModules()
    const s = await restart()
    expect(s.appGuides).toBe(false)
    expect(s.appGuidesApp).toBe('tiktok')
  })

  it('travel with his other settings in their file, and come back with reloadSettings', async () => {
    const { PREFS_KEYS } = await import('./prefsHome')
    expect(PREFS_KEYS).toContain('olpremiere:settings:app-guides')
    expect(PREFS_KEYS).toContain('olpremiere:settings:app-guides-app')
    const { reloadSettings, useSettings } = await import('./settings')
    localStorage.setItem('olpremiere:settings:app-guides', 'on')
    localStorage.setItem('olpremiere:settings:app-guides-app', 'reels')
    reloadSettings()
    expect(useSettings.getState().appGuides).toBe(true)
    expect(useSettings.getState().appGuidesApp).toBe('reels')
  })
})
