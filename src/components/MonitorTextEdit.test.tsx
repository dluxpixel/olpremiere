/**
 * @vitest-environment jsdom
 *
 * Type text right on the video. Double click a title in the monitor (or press
 * Enter with one title selected) and a transparent textarea lies over the title's
 * box: the picture he sees stays the real raster, only the words are typed
 * through the same store action the Inspector's text box uses.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { installKeymap } from '../keymap'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  defaultTransform,
  newProject,
  newTitleClip,
  type Clip,
  type TitleDef,
} from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { editBoxSeq, endTextEdit, useTextEdit } from './MonitorTextEdit'
import { MonitorTransformOverlay } from './MonitorTransformOverlay'

const clipOf = (id: string): Clip =>
  activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
const titleOf = (id: string): TitleDef => clipOf(id).title!

// A canvas measure the overlay's ink hit test can read: 40 sequence px a letter.
const fakeCtx = { font: '', textAlign: 'left', measureText: (s: string) => ({ width: s.length * 40 }) }
class FakeOffscreen {
  getContext() {
    return fakeCtx
  }
}
let resizeCbs: Array<() => void> = []
class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeCbs.push(cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The monitor shows the 1920x1080 sequence at half size.
let canvasW = 960
let canvasH = 540
const K = () => canvasW / 1920

const parents: HTMLElement[] = []
function mountOverlay(): void {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  parents.push(parent)
  const canvas = document.createElement('canvas')
  parent.appendChild(canvas)
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvasW, height: canvasH, right: canvasW, bottom: canvasH, x: 0, y: 0, toJSON: () => ({}) })
  render(<MonitorTransformOverlay canvas={canvas} />)
}

function seed(patch: Partial<TitleDef> = {}, over: Partial<Clip> = {}): Clip {
  const clip = { ...newTitleClip({ ...defaultTitleDef('hi'), ...patch }, 0, 3), ...over }
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
  )
  return clip
}

/** The middle of the frame, in monitor px: where a centred title's words sit. */
const dblClickMiddle = () =>
  fireEvent.doubleClick(screen.getByTestId('preview-select'), { clientX: (1920 / 2) * K(), clientY: (1080 / 2) * K() })

beforeEach(() => {
  canvasW = 960
  canvasH = 540
  resizeCbs = []
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
  endTextEdit()
})
afterEach(() => {
  cleanup()
  parents.splice(0).forEach((p) => p.remove())
  endTextEdit()
  vi.unstubAllGlobals()
})

describe('double click starts typing on the video', () => {
  it('a double click on a title opens the field over it and focuses it', () => {
    const c = seed()
    mountOverlay()
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
    dblClickMiddle()
    const field = screen.getByTestId('text-edit-field') as HTMLTextAreaElement
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('hi')
    expect(useStore.getState().ui.selection).toEqual([c.id])
    expect(useTextEdit.getState().editing?.clipId).toBe(c.id)
  })

  it('a double click on a video clip does nothing new', () => {
    const clip: Clip = {
      id: 'v1',
      assetId: 'a1',
      startS: 0,
      inS: 0,
      outS: 3,
      speed: 1,
      enabled: true,
      transform: defaultTransform(),
      opacity: 1,
      blendMode: 'normal',
      audioGainDb: 0,
      fadeInS: 0,
      fadeOutS: 0,
      effects: [],
    }
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
    )
    useStore.getState().setUI({ selection: ['v1'] })
    mountOverlay()
    dblClickMiddle()
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
    expect(useTextEdit.getState().editing).toBeNull()
    expect(screen.getByTestId('gizmo-body')).toBeTruthy()
  })

  it('Enter with one title selected starts it, and Enter inside another field does not', () => {
    const c = seed()
    useStore.getState().setUI({ selection: [c.id] })
    mountOverlay()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    fireEvent.keyDown(other, { key: 'Enter' })
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
    other.blur()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByTestId('text-edit-field'))
  })

  it('Enter does nothing when the selected clip is not a title', () => {
    mountOverlay()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
  })
})

describe('typing writes the title', () => {
  it('each keystroke goes through the store, and the whole session is one undo step', () => {
    const c = seed()
    mountOverlay()
    dblClickMiddle()
    const field = screen.getByTestId('text-edit-field')
    fireEvent.change(field, { target: { value: 'hi t' } })
    fireEvent.change(field, { target: { value: 'hi th' } })
    fireEvent.change(field, { target: { value: 'hi there' } })
    expect(titleOf(c.id).text).toBe('hi there')
    expect(useStore.getState().undo()).toBe('Edit title')
    expect(titleOf(c.id).text).toBe('hi')
    useStore.getState().redo()
    expect(titleOf(c.id).text).toBe('hi there')
  })

  it('plain Enter adds a line and keeps editing', () => {
    const c = seed()
    mountOverlay()
    dblClickMiddle()
    const field = screen.getByTestId('text-edit-field')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByTestId('text-edit-field')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'hi\nthere' } })
    expect(titleOf(c.id).text).toBe('hi\nthere')
  })

  it('an empty title that ends editing stays, as an empty title does today', () => {
    const c = seed()
    mountOverlay()
    dblClickMiddle()
    fireEvent.change(screen.getByTestId('text-edit-field'), { target: { value: '' } })
    fireEvent.keyDown(screen.getByTestId('text-edit-field'), { key: 'Escape' })
    expect(clipOf(c.id)).toBeTruthy()
    expect(titleOf(c.id).text).toBe('')
  })
})

