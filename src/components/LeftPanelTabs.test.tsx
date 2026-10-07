// @vitest-environment jsdom
//
// A hop to another left tab and back keeps his search and his place in the bin. The tab content
// is keyed on the tab so it fades in, and that also unmounted the tab he left: "blur" typed in
// Effects was gone after a hop to Media, and a bin scrolled halfway down was back at the top.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bin's media check reads the blob store, which jsdom does not have. Every file is there.
vi.mock('../state/relinkMedia', async (actual) => ({
  ...(await actual<typeof import('../state/relinkMedia')>()),
  missingMedia: async () => [],
}))

import { newProject, type MediaAsset } from '../engine/types'
import { useStore } from '../state/store'
import { LeftPanel } from './LeftPanel'

/** A bin of image cards, enough to scroll. */
function binOf(n: number): Record<string, MediaAsset> {
  const assets: Record<string, MediaAsset> = {}
  for (let i = 0; i < n; i++) {
    const id = `img-${i}`
    assets[id] = {
      id,
      kind: 'image',
      name: `gym ${i}.png`,
      blobKey: `blob-${i}`,
      durationS: 0,
      width: 1080,
      height: 1920,
      hasAudio: false,
      hasVideo: true,
    }
  }
  return assets
}

const grid = () => screen.getByTestId('media-grid')

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject({ ...newProject(), assets: binOf(40) })
  useStore.getState().setUI({ selection: [], leftTab: 'effects' })
})
afterEach(cleanup)

describe('switching left tabs', () => {
  it('keeps what he typed in the Effects search', async () => {
    render(<LeftPanel width={280} />)
    await userEvent.type(screen.getByTestId('effect-search'), 'blur')
    await userEvent.click(screen.getByTestId('tab-media'))
    expect(screen.queryByTestId('effect-search')).toBeNull()
    await userEvent.click(screen.getByTestId('tab-effects'))
    expect(screen.getByTestId('effect-search')).toHaveProperty('value', 'blur')
  })

  it('keeps his place in the Media bin', async () => {
    useStore.getState().setUI({ leftTab: 'media' })
    render(<LeftPanel width={280} />)
    grid().scrollTop = 400
    fireEvent.scroll(grid())
    await userEvent.click(screen.getByTestId('tab-effects'))
    expect(screen.queryByTestId('media-grid')).toBeNull()
    await userEvent.click(screen.getByTestId('tab-media'))
    expect(grid().scrollTop).toBe(400)
  })
})
