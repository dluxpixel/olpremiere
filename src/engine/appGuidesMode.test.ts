import { describe, expect, it } from 'vitest'
import { effectiveAppGuides } from './appGuides'

// TikTok text mode shows the TikTok guides without touching his own guides choice: what is on
// screen is his setting OR the mode, and the app is TikTok while the mode is on.

describe('effectiveAppGuides', () => {
  it('follows his own setting alone while the mode is off', () => {
    expect(effectiveAppGuides(false, 'tiktok', false)).toEqual({ show: false, app: 'tiktok' })
    expect(effectiveAppGuides(true, 'reels', false)).toEqual({ show: true, app: 'reels' })
  })

  it('shows the guides when the mode is on even though his setting is off', () => {
    expect(effectiveAppGuides(false, 'tiktok', true)).toEqual({ show: true, app: 'tiktok' })
  })

  it('is TikTok while the mode is on, even if he picked Reels for his own guides', () => {
    expect(effectiveAppGuides(true, 'reels', true)).toEqual({ show: true, app: 'tiktok' })
    expect(effectiveAppGuides(false, 'reels', true)).toEqual({ show: true, app: 'tiktok' })
  })
})