describe('ways out', () => {
  it('Escape ends editing and keeps the clip selected', () => {
    const c = seed()
    mountOverlay()
    dblClickMiddle()
    fireEvent.keyDown(screen.getByTestId('text-edit-field'), { key: 'Escape' })
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
    expect(useTextEdit.getState().editing).toBeNull()
    expect(useStore.getState().ui.selection).toEqual([c.id])
  })

  it('Ctrl+Enter ends editing', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    fireEvent.keyDown(screen.getByTestId('text-edit-field'), { key: 'Enter', ctrlKey: true })
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
  })

  it('a click outside the field ends editing; a click inside it does not', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    fireEvent.pointerDown(screen.getByTestId('text-edit-field'))
    expect(screen.getByTestId('text-edit-field')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('text-edit-field')).toBeNull()
  })

  it('a control marked as part of the edit does not end it', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    const bar = document.createElement('div')
    bar.setAttribute('data-keeps-text-edit', '')
    const btn = document.createElement('button')
    bar.appendChild(btn)
    document.body.appendChild(bar)
    fireEvent.pointerDown(btn)
    expect(screen.getByTestId('text-edit-field')).toBeTruthy()
  })

  it('selecting something else ends it', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    act(() => useStore.getState().setUI({ selection: [] }))
    expect(useTextEdit.getState().editing).toBeNull()
  })
})

describe('while editing, the editor stays out of the way', () => {
  it('hides the move, scale and rotate handles and a drag does not move the clip', () => {
    const c = seed()
    mountOverlay()
    dblClickMiddle()
    expect(screen.queryByTestId('gizmo-body')).toBeNull()
    expect(screen.queryByTestId('gizmo-handle-0')).toBeNull()
    expect(screen.queryByTestId('gizmo-rotate')).toBeNull()
    const before = { ...clipOf(c.id).transform }
    const field = screen.getByTestId('text-edit-field')
    fireEvent.pointerDown(field, { clientX: 400, clientY: 250, button: 0 })
    fireEvent.pointerMove(window, { clientX: 520, clientY: 330 })
    fireEvent.pointerUp(window, { clientX: 520, clientY: 330 })
    expect(clipOf(c.id).transform).toEqual(before)
    expect(screen.getByTestId('text-edit-field')).toBeTruthy()
  })

  it('the space key and letter shortcuts reach the field, not the app', () => {
    seed()
    mountOverlay()
    const spaceRun = vi.fn()
    const tRun = vi.fn()
    const off = installKeymap([
      { combo: 'space', description: 'Play', domain: 'transport', run: spaceRun },
      { combo: 't', description: 'Title', domain: 'tools', run: tRun },
    ] as Parameters<typeof installKeymap>[0])
    try {
      // The control: with nothing being typed in, the same key runs the shortcut.
      fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })
      expect(spaceRun).toHaveBeenCalledTimes(1)
      dblClickMiddle()
      const field = screen.getByTestId('text-edit-field')
      fireEvent.keyDown(field, { key: ' ', code: 'Space' })
      fireEvent.keyDown(field, { key: 't', code: 'KeyT' })
      expect(spaceRun).toHaveBeenCalledTimes(1)
      expect(tRun).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('the field is a plain textarea that undo and redo leave to the browser, as the Inspector box does', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    const field = screen.getByTestId('text-edit-field') as HTMLTextAreaElement
    expect(field.tagName).toBe('TEXTAREA')
    expect(field.getAttribute('spellcheck')).toBe('false')
    expect(field.getAttribute('autocorrect')).toBe('off')
  })
})

