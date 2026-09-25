/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeSequence, audioTracks, newProject, videoTracks, type Sequence } from '../engine/types'
import { useStore } from '../state/store'
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
