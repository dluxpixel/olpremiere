/**
 * @vitest-environment jsdom
 *
 * The Timeline after its split, rendered whole: the pieces that moved out
 * (headers, ruler bar, lanes, overlays, hooks, clip menu) still meet in the
 * same places. The gesture maths has its own tests beside each module.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, audioTracks, defaultTitleDef, newProject, newTitleClip, videoTracks, type Sequence } from '../engine/types'
import { useContextMenu } from '../state/contextMenu'
import { updateActiveSequence, useStore } from '../state/store'
import { Timeline } from './Timeline'
import { installManualRaf, installResizeObserver } from './timelineDomFixtures'

const seq = (): Sequence => activeSequence(useStore.getState().project)

// jsdom lays nothing out, so every element is 0px wide and the clip
// virtualization window would be empty. Give elements a real width (shadowing
// jsdom's own getter on Element.prototype for the length of each test).

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  installManualRaf()
  installResizeObserver()
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, pxPerS: 10, tool: 'select', snapping: true, playing: false })
  useContextMenu.getState().close()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
})

function seedTitle(startS: number) {
  const clip = newTitleClip(defaultTitleDef('x'), startS, 2)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t) => (t.id === videoTracks(sq)[0].id ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

/** jsdom has no layout: give the content div a box at the viewport origin. */
const layOut = () => {
  const lanes = screen.getByTestId('timeline-lanes')
  const content = lanes.firstElementChild as HTMLElement
  content.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 400, width: 1200, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  lanes.setPointerCapture = () => {}
  lanes.releasePointerCapture = () => {}
  return { lanes, content }
}

describe('Timeline', () => {
  it('renders the headers, ruler, lanes and the empty hint', () => {
    render(<Timeline height={300} />)
    expect(screen.getByTestId('timeline').style.height).toBe('300px')
    expect(screen.getByTestId('track-headers')).toBeTruthy()
    expect(screen.getByTestId('ruler')).toBeTruthy()
    expect(screen.getByTestId('timeline-lanes').dataset.tool).toBe('select')
    expect(screen.getByText('Drag a clip here to start')).toBeTruthy()
    expect(screen.getByTestId('add-video-track')).toBeTruthy()
  })

  it('draws a clip once there is one, and drops the hint', () => {
    const clip = seedTitle(1)
    render(<Timeline height={300} />)
    expect(screen.getAllByTestId('clip').map((c) => c.dataset.clipId)).toEqual([clip.id])
    expect(screen.queryByText('Drag a clip here to start')).toBeNull()
  })

  it('adds a track from the headers column', () => {
    render(<Timeline height={300} />)
    const before = audioTracks(seq()).length
    fireEvent.click(screen.getByTestId('add-audio-track'))
    expect(audioTracks(seq()).length).toBe(before + 1)
  })

  it('scrubs the playhead from the ruler', () => {
    render(<Timeline height={300} />)
    layOut()
    const ruler = screen.getByTestId('ruler')
    ruler.setPointerCapture = () => {}
    fireEvent.pointerDown(ruler, { clientX: 45, pointerId: 1 })
    expect(useStore.getState().ui.playheadS).toBeCloseTo(4.5)
  })

  it('selects a clip on press and opens its menu on right-click', () => {
    const clip = seedTitle(1)
    render(<Timeline height={300} />)
    layOut()
    const el = screen.getByTestId('clip')
    fireEvent.pointerDown(el, { button: 0, clientX: 20, clientY: 40, pointerId: 1 })
    expect(useStore.getState().ui.selection).toEqual([clip.id])
    fireEvent.pointerUp(screen.getByTestId('timeline-lanes'), { clientX: 20, clientY: 40, pointerId: 1 })
    fireEvent.contextMenu(el, { clientX: 20, clientY: 40 })
    const menu = useContextMenu.getState()
    expect(menu.open).toBe(true)
    expect(menu.items.map((i) => i.label).slice(0, 4)).toEqual(['Copy', 'Cut', 'Duplicate', 'Paste'])
  })

  it('moves a dragged clip as one undoable edit', () => {
    const clip = seedTitle(1)
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const el = screen.getByTestId('clip')
    fireEvent.pointerDown(el, { button: 0, clientX: 20, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    const moved = seq().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!
    expect(moved.startS).toBeCloseTo(6)
  })

  it('cuts a clip with the razor', () => {
    const clip = seedTitle(0)
    useStore.getState().setUI({ tool: 'razor' })
    render(<Timeline height={300} />)
    layOut()
    fireEvent.pointerDown(screen.getByTestId('clip'), { button: 0, clientX: 10, clientY: 40, pointerId: 1 })
    const clips = videoTracks(seq())[0].clips
    expect(clips.length).toBe(2)
    expect(clips[0].id).toBe(clip.id)
  })

  it('fits the zoom from the toolbar event', () => {
    seedTitle(0)
    render(<Timeline height={300} />)
    const lanes = screen.getByTestId('timeline-lanes')
    Object.defineProperty(lanes, 'clientWidth', { configurable: true, value: 240 })
    act(() => {
      window.dispatchEvent(new Event('olpremiere:zoom-fit'))
    })
    expect(useStore.getState().ui.pxPerS).toBe(100)
  })
})