describe('the field lies exactly over the title', () => {
  it('is transparent with an accent caret, scaled from sequence px to monitor px', () => {
    const c = seed({ fontSizePx: 100, lineHeight: 1.5, align: 'left', bold: true, italic: true })
    useStore.getState().setUI({ selection: [c.id] })
    mountOverlay()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    const field = screen.getByTestId('text-edit-field') as HTMLTextAreaElement
    expect(field.style.color).toBe('transparent')
    expect(field.style.caretColor).toBe('var(--color-accent)')
    expect(field.style.resize).toBe('none')
    expect(field.style.fontSize).toBe(`${100 * K()}px`)
    expect(field.style.lineHeight).toBe('1.5')
    expect(field.style.textAlign).toBe('left')
    expect(field.style.fontWeight).toBe('700')
    expect(field.style.fontStyle).toBe('italic')
  })

  it('shows upper and lower case the way the raster draws them, and keeps the typed text', () => {
    const c = seed({ textCase: 'upper' })
    mountOverlay()
    dblClickMiddle()
    const field = screen.getByTestId('text-edit-field') as HTMLTextAreaElement
    expect(field.style.textTransform).toBe('uppercase')
    expect(field.value).toBe('hi')
    expect(titleOf(c.id).text).toBe('hi')
  })

  it('follows the monitor when it is resized', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    const w1 = parseFloat((screen.getByTestId('text-edit-field') as HTMLTextAreaElement).style.width)
    const b1 = useTextEdit.getState().editing!.box
    canvasW = 480
    canvasH = 270
    act(() => resizeCbs.forEach((cb) => cb()))
    const w2 = parseFloat((screen.getByTestId('text-edit-field') as HTMLTextAreaElement).style.width)
    expect(w2).toBeCloseTo(w1 / 2, 5)
    expect(useTextEdit.getState().editing!.box!.w).toBeCloseTo(b1!.w / 2, 5)
  })

  it('carries the clip rotation as a CSS transform', () => {
    const c = seed({}, { transform: { ...defaultTransform(), rotationDeg: 30 } })
    mountOverlay()
    dblClickMiddle()
    expect(c.transform.rotationDeg).toBe(30)
    expect(screen.getByTestId('text-edit-frame').style.transform).toContain('rotate(30deg)')
  })

  it('an unrotated title carries no rotation', () => {
    seed()
    mountOverlay()
    dblClickMiddle()
    expect(screen.getByTestId('text-edit-frame').style.transform).toContain('rotate(0deg)')
  })
})

describe('the hook another component reads', () => {
  it('says which clip is being edited and its box in monitor px, and clears on the way out', () => {
    const c = seed()
    mountOverlay()
    expect(useTextEdit.getState().editing).toBeNull()
    dblClickMiddle()
    const e = useTextEdit.getState().editing!
    expect(e.clipId).toBe(c.id)
    expect(e.box!.w).toBeGreaterThan(0)
    expect(e.box!.h).toBeGreaterThan(0)
    // Centred title: the box is centred on the monitor.
    expect(e.box!.left + e.box!.w / 2).toBeCloseTo(canvasW / 2, 3)
    fireEvent.keyDown(screen.getByTestId('text-edit-field'), { key: 'Escape' })
    expect(useTextEdit.getState().editing).toBeNull()
  })
})

describe('editBoxSeq', () => {
  const line = (s: string) => s.length * 40

  it('lies over the wrap width, one line tall for one line, centred on a middle title', () => {
    const b = editBoxSeq(defaultTitleDef('hi'), 1920, 1080, line)
    expect(b.left).toBe(Math.round(1920 * 0.06))
    expect(b.width).toBe(1920 - 2 * Math.round(1920 * 0.06))
    expect(b.height).toBeCloseTo(96 * 1.2, 5)
    expect(b.top + b.height / 2).toBeCloseTo(540, 5)
  })

  it('grows a line for each break, around the middle', () => {
    const b = editBoxSeq(defaultTitleDef('a\nb\nc'), 1920, 1080, line)
    expect(b.height).toBeCloseTo(3 * 96 * 1.2, 5)
    expect(b.top + b.height / 2).toBeCloseTo(540, 5)
  })

  it('wraps a long line the way the raster does', () => {
    const long = 'word '.repeat(40).trim()
    const b = editBoxSeq(defaultTitleDef(long), 1920, 1080, line)
    expect(b.height).toBeGreaterThan(2 * 96 * 1.2)
  })

  it('counts the breaks without a measurer, and keeps an empty title one line tall', () => {
    expect(editBoxSeq(defaultTitleDef('a\nb'), 1920, 1080, null).height).toBeCloseTo(2 * 96 * 1.2, 5)
    expect(editBoxSeq(defaultTitleDef(''), 1920, 1080, null).height).toBeCloseTo(96 * 1.2, 5)
  })

  it('follows the offsets and the vertical alignment', () => {
    const top = editBoxSeq({ ...defaultTitleDef('hi'), vAlign: 'top', offsetXPx: 30, offsetYPx: 10 }, 1920, 1080, line)
    expect(top.left).toBe(Math.round(1920 * 0.06) + 30)
    expect(top.top).toBe(Math.round(1080 * 0.06) + 10)
    const bottom = editBoxSeq({ ...defaultTitleDef('hi'), vAlign: 'bottom' }, 1920, 1080, line)
    expect(bottom.top + bottom.height).toBeCloseTo(1080 - Math.round(1080 * 0.06), 5)
  })
})
