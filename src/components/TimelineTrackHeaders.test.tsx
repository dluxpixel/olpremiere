/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeSequence, audioTracks, newProject, videoTracks, type Sequence } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { HEADERS_W, PHONE_HEADERS_W } from './timelineGeometry'
import { TimelineTrackHeaders } from './TimelineTrackHeaders'

const seq = (): Sequence => activeSequence(useStore.getState().project)

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
})
afterEach(cleanup)

const renderHeaders = (phone = false, lanes: HTMLDivElement | null = null) => {
  const columnRef = { current: null as HTMLDivElement | null }
  const lanesRef = { current: lanes }
  render(
    <TimelineTrackHeaders
      columnRef={columnRef as { readonly current: HTMLDivElement }}
      lanesRef={lanesRef}
      phone={phone}
      vTracks={[...videoTracks(seq())].reverse()}
      aTracks={audioTracks(seq())}
    />,
  )
  return { columnRef }
}

describe('TimelineTrackHeaders', () => {
  it('hands its column to the ref and sizes it for the device', () => {
    const { columnRef } = renderHeaders()
    expect(columnRef.current).toBe(screen.getByTestId('track-headers'))
    expect(columnRef.current?.style.width).toBe(`${HEADERS_W}px`)
    cleanup()
    renderHeaders(true)
    expect(screen.getByTestId('track-headers').style.width).toBe(`${PHONE_HEADERS_W}px`)
  })

  it('adds a video and an audio track as undoable edits', async () => {
    renderHeaders()
    const before = { v: videoTracks(seq()).length, a: audioTracks(seq()).length }
    const user = userEvent.setup()
    await user.click(screen.getByTestId('add-video-track'))
    expect(videoTracks(seq()).length).toBe(before.v + 1)
    await user.click(screen.getByTestId('add-audio-track'))
    expect(audioTracks(seq()).length).toBe(before.a + 1)
  })

  it('forwards a wheel over the headers to the lanes', () => {
    const lanes = document.createElement('div')
    renderHeaders(false, lanes)
    fireEvent.wheel(screen.getByTestId('track-headers'), { deltaY: 30 })
    expect(lanes.scrollTop).toBe(30)
  })
})

// On V1 the speaker said Mute and the picture vanished from the monitor and the
// export; Solo on V1 silenced the whole edit, since a linked picture makes no
// sound of its own.
describe('a video line hides, an audio line mutes', () => {
  const header = (name: string) => within(screen.getByTestId(`track-header-${name}`))

  it('a video header says Hide track and has no Solo; an audio header has both', () => {
    renderHeaders()
    expect(header('V1').getByRole('button', { name: 'Hide track' })).toBeTruthy()
    expect(header('V1').queryByRole('button', { name: 'Mute track' })).toBeNull()
    expect(header('V1').queryByRole('button', { name: 'Solo track' })).toBeNull()
    expect(header('A1').getByRole('button', { name: 'Mute track' })).toBeTruthy()
    expect(header('A1').getByRole('button', { name: 'Solo track' })).toBeTruthy()
  })

  it('Hide hides, then the same button says Show', async () => {
    renderHeaders()
    await userEvent.setup().click(header('V1').getByRole('button', { name: 'Hide track' }))
    expect(videoTracks(seq())[0].muted).toBe(true)
    cleanup()
    renderHeaders()
    expect(header('V1').getByRole('button', { name: 'Show track' })).toBeTruthy()
  })

  it('a video line already soloed keeps its Solo button, so he can turn it off', () => {
    updateActiveSequence('seed', (sq) => ({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, solo: true } : t)) }))
    renderHeaders()
    expect(header('V1').getByRole('button', { name: 'Unsolo track' })).toBeTruthy()
  })
})
