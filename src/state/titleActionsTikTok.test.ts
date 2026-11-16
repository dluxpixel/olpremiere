// @vitest-environment jsdom
//
// A new title in TikTok text mode: the TikTok look, at the middle of the SAFE area, and straight
// into typing on the video. Out of the mode it is exactly what it always was.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

import { appGuideRegions } from '../engine/appGuides'
import { titleInkBoxUV } from '../engine/render/titleRaster'
import { activeSequence, defaultTitleDef, newProject, type Clip } from '../engine/types'
import { useTextEdit, endTextEdit, startTextEdit } from '../components/MonitorTextEdit'
import { setTiktokMode } from './settings'
import { useStore } from './store'
import { titleLookById } from './titleShelf'
import { addTitleClip, addTitleFromShelf, setTitleAlign, updateTitle } from './titleActions'

const titles = (): Clip[] =>
  activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .filter((c) => c.title)

beforeEach(() => {
  localStorage.clear()
  setTiktokMode(false)
  endTextEdit()
  useStore.getState().setProject(newProject('p', { w: 1080, h: 1920 }))
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
})

describe('a new title with TikTok text mode on', () => {
  it('wears the tiktok-plain look, keeping the look the shelf has', () => {
    setTiktokMode(true)
    addTitleClip()
    const t = titles()[0]!.title!
    const look = titleLookById('tiktok-plain')!
    expect(t.fontFamily).toBe(look.style.fontFamily)
    expect(t.fontSizePx).toBe(64)
    expect(t.color).toBe('#ffffff')
    expect(t.shadow).toEqual(look.style.shadow)
    expect(t.lineBox).toBeUndefined()
  })

  it('sits at the centre of the safe area, not the frame centre', () => {
    setTiktokMode(true)
    addTitleClip()
    const c = titles()[0]!
    const r = appGuideRegions(1080, 1920, 'tiktok')!
    const top = r.find((x) => x.key === 'top')!.h
    const bottom = r.find((x) => x.key === 'bottom')!.h
    const right = r.find((x) => x.key === 'right')!.w
    // safe x 0..950, y 150..1480: centre (475, 815), against the frame's (540, 960)
    expect(c.transform.x).toBe((1080 - right) / 2 - 540)
    expect(c.transform.y).toBe((top + (1920 - bottom)) / 2 - 960)
    expect(c.transform.x).toBe(-65)
    expect(c.transform.y).toBe(-145)
  })

  it('starts empty, is selected, and goes straight into typing on the video', () => {
    setTiktokMode(true)
    addTitleClip()
    const c = titles()[0]!
    expect(c.title!.text).toBe('')
    expect(useStore.getState().ui.selection).toEqual([c.id])
    expect(useTextEdit.getState().editing?.clipId).toBe(c.id)
  })

  it('keeps words he passes in', () => {
    setTiktokMode(true)
    addTitleClip('Round 2')
    expect(titles()[0]!.title!.text).toBe('Round 2')
  })

  it('does not start typing while the video plays, where there is no field to type in', () => {
    setTiktokMode(true)
    useStore.getState().setUI({ playing: true })
    addTitleClip()
    expect(useTextEdit.getState().editing).toBeNull()
  })

  it('on a wide frame the safe area is the whole frame, so the title stays in the middle', () => {
    setTiktokMode(true)
    useStore.getState().setProject(newProject('p', { w: 1920, h: 1080 }))
    addTitleClip()
    const c = titles()[0]!
    expect(c.transform.x).toBe(0)
    expect(c.transform.y).toBe(0)
  })

  it('a title off the shelf keeps the look he picked, where it is dropped, and does not start typing', () => {
    setTiktokMode(true)
    addTitleFromShelf('headline-pop')
    const c = titles()[0]!
    expect(c.title!.fontSizePx).toBe(120)
    expect(c.title!.text).toBe('Your headline')
    expect(c.transform.x).toBe(0)
    expect(c.transform.y).toBe(0)
    expect(useTextEdit.getState().editing).toBeNull()
  })
})

describe('a new title with the mode off', () => {
  it('is exactly the old default title: plain look, frame centre, no typing', () => {
    addTitleClip()
    const c = titles()[0]!
    expect(c.title).toEqual(defaultTitleDef('Title'))
    expect(c.transform.x).toBe(0)
    expect(c.transform.y).toBe(0)
    expect(useTextEdit.getState().editing).toBeNull()
    expect(useStore.getState().ui.selection).toEqual([c.id])
  })
})

