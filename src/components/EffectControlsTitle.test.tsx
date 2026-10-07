/**
 * @vitest-environment jsdom
 *
 * One click on a caption showed Zoom inside and Crop under the rows that really
 * move it. A title is drawn at the frame's own size, so Zoom inside on it crops
 * that whole frame (a second, odder Scale) and Crop cuts the frame, not the
 * words (2026-10-06). Frame and Flip were already hidden for titles; these two
 * now are too, unless the title already carries a crop.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { defaultTitleDef, defaultTransform, newProject, newTitleClip, type Clip } from '../engine/types'
import { useStore } from '../state/store'
import { EffectControls, showsCropRows } from './EffectControls'
import { installResizeObserver } from './timelineDomFixtures'

const picture = (): Clip => ({
  id: 'p',
  assetId: 'a',
  startS: 0,
  inS: 0,
  outS: 4,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
})

beforeEach(() => {
  installResizeObserver()
  useStore.getState().setProject(newProject())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Zoom inside and Crop on a title', () => {
  it('a plain caption shows neither', () => {
    const title = newTitleClip(defaultTitleDef('hi'), 0, 3)
    render(<EffectControls clip={title} playheadS={0} fps={30} />)
    expect(screen.queryByTestId('channel-innerZoom')).toBeNull()
    expect(screen.queryByTestId('channel-cropT')).toBeNull()
    // The rows that do move the words stay.
    expect(screen.getByTestId('channel-scale')).toBeTruthy()
  })

  it('a picture keeps both', () => {
    render(<EffectControls clip={picture()} playheadS={0} fps={30} />)
    expect(screen.getByTestId('channel-innerZoom')).toBeTruthy()
    expect(screen.getByTestId('channel-cropT')).toBeTruthy()
  })

  it('a title that already carries a crop keeps both, so nothing he set is out of reach', () => {
    const plain = newTitleClip(defaultTitleDef('hi'), 0, 3)
    const cropped = { ...plain, transform: { ...plain.transform, crop: { t: 0.1, r: 0, b: 0, l: 0 } } }
    expect(showsCropRows(plain)).toBe(false)
    expect(showsCropRows(cropped)).toBe(true)
    const keyed = { ...plain, keyframes: { cropL: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 1, value: 0.2, ease: 'linear' as const }] } }
    expect(showsCropRows(keyed)).toBe(true)
    render(<EffectControls clip={cropped} playheadS={0} fps={30} />)
    expect(screen.getByTestId('channel-innerZoom')).toBeTruthy()
    expect(screen.getByTestId('channel-cropT')).toBeTruthy()
  })
})
