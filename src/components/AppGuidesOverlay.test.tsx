/**
 * @vitest-environment jsdom
 *
 * The guides over the monitor: his own choice, or TikTok text mode, whichever asks. A tall frame
 * only. A region turns to the danger colour while the selected title overlaps it.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppGuides, setAppGuidesApp, setTiktokMode } from '../state/settings'
import { AppGuidesOverlay, GuideHitsPublisher, ProgramAppGuides, useGuideHits } from './AppGuidesOverlay'

class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe() {
    this.cb()
  }
  unobserve() {}
  disconnect() {}
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.style.width = '270px'
  canvas.style.height = '480px'
  document.body.appendChild(canvas)
  return canvas
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  setAppGuides(false)
  setAppGuidesApp('tiktok')
  setTiktokMode(false)
  useGuideHits.setState({ hits: [] })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('ProgramAppGuides', () => {
  it('draws nothing while his guides and the mode are both off', () => {
    render(<ProgramAppGuides canvas={makeCanvas()} width={1080} height={1920} />)
    expect(screen.queryByTestId('app-guides')).toBeNull()
  })

  it('draws his own guides for the app he picked, with the mode off', () => {
    setAppGuides(true)
    setAppGuidesApp('reels')
    render(<ProgramAppGuides canvas={makeCanvas()} width={1080} height={1920} />)
    expect(screen.getByTestId('app-guides').getAttribute('data-app')).toBe('reels')
  })

  it('draws the TikTok guides when the mode is on and his own setting is off, and leaves his setting alone', async () => {
    const { useSettings } = await import('../state/settings')
    setTiktokMode(true)
    render(<ProgramAppGuides canvas={makeCanvas()} width={1080} height={1920} />)
    expect(screen.getByTestId('app-guides').getAttribute('data-app')).toBe('tiktok')
    expect(useSettings.getState().appGuides).toBe(false)
  })

  it('is TikTok while the mode is on, though he picked Reels', () => {
    setAppGuides(true)
    setAppGuidesApp('reels')
    setTiktokMode(true)
    render(<ProgramAppGuides canvas={makeCanvas()} width={1080} height={1920} />)
    expect(screen.getByTestId('app-guides').getAttribute('data-app')).toBe('tiktok')
  })

  it('draws nothing on a wide frame, mode or not', () => {
    setTiktokMode(true)
    render(<ProgramAppGuides canvas={makeCanvas()} width={1920} height={1080} />)
    expect(screen.queryByTestId('app-guides')).toBeNull()
  })

  it('tints the regions the title overlaps with the danger colour, only while the mode is on', () => {
    setTiktokMode(true)
    render(<ProgramAppGuides canvas={makeCanvas()} width={1080} height={1920} />)
    act(() => useGuideHits.setState({ hits: ['top', 'right'] }))
    expect(screen.getByTestId('app-guide-top').getAttribute('data-hit')).toBe('true')
    expect(screen.getByTestId('app-guide-top').className).toContain('danger')
    expect(screen.getByTestId('app-guide-right').getAttribute('data-hit')).toBe('true')
    expect(screen.getByTestId('app-guide-bottom').getAttribute('data-hit')).toBeNull()
    expect(screen.getByTestId('app-guide-bottom').className).not.toContain('danger')
    act(() => useGuideHits.setState({ hits: [] }))
    expect(screen.getByTestId('app-guide-top').className).not.toContain('danger')
  })

  it('does not tint his own guides when the mode is off, whatever is published', () => {
    setAppGuides(true)
    render(<ProgramAppGuides canvas={makeCanvas()} width={1080} height={1920} />)
    act(() => useGuideHits.setState({ hits: ['top'] }))
    expect(screen.getByTestId('app-guide-top').className).not.toContain('danger')
  })
})

describe('AppGuidesOverlay', () => {
  it('keeps the ember tint for a region nothing overlaps', () => {
    render(<AppGuidesOverlay canvas={makeCanvas()} width={1080} height={1920} app="tiktok" />)
    expect(screen.getByTestId('app-guide-top').className).toContain('ember')
  })
})

describe('GuideHitsPublisher', () => {
  it('publishes the regions, and clears them when it goes away', () => {
    const { unmount } = render(<GuideHitsPublisher hits={['bottom']} />)
    expect(useGuideHits.getState().hits).toEqual(['bottom'])
    unmount()
    expect(useGuideHits.getState().hits).toEqual([])
  })
})
