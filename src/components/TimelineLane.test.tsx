/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, newProject, newTitleClip, type Track } from '../engine/types'
import { useStore } from '../state/store'
import { TimelineLane } from './TimelineLane'
import { makeTrack } from './timelineTestFixtures'

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
})
afterEach(cleanup)

const a = newTitleClip(defaultTitleDef('a'), 0, 2)
const b = newTitleClip(defaultTitleDef('b'), 10, 2)
const lane = makeTrack({ clips: [a, b], height: 50 })

const handlers = () => ({
  onLanePointerDown: vi.fn(),
  onClipPointerDown: vi.fn(),
  onTrimPointerDown: vi.fn(),
  onClipContextMenu: vi.fn(),
  onFadePreview: vi.fn(),
})

const renderLane = (over: Partial<Parameters<typeof TimelineLane>[0]> = {}, track: Track = lane) => {
  const h = handlers()
  const { container } = render(
    <TimelineLane
      track={track}
      tint="bg-lane"
      fps={30}
      assets={{}}
      pxPerS={10}
      selection={[]}
      tool="select"
      seenClipIds={new Set([a.id, b.id])}
      winStartS={-Infinity}
      winEndS={Infinity}
      hoverLane={null}
      dropPreview={null}
      silenced={false}
      {...h}
      {...over}
    />,
  )
  return { h, laneEl: container.firstElementChild as HTMLElement }
}

describe('TimelineLane', () => {
  it('draws the lane at the track height with its tint', () => {
    const { laneEl } = renderLane()
    expect(laneEl.style.height).toBe('50px')
    expect(laneEl.className).toContain('bg-lane')
    expect(laneEl.style.filter).toBe('')
  })

  it('mounts only the clips inside the virtualization window', () => {
    renderLane({ winStartS: 5, winEndS: 20 })
    const ids = screen.getAllByTestId('clip').map((c) => c.dataset.clipId)
    expect(ids).toEqual([b.id])
  })

  it('pops only a clip it has not seen before', () => {
    renderLane({ seenClipIds: new Set([a.id]) })
    const [ca, cb] = screen.getAllByTestId('clip')
    expect(ca.className).not.toContain('clip-pop')
    expect(cb.className).toContain('clip-pop')
  })

  it('desaturates a silenced lane and fades a locked one', () => {
    const { laneEl } = renderLane({ silenced: true })
    expect(laneEl.style.filter).toBe('saturate(0.15)')
    cleanup()
    const locked = renderLane({}, makeTrack({ locked: true, clips: [a] }))
    expect(locked.laneEl.className).toContain('opacity-60')
  })

  it('tints only the hovered lane, green or red', () => {
    const { laneEl } = renderLane({ hoverLane: { trackId: lane.id, valid: false } })
    expect(laneEl.className).toContain('ring-danger/50')
    cleanup()
    const other = renderLane({ hoverLane: { trackId: 'elsewhere', valid: true } })
    expect(other.laneEl.className).not.toContain('ring-accent/50')
  })

  it('draws the drop preview line only on its own lane', () => {
    const { laneEl } = renderLane({ dropPreview: { trackId: lane.id, tS: 4 } })
    const line = laneEl.querySelector('.bg-accent.w-\\[2px\\]') as HTMLElement
    expect(line.style.left).toBe('40px')
    cleanup()
    const other = renderLane({ dropPreview: { trackId: 'elsewhere', tS: 4 } })
    expect(other.laneEl.querySelector('.w-\\[2px\\]')).toBeNull()
  })

  it('routes presses to the lane and the clip handlers', () => {
    const { h, laneEl } = renderLane()
    fireEvent.pointerDown(laneEl)
    expect(h.onLanePointerDown).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(screen.getAllByTestId('clip')[0])
    expect(h.onClipPointerDown).toHaveBeenCalledWith(expect.anything(), a)
    fireEvent.contextMenu(screen.getAllByTestId('clip')[1])
    expect(h.onClipContextMenu).toHaveBeenCalledWith(expect.anything(), b)
  })

  it('marks the selected clip', () => {
    renderLane({ selection: [b.id] })
    const [ca, cb] = screen.getAllByTestId('clip')
    expect(ca.className).not.toContain('ring-accent ')
    expect(cb.className).toContain('ring-2 ring-accent')
  })
})
