/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'
import { useStore } from '../state/store'
import { TimelineRulerBar } from './TimelineRulerBar'
import { makeClip, makeSeq, makeTrack } from './timelineTestFixtures'

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ pxPerS: 10 })
})
afterEach(cleanup)

const renderBar = (seq = makeSeq([makeTrack()]), onScrubStart = vi.fn(), onScrubDrag = vi.fn()) =>
  render(
    <TimelineRulerBar
      seq={seq}
      pxPerS={10}
      contentWidth={1200}
      lengthS={120}
      winStartS={-Infinity}
      winEndS={Infinity}
      onScrubStart={onScrubStart}
      onScrubDrag={onScrubDrag}
    />,
  )

describe('TimelineRulerBar', () => {
  it('draws a marker at its time with its label', () => {
    const seq = makeSeq([makeTrack()], { markers: [{ id: 'm', t: 4, label: 'Drop', color: '#f00' }] })
    renderBar(seq)
    const marker = screen.getByTestId('marker')
    expect(marker.style.left).toBe('36px')
    expect(marker.title).toBe('Drop')
  })

  it('draws no work area until one is set', () => {
    renderBar()
    expect(screen.queryByTestId('work-area')).toBeNull()
  })

  it('draws the work area and its in and out flags', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip({ outS: 10 })] })], { inPointS: 2, outPointS: 6 })
    renderBar(seq)
    const area = screen.getByTestId('work-area')
    expect(area.style.left).toBe('20px')
    expect(area.style.width).toBe('40px')
    expect(screen.getByTestId('work-area-in').title).toBe('In 00:00:02:00')
    expect(screen.getByTestId('work-area-out').style.left).toBe('52px')
  })

  it('scrubs on press and streams a captured drag', () => {
    const onScrubStart = vi.fn()
    const onScrubDrag = vi.fn()
    renderBar(undefined, onScrubStart, onScrubDrag)
    const ruler = screen.getByTestId('ruler')
    let captured = false
    ruler.setPointerCapture = () => {
      captured = true
    }
    ruler.hasPointerCapture = () => captured
    fireEvent.pointerMove(ruler, { clientX: 50, pointerId: 1 })
    expect(onScrubDrag).not.toHaveBeenCalled()
    fireEvent.pointerDown(ruler, { clientX: 40, pointerId: 1 })
    expect(onScrubStart).toHaveBeenCalledWith(40)
    fireEvent.pointerMove(ruler, { clientX: 60, pointerId: 1 })
    expect(onScrubDrag).toHaveBeenCalledWith(60)
  })
})