// The bar's align button: the title moves in the SAME edit so its drawn box stays in the safe area.
describe('setTitleAlign in TikTok text mode', () => {
  // A canvas that measures every letter at 40 px, so the drawn box has a real width in node.
  const fakeCtx = { font: '', textAlign: 'left', measureText: (s: string) => ({ width: s.length * 40 }) }
  class FakeOffscreen {
    getContext() {
      return fakeCtx
    }
  }
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const MARGIN = 48

  /** Where the title's drawn box (highlight padding included) is, in sequence px, left and right. */
  function drawn(c: Clip, w = 1080, h = 1920): { left: number; right: number } {
    const uv = titleInkBoxUV(c.title!, w, h)!
    return { left: uv.u0 * w + c.transform.x, right: uv.u1 * w + c.transform.x }
  }
  const current = (id: string): Clip => titles().find((c) => c.id === id)!

  function typed(text = 'Round 2'): Clip {
    setTiktokMode(true)
    addTitleClip(text)
    endTextEdit()
    return titles()[0]!
  }

  it('left puts the drawn box on the safe left plus the margin, in one undo step, and leaves y alone', () => {
    const c = typed()
    const steps = useStore.getState().history.undo.length
    setTitleAlign(c.id, 'left')
    const now = current(c.id)
    expect(now.title!.align).toBe('left')
    expect(drawn(now).left).toBeCloseTo(MARGIN, 6)
    expect(now.transform.y).toBe(-145)
    expect(useStore.getState().history.undo.length).toBe(steps + 1)
    useStore.getState().undo()
    expect(current(c.id).title!.align).toBe('center')
    expect(current(c.id).transform.x).toBe(-65)
  })

  it('right puts the drawn box on the safe right minus the margin, clear of the Buttons column', () => {
    const c = typed()
    setTitleAlign(c.id, 'right')
    expect(drawn(current(c.id)).right).toBeCloseTo(950 - MARGIN, 6)
  })

  it('centre puts it back at the middle of the safe area', () => {
    const c = typed()
    setTitleAlign(c.id, 'left')
    setTitleAlign(c.id, 'center')
    const d = drawn(current(c.id))
    expect((d.left + d.right) / 2).toBeCloseTo(475, 6)
  })

  it('counts the highlight padding in the box, so the highlight itself clears the margin', () => {
    const c = typed()
    updateTitle(c.id, { lineBox: titleLookById('tiktok-highlight')!.style.lineBox })
    setTitleAlign(c.id, 'left')
    const now = current(c.id)
    expect(drawn(now).left).toBeCloseTo(MARGIN, 6)
    // the words themselves start further in than the highlight's edge
    const noBox = { ...now.title!, lineBox: undefined }
    expect(titleInkBoxUV(noBox, 1080, 1920)!.u0 * 1080 + now.transform.x).toBeGreaterThan(MARGIN + 1)
  })

  it('on the Phone shape the sides are the same', () => {
    setTiktokMode(true)
    useStore.getState().setProject(newProject('p', { w: 1080, h: 2112 }))
    addTitleClip('Round 2')
    endTextEdit()
    const c = titles()[0]!
    setTitleAlign(c.id, 'right')
    expect(drawn(current(c.id), 1080, 2112).right).toBeCloseTo(902, 6)
  })

  it('on a frame without guides the whole frame is the safe area and the margin scales with its width', () => {
    setTiktokMode(true)
    useStore.getState().setProject(newProject('p', { w: 1920, h: 1080 }))
    addTitleClip('Round 2')
    endTextEdit()
    const c = titles()[0]!
    setTitleAlign(c.id, 'left')
    expect(drawn(current(c.id), 1920, 1080).left).toBeCloseTo((48 * 1920) / 1080, 6)
  })

  it('an empty title has no drawn box, so only the alignment changes', () => {
    setTiktokMode(true)
    addTitleClip()
    const c = titles()[0]!
    setTitleAlign(c.id, 'left')
    expect(current(c.id).title!.align).toBe('left')
    expect(current(c.id).transform.x).toBe(-65)
  })

  it('with the mode off it is just the alignment', () => {
    const c = typed()
    setTiktokMode(false)
    setTitleAlign(c.id, 'left')
    expect(current(c.id).title!.align).toBe('left')
    expect(current(c.id).transform.x).toBe(-65)
  })
})

// A title the mode made, typed on, and left empty is not left behind.
describe('a title started by the mode that is left empty', () => {
  const stepsOf = () => useStore.getState().history

  it('is removed when typing ends, with no undo step left behind', () => {
    setTiktokMode(true)
    const before = stepsOf().undo.length
    addTitleClip()
    expect(titles().length).toBe(1)
    endTextEdit()
    expect(titles().length).toBe(0)
    expect(stepsOf().undo.length).toBe(before)
    expect(stepsOf().redo.length).toBe(0)
    expect(useStore.getState().ui.selection).toEqual([])
  })

  it('goes too when it holds only spaces and new lines', () => {
    setTiktokMode(true)
    addTitleClip()
    const id = titles()[0]!.id
    updateTitle(id, { text: '  \n ' }, 'text')
    endTextEdit()
    expect(titles().length).toBe(0)
  })

  it('goes when he typed and deleted again, as one step that undo brings back', () => {
    setTiktokMode(true)
    addTitleClip()
    const id = titles()[0]!.id
    updateTitle(id, { text: 'a' }, 'text')
    updateTitle(id, { text: '' }, 'text')
    endTextEdit()
    expect(titles().length).toBe(0)
    expect(stepsOf().undo[stepsOf().undo.length - 1]!.label).toBe('Delete clip')
    useStore.getState().undo()
    expect(titles().length).toBe(1)
  })

  it('stays when there are words in it', () => {
    setTiktokMode(true)
    addTitleClip()
    const id = titles()[0]!.id
    updateTitle(id, { text: 'hi' }, 'text')
    endTextEdit()
    expect(titles().map((c) => c.id)).toEqual([id])
  })

  it('is never done to an existing title he emptied on purpose', () => {
    setTiktokMode(true)
    addTitleClip('Round 2')
    endTextEdit()
    const id = titles()[0]!.id
    startTextEdit(id) // typing on a title that was already there
    updateTitle(id, { text: '' }, 'text')
    endTextEdit()
    expect(titles().map((c) => c.id)).toEqual([id])
  })
})
