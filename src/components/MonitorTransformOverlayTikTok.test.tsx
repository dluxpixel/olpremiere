/**
 * @vitest-environment jsdom
 *
 * Dragging a title in TikTok text mode: its edges and its centre stick to the TikTok safe area,
 * and the guide regions it overlaps are reported so the overlay can tint them. With the mode off
 * the drag is what it always was.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { titleInkBoxUV } from '../engine/render/titleRaster'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { setTiktokMode } from '../state/settings'
import { updateActiveSequence, useStore } from '../state/store'
import { titleLookById } from '../state/titleShelf'
import { useGuideHits } from './AppGuidesOverlay'
import { endTextEdit } from './MonitorTextEdit'
import { MonitorTransformOverlay } from './MonitorTransformOverlay'

const fakeCtx = { font: '', textAlign: 'left', measureText: (s: string) => ({ width: s.length * 40 }) }
class FakeOffscreen {
  getContext() {
    return fakeCtx
  }
}
class FakeResizeObserver {
  constructor(_cb: () => void) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

// 1080 x 1920 shown at half size: 540 x 960 monitor px.
const SEQ_W = 1080
const SEQ_H = 1920
const K = 0.5

function mountOverlay(): void {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const canvas = document.createElement('canvas')
  parent.appendChild(canvas)
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: SEQ_W * K, height: SEQ_H * K, right: SEQ_W * K, bottom: SEQ_H * K, x: 0, y: 0, toJSON: () => ({}) })
  render(<MonitorTransformOverlay canvas={canvas} />)
}

function seed(over: Partial<Clip['transform']> = {}): Clip {
  const look = titleLookById('tiktok-plain')!
  const clip = newTitleClip({ ...defaultTitleDef('hi'), ...look.style }, 0, 3)
  clip.transform = { ...clip.transform, ...over }
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
  )
  useStore.getState().setUI({ selection: [clip.id] })
  return clip
}

const clipOf = (id: string): Clip =>
  activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** Where the title's ink starts at the frame centre, in sequence px: the number a drag is measured against. */
function inkAtRest(c: Clip): { top: number; bottom: number; left: number; right: number } {
  const uv = titleInkBoxUV(c.title!, SEQ_W, SEQ_H)!
  return { top: uv.v0 * SEQ_H, bottom: uv.v1 * SEQ_H, left: uv.u0 * SEQ_W, right: uv.u1 * SEQ_W }
}

const fire = (target: EventTarget, type: string, init: MouseEventInit) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }))
  })

/** Press on the body of the gizmo, move by (dxSeq, dySeq) sequence px, and let go. */
function drag(dxSeq: number, dySeq: number, init: MouseEventInit = {}): void {
  const body = screen.getByTestId('gizmo-body')
  fire(body, 'pointerdown', { clientX: 270, clientY: 480 })
  fire(window, 'pointermove', { clientX: 270 + dxSeq * K, clientY: 480 + dySeq * K, ...init })
  fire(window, 'pointerup', { clientX: 270 + dxSeq * K, clientY: 480 + dySeq * K, ...init })
}

beforeEach(() => {
  localStorage.clear()
  setTiktokMode(false)
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  useStore.getState().setProject(newProject('p', { w: SEQ_W, h: SEQ_H }))
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
  useGuideHits.setState({ hits: [] })
  endTextEdit()
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  setTiktokMode(false)
  vi.unstubAllGlobals()
})

describe('with TikTok text mode on', () => {
  beforeEach(() => setTiktokMode(true))

  it('a title top edge that comes near the safe top sticks to it', () => {
    const c = seed()
    const ink = inkAtRest(c)
    mountOverlay()
    // ask for the top edge 6 sequence px below the safe top (150)
    drag(0, 150 + 6 - ink.top)
    expect(clipOf(c.id).transform.y).toBeCloseTo(150 - ink.top, 6)
  })

  it('the bottom edge sticks to the safe bottom', () => {
    const c = seed()
    const ink = inkAtRest(c)
    mountOverlay()
    drag(0, 1480 - 5 - ink.bottom)
    expect(clipOf(c.id).transform.y).toBeCloseTo(1480 - ink.bottom, 6)
  })

  it('the centre sticks to the safe area centre line, not the frame centre', () => {
    const c = seed()
    const ink = inkAtRest(c)
    const cx = (ink.left + ink.right) / 2
    mountOverlay()
    // safe centre x is 475; ask for 4 short of it
    drag(475 - 4 - cx, 0)
    expect(clipOf(c.id).transform.x).toBeCloseTo(475 - cx, 6)
  })

  it('past the snap distance the drag is free', () => {
    const c = seed()
    const ink = inkAtRest(c)
    mountOverlay()
    // the reach is 12 monitor px, which is 24 sequence px here: 30 from the safe top is out of it
    drag(0, 150 + 30 - ink.top)
    expect(clipOf(c.id).transform.y).toBeCloseTo(150 + 30 - ink.top, 6)
  })

  it('holding Alt turns the snapping off for that drag', () => {
    const c = seed()
    const ink = inkAtRest(c)
    mountOverlay()
    drag(0, 150 + 6 - ink.top, { altKey: true })
    expect(clipOf(c.id).transform.y).toBeCloseTo(150 + 6 - ink.top, 6)
  })

  it('reports the guide region a title overlaps while it is dragged into it', () => {
    const c = seed()
    const ink = inkAtRest(c)
    mountOverlay()
    const body = screen.getByTestId('gizmo-body')
    fire(body, 'pointerdown', { clientX: 270, clientY: 480 })
    fire(window, 'pointermove', { clientX: 270, clientY: 480 + (60 - ink.top) * K }) // top edge at 60: in the top band
    expect(useGuideHits.getState().hits).toEqual(['top'])
    fire(window, 'pointerup', { clientX: 270, clientY: 480 })
  })

  it('reports it at rest too, and says nothing for a title inside the safe area', () => {
    seed({ y: 700 }) // ink lands near y 1660: in the bottom band
    mountOverlay()
    expect(useGuideHits.getState().hits).toEqual(['bottom'])
    cleanup()
    document.body.innerHTML = ''
    expect(useGuideHits.getState().hits).toEqual([])
    useStore.getState().setProject(newProject('p', { w: SEQ_W, h: SEQ_H }))
    seed({ y: -145 })
    mountOverlay()
    expect(useGuideHits.getState().hits).toEqual([])
  })

  it('does not snap a clip that is not a title', () => {
    const clip: Clip = { ...newTitleClip(defaultTitleDef('x'), 0, 3), title: undefined, assetId: 'a1' }
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
    )
    useStore.getState().setUI({ selection: [clip.id] })
    mountOverlay()
    drag(0, 300)
    expect(clipOf(clip.id).transform.y).toBeCloseTo(300, 6)
    expect(useGuideHits.getState().hits).toEqual([])
  })
})

describe('with the mode off, the drag is what it was', () => {
  it('does not stick to the safe top, and reports nothing', () => {
    const c = seed()
    const ink = inkAtRest(c)
    mountOverlay()
    drag(0, 150 + 6 - ink.top)
    expect(clipOf(c.id).transform.y).toBeCloseTo(150 + 6 - ink.top, 6)
    expect(useGuideHits.getState().hits).toEqual([])
  })

  it('does not stick to the safe centre line either', () => {
    const c = seed()
    const ink = inkAtRest(c)
    const cx = (ink.left + ink.right) / 2
    mountOverlay()
    drag(475 - 4 - cx, 0)
    expect(clipOf(c.id).transform.x).toBeCloseTo(475 - 4 - cx, 6)
  })
})
