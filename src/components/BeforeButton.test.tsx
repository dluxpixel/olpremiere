/**
 * @vitest-environment jsdom
 *
 * The Before button on the monitor: pressing it holds the Before picture, and the hold must end
 * when the button goes away with the pointer still down (the timeline is emptied, the monitor goes
 * to full screen), because nothing else would ever let go.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewBeforeActive } from '../engine/preview'
import { recomputeDuration } from '../engine/timeline'
import { defaultTransform, newProject, type Clip } from '../engine/types'
import { isHoldingBefore, releaseBefore } from '../state/compareHold'
import { updateActiveSequence, useStore } from '../state/store'
import { BeforeButton } from './Monitor'

const clip: Clip = {
  id: 'a',
  assetId: 'asset-a',
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
  effects: [{ id: 'fx1', type: 'gaussianBlur', params: { blur: 8 }, enabled: true }],
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [] })
  updateActiveSequence('seed', (sq) => {
    const video = sq.tracks.find((t) => t.kind === 'video')!
    return recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.id === video.id ? { ...t, clips: [clip] } : t)) })
  })
  // jsdom has no pointer capture; the button asks for it on press.
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  cleanup()
  releaseBefore()
})

describe('the Before button', () => {
  it('holds while the pointer is down and lets go when it comes up', () => {
    render(<BeforeButton holding={false} />)
    const button = screen.getByTestId('before-hold')
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 })
    expect(isHoldingBefore()).toBe(true)
    expect(previewBeforeActive()).toBe(true)
    fireEvent.pointerUp(button, { pointerId: 1 })
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
  })

  it('lets go when it unmounts in the middle of a hold', () => {
    const { unmount } = render(<BeforeButton holding={false} />)
    fireEvent.pointerDown(screen.getByTestId('before-hold'), { button: 0, pointerId: 1 })
    expect(isHoldingBefore()).toBe(true)
    unmount()
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
  })
})
