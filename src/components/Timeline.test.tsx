/**
 * @vitest-environment jsdom
 *
 * The Timeline after its split, rendered whole: the pieces that moved out
 * (headers, ruler bar, lanes, overlays, hooks, clip menu) still meet in the
 * same places. The gesture maths has its own tests beside each module.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, audioTracks, defaultTitleDef, newProject, newTitleClip, videoTracks, type Sequence } from '../engine/types'
import { useContextMenu } from '../state/contextMenu'
import { ASSET_MIME, EFFECT_MIME } from '../state/dnd'
import { copySelection } from '../state/clipboard'
import { answerNamePrompt, useNamePrompt } from '../state/namePrompt'
import { clickedPasteTrack, setPasteTarget } from '../state/pasteTarget'
import { updateActiveSequence, useStore } from '../state/store'
import { Timeline } from './Timeline'
import { installManualRaf, installResizeObserver } from './timelineDomFixtures'
import { buildLaneInfos } from './timelineLanes'

const seq = (): Sequence => activeSequence(useStore.getState().project)

// jsdom lays nothing out, so every element is 0px wide and the clip
// virtualization window would be empty. Give elements a real width (shadowing
// jsdom's own getter on Element.prototype for the length of each test).

let raf: ReturnType<typeof installManualRaf>
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  raf = installManualRaf()
  installResizeObserver()
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, pxPerS: 10, tool: 'select', snapping: true, playing: false })
  useContextMenu.getState().close()
  setPasteTarget(null)
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
    expect(menu.items.map((i) => i.label).slice(0, 4)).toEqual(['Copy', 'Cut', 'Duplicate', 'Paste at playhead'])
  })

  // A right click on empty space with clips selected used to borrow the whole
  // menu of the FIRST selected clip: Close gap before, Copy move and Trim head
  // for a clip he did not point at, and two pastes ("Paste here" and "Paste").
  it('right click on empty space with a selection lists only what acts on all of it', () => {
    const a = seedTitle(1)
    const b = seedTitle(4)
    useStore.getState().setUI({ selection: [a.id, b.id], playheadS: 2 })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    fireEvent.contextMenu(lanes, { clientX: 300, clientY: 40 })
    const labels = useContextMenu.getState().items.map((i) => i.label)
    expect(labels.filter((l) => l.startsWith('Paste') && !/attributes|move/.test(l))).toEqual(['Paste here'])
    for (const l of ['Copy', 'Cut', 'Duplicate', 'Split 2 clips at playhead', 'Delete 2 clips', 'Ripple delete 2 clips']) {
      expect(labels).toContain(l)
    }
    for (const l of ['Paste at playhead', 'Copy attributes', 'Copy move', 'Close gap before', 'Close all gaps on track', 'Trim head to playhead']) {
      expect(labels).not.toContain(l)
    }
  })

  // After a plain Delete the gap is what he wants gone, and the gap is where he
  // right clicks. Close gap before used to live only on the clip AFTER it.
  it('right click in a gap: Close this gap', () => {
    seedTitle(1) // 1 to 3
    const b = seedTitle(5) // 5 to 7
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const v1 = videoTracks(seq())[0]!
    const y = buildLaneInfos([...videoTracks(seq())].reverse(), audioTracks(seq())).find((i) => i.track.id === v1.id)!.top + 10
    // 4 s at 10 px/s: inside the gap.
    fireEvent.contextMenu(lanes, { clientX: 40, clientY: y })
    const items = useContextMenu.getState().items
    expect(items[0]!.label).toBe('Close this gap')
    act(() => items[0]!.onClick!())
    expect(seq().tracks.flatMap((t) => t.clips).find((c) => c.id === b.id)!.startS).toBeCloseTo(3, 9)
    // After the last clip there is no gap to close, only room.
    fireEvent.contextMenu(lanes, { clientX: 90, clientY: y })
    expect(useContextMenu.getState().items.map((i) => i.label)).not.toContain('Close this gap')
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

  // A drag he regrets mid way had no way out: Esc deselected the clip and the
  // release still committed the move.
  it('Esc mid drag lets go of it: the release commits nothing and the clip stays selected', () => {
    const clip = seedTitle(1)
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const before = useStore.getState().project
    fireEvent.pointerDown(screen.getByTestId('clip'), { button: 0, clientX: 20, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    fireEvent.pointerMove(lanes, { clientX: 90, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 90, clientY: 40, pointerId: 1 })
    expect(useStore.getState().project).toBe(before)
    expect(screen.getByTestId('clip').style.left).toBe('10px')
    expect(useStore.getState().ui.selection).toEqual([clip.id])
    // And the next drag works as ever.
    fireEvent.pointerDown(screen.getByTestId('clip'), { button: 0, clientX: 20, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    expect(seq().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!.startS).toBeCloseTo(6)
  })

  it('a dragged edge moves BY the drag, wherever on the handle he took hold of it', () => {
    // MEASURED 2026-10-01 in his GYM: the trim-out handle dragged +30 px at
    // 60 px/s, half a second, moved the end 0.433 s. The edge jumped to the
    // pointer, and the pointer had grabbed it 4 px inside the 6 px handle.
    const clip = seedTitle(1)
    useStore.getState().setUI({ pxPerS: 60, snapping: false })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    // The end is at 3 s = 180 px. Grab 4 px inside it, drag exactly +30 px.
    fireEvent.pointerDown(screen.getByTestId('trim-out'), { button: 0, clientX: 176, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 206, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 206, clientY: 40, pointerId: 1 })
    const trimmed = seq().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!
    expect(trimmed.startS + (trimmed.outS - trimmed.inS)).toBeCloseTo(3.5, 9)
  })

  // His edits are cut dense, so nearly every edge he grabs touches a neighbour,
  // and that neighbour's edge sat exactly where the grabbed edge began: with
  // snapping on, every trim of 1 to 4 frames snapped straight back to "no change".
  it('a trim of a few frames off a butted cut is not snapped back to where it began', () => {
    const a = seedTitle(1) // 1 to 3
    seedTitle(3) // 3 to 5, butted
    useStore.getState().setUI({ pxPerS: 60, snapping: true })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const clipEl = (id: string) => screen.getAllByTestId('clip').find((x) => x.dataset.clipId === id)!
    // a's end is 3 s = 180 px. Take hold of it there and drag 6 px left: 2.9 s.
    fireEvent.pointerDown(within(clipEl(a.id)).getByTestId('trim-out'), { button: 0, clientX: 180, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 174, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 174, clientY: 40, pointerId: 1 })
    const trimmed = seq().tracks.flatMap((t) => t.clips).find((c) => c.id === a.id)!
    expect(trimmed.startS + (trimmed.outS - trimmed.inS)).toBeCloseTo(2.9, 9)
  })

  // A partner moves only when he selects it too (2026-08-05), so the one he left
  // behind stays put, and its edges are the ones he wants to snap back onto.
  it('a picture slid off its partner snaps back onto it', () => {
    const v1 = videoTracks(seq())[0]!
    const v2 = videoTracks(seq())[1]!
    const pic = { ...newTitleClip(defaultTitleDef('pic'), 2, 2), id: 'pic', linkId: 'L' }
    const snd = { ...newTitleClip(defaultTitleDef('snd'), 1, 2), id: 'snd', linkId: 'L' }
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t) => (t.id === v1.id ? { ...t, clips: [pic] } : t.id === v2.id ? { ...t, clips: [snd] } : t)),
      }),
    )
    useStore.getState().setUI({ pxPerS: 60, snapping: true, playheadS: 10 })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const y = buildLaneInfos([...videoTracks(seq())].reverse(), audioTracks(seq())).find((i) => i.track.id === v1.id)!.top + 10
    const el = screen.getAllByTestId('clip').find((x) => x.dataset.clipId === 'pic')!
    // pic starts at 2 s = 120 px. Grab it 30 px in and drag 54 px left: 1.1 s, 6 px from snd's start.
    fireEvent.pointerDown(el, { button: 0, clientX: 150, clientY: y, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 96, clientY: y, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 96, clientY: y, pointerId: 1 })
    const all = seq().tracks.flatMap((t) => t.clips)
    expect(all.find((c) => c.id === 'pic')!.startS).toBeCloseTo(1, 9)
    expect(all.find((c) => c.id === 'snd')!.startS).toBe(1)
  })

  // ⛔ A CLICK IS A CLICK, HOWEVER THE HAND WOBBLES, 2026-10-03. Measured through the real mouse
  // that day: a press on a clip with the hand drifting ONE pixel before letting go committed a
  // move on 28 of 36 clicks across six zooms. Zoomed out it was a whole second (the snap reaches
  // 8 px, and 8 px is 2 s at 4 px/s), and a video clicked with nothing selected moved off its own
  // sound. Roll, slide and slip did the same on 27 of 63 clicks. A gesture now starts only once
  // the hand has travelled past the click slop.
  it('a click whose hand wobbles a pixel or two moves nothing, even zoomed far out', () => {
    seedTitle(1)
    useStore.getState().setUI({ pxPerS: 4 })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const before = useStore.getState().project
    const el = screen.getByTestId('clip')
    // The clip spans 4 to 12 px. Press its middle, wobble 2 px right and 1 down, let go.
    fireEvent.pointerDown(el, { button: 0, clientX: 8, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 10, clientY: 41, pointerId: 1 })
    fireEvent.pointerUp(lanes, { clientX: 10, clientY: 41, pointerId: 1 })
    expect(useStore.getState().project).toBe(before)
  })

  it('a wobbly click on a roll, a slide or a trim changes nothing either', () => {
    // a [1,3] b [3,5] c [5,7] on one lane at 10 px/s, snapping off so nothing catches it back.
    const a = seedTitle(1)
    const b = seedTitle(3)
    const c = seedTitle(5)
    void a
    useStore.getState().setUI({ pxPerS: 10, snapping: false })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const clipEl = (id: string) => screen.getAllByTestId('clip').find((x) => x.dataset.clipId === id)!
    const before = useStore.getState().project
    const press = (target: HTMLElement, x: number, mods: { ctrlKey?: boolean; altKey?: boolean }) => {
      fireEvent.pointerDown(target, { button: 0, clientX: x, clientY: 40, pointerId: 1, ...mods })
      fireEvent.pointerMove(lanes, { clientX: x + 3, clientY: 40, pointerId: 1, ...mods })
      fireEvent.pointerUp(lanes, { clientX: x + 3, clientY: 40, pointerId: 1, ...mods })
    }
    // Roll the cut between a and b (Ctrl+Alt on b's head).
    press(within(clipEl(b.id)).getByTestId('trim-in'), 31, { ctrlKey: true, altKey: true })
    expect(useStore.getState().project, 'roll').toBe(before)
    // Slide b between its neighbours (Ctrl+Alt on its body).
    press(clipEl(b.id), 40, { ctrlKey: true, altKey: true })
    expect(useStore.getState().project, 'slide').toBe(before)
    // Trim c's tail, which has open timeline after it.
    press(within(clipEl(c.id)).getByTestId('trim-out'), 69, {})
    expect(useStore.getState().project, 'trim').toBe(before)
  })

  // A roll or a slide needs a cut to move. Ctrl+Alt on an edge whose neighbour
  // sits after a gap, or on a clip without a butted neighbour each side, used to
  // read "Roll +0.00s" or "Slide +0.00s" while nothing moved at all.
  it('Ctrl+Alt on an edge across a gap trims it, and on a clip with no cuts to slide moves it', () => {
    const a = seedTitle(1) // 1 to 3
    const b = seedTitle(4) // 4 to 6, a 1 s gap before it, nothing after
    useStore.getState().setUI({ pxPerS: 10, snapping: false })
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    const clipEl = (id: string) => screen.getAllByTestId('clip').find((x) => x.dataset.clipId === id)!
    const drag = (target: HTMLElement, from: number, to: number) => {
      const mods = { ctrlKey: true, altKey: true }
      fireEvent.pointerDown(target, { button: 0, clientX: from, clientY: 40, pointerId: 1, ...mods })
      fireEvent.pointerMove(lanes, { clientX: to, clientY: 40, pointerId: 1, ...mods })
      fireEvent.pointerUp(lanes, { clientX: to, clientY: 40, pointerId: 1, ...mods })
    }
    const find = (id: string) => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
    // a's tail at 3 s = 30 px, dragged 10 px left: a plain trim to 2 s.
    drag(within(clipEl(a.id)).getByTestId('trim-out'), 30, 20)
    expect(find(a.id).startS + (find(a.id).outS - find(a.id).inS)).toBeCloseTo(2, 9)
    // b's body at 50 px, dragged 20 px right: a plain move to 6 s.
    drag(clipEl(b.id), 50, 70)
    expect(find(b.id).startS).toBeCloseTo(6, 9)
  })

  // ⛔ THE WHEEL SCROLLS THE LANES, THE CLIP STAYS IN HIS HAND, 2026-10-03. Measured: with a clip
  // held, a sideways wheel of 600 px scrolled the lanes and left the clip 600 px behind the
  // pointer, and letting go there dropped it 10 s from where his hand was. The drag now re-reads
  // the pointer whenever the lanes scroll under it.
  it('scrolling the lanes mid-drag keeps the clip under the pointer', () => {
    const clip = seedTitle(1)
    useStore.getState().setUI({ pxPerS: 10, snapping: false })
    render(<Timeline height={300} />)
    const { lanes, content } = layOut()
    fireEvent.pointerDown(screen.getByTestId('clip'), { button: 0, clientX: 20, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    // The wheel scrolls the lanes 300 px: the content moves 300 px left under a hand that stays put.
    content.getBoundingClientRect = () =>
      ({ left: -300, top: 0, right: 900, bottom: 400, width: 1200, height: 400, x: -300, y: 0, toJSON: () => ({}) }) as DOMRect
    fireEvent.scroll(lanes)
    fireEvent.pointerUp(lanes, { clientX: 70, clientY: 40, pointerId: 1 })
    const moved = seq().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!
    // Grabbed 1 s into the clip; the hand now points at 37 s of timeline.
    expect(moved.startS).toBeCloseTo(36, 6)
  })

  // A drag from the bin that passes the right edge of the lanes starts the edge
  // scroll. He changes his mind and goes back to the bin: the timeline used to
  // keep running by itself to the end of the edit.
  it('a bin drag that leaves the lanes stops the edge scroll', () => {
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    lanes.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 300, width: 1000, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const dragEv = (type: string, clientX: number) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 60, relatedTarget: null })
      Object.defineProperty(e, 'dataTransfer', { value: { types: [ASSET_MIME], dropEffect: '', getData: () => '' } })
      return e
    }
    act(() => {
      lanes.dispatchEvent(dragEv('dragover', 995))
    })
    act(() => {
      lanes.dispatchEvent(dragEv('dragleave', 1005))
    })
    const before = lanes.scrollLeft
    for (let i = 0; i < 5; i++) act(() => raf.flush())
    expect(lanes.scrollLeft).toBe(before)
    // Esc mid drag: the browser ends it with a dragend on the bin item.
    act(() => {
      lanes.dispatchEvent(dragEv('dragover', 995))
    })
    act(() => {
      window.dispatchEvent(new Event('dragend'))
    })
    const after = lanes.scrollLeft
    for (let i = 0; i < 5; i++) act(() => raf.flush())
    expect(lanes.scrollLeft).toBe(after)
  })

  // Five moves over the same clip used to write five new selections, and every
  // panel that reads the selection re-rendered each time.
  it('a box select writes the selection only when it changes', () => {
    seedTitle(1)
    seedTitle(4)
    render(<Timeline height={300} />)
    const { lanes } = layOut()
    // The lanes need a box of their own, or the press reads as one on the scrollbar.
    lanes.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 300, width: 1000, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    Object.defineProperty(lanes, 'clientHeight', { configurable: true, value: 300 })
    let writes = 0
    const unsub = useStore.subscribe(
      (s) => s.ui.selection,
      () => {
        writes += 1
      },
    )
    fireEvent.pointerDown(lanes, { button: 0, shiftKey: true, clientX: 5, clientY: 30, pointerId: 1 })
    // Five moves that all cover the first clip only.
    for (let x = 20; x < 30; x += 2) fireEvent.pointerMove(lanes, { clientX: x, clientY: 100, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(lanes, { clientX: 28, clientY: 100, pointerId: 1 })
    unsub()
    expect(useStore.getState().ui.selection).toHaveLength(1)
    expect(writes).toBe(1)
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
  // His words, 2026-10-04: *"I clicked the V4 ... It pasted it in V2."* The click he
  // makes on a line, or on its header, is the line Ctrl+V pastes onto.
  describe('the line Ctrl+V pastes onto', () => {
    /** The pointer y that lands inside the lane of the track called `name`. */
    const yIn = (name: string): number => {
      const vTracks = [...videoTracks(seq())].reverse()
      return buildLaneInfos(vTracks, audioTracks(seq())).find((i) => i.track.name === name)!.top + 10
    }
    const laneEl = (content: HTMLElement, name: string): HTMLElement => {
      const order = [...[...videoTracks(seq())].reverse(), ...audioTracks(seq())].map((t) => t.name)
      // Child 0 is the ruler, the video lanes follow, then the 2px divider, then audio.
      const videoCount = videoTracks(seq()).length
      const at = order.indexOf(name)
      return content.children[1 + at + (at >= videoCount ? 1 : 0)] as HTMLElement
    }

    it('a click on an empty spot of a lane aims the paste at that lane', () => {
      render(<Timeline height={300} />)
      const { content } = layOut()
      fireEvent.pointerDown(laneEl(content, 'V2'), { button: 0, clientX: 30, clientY: yIn('V2'), pointerId: 1 })
      expect(clickedPasteTrack(seq())?.name).toBe('V2')
      fireEvent.pointerUp(screen.getByTestId('timeline-lanes'), { clientX: 30, clientY: yIn('V2'), pointerId: 1 })
      fireEvent.pointerDown(laneEl(content, 'V1'), { button: 0, clientX: 30, clientY: yIn('V1'), pointerId: 1 })
      expect(clickedPasteTrack(seq())?.name).toBe('V1')
      // The same click still moves the playhead and clears the selection, as it always did.
      expect(useStore.getState().ui.playheadS).toBeCloseTo(3)
      expect(useStore.getState().ui.selection).toEqual([])
    })

    it('a click on a track header aims the paste at that track, and the header says so', () => {
      render(<Timeline height={300} />)
      const header = screen.getByTestId('track-header-V2')
      expect(header.dataset.pasteTarget).toBeUndefined()
      fireEvent.pointerDown(header, { button: 0 })
      expect(clickedPasteTrack(seq())?.name).toBe('V2')
      expect(screen.getByTestId('track-header-V2').dataset.pasteTarget).toBe('true')
      expect(screen.getByTestId('track-header-V1').dataset.pasteTarget).toBeUndefined()
    })

    it('a press on a header button is for the button and aims nothing', () => {
      render(<Timeline height={300} />)
      const mute = within(screen.getByTestId('track-header-V2')).getAllByRole('button')[0]!
      fireEvent.pointerDown(mute, { button: 0 })
      expect(clickedPasteTrack(seq())).toBeNull()
    })

    it('a press on a clip lets go of the line, because it picks the clip', () => {
      seedTitle(1)
      render(<Timeline height={300} />)
      layOut()
      setPasteTarget(videoTracks(seq())[1]!.id)
      fireEvent.pointerDown(screen.getByTestId('clip'), { button: 0, clientX: 20, clientY: 40, pointerId: 1 })
      expect(clickedPasteTrack(seq())).toBeNull()
    })

    it('a click on the blank area under the tracks leaves the line as it was', () => {
      render(<Timeline height={300} />)
      layOut()
      setPasteTarget(videoTracks(seq())[1]!.id)
      fireEvent.pointerDown(screen.getByTestId('timeline-lanes'), { button: 0, clientX: 30, clientY: 390, pointerId: 1 })
      expect(clickedPasteTrack(seq())?.name).toBe('V2')
    })

    // The same ask, through the clip's own right click menu: the right click
    // selected the clip, which let go of the line, so Paste went back to V1.
    it('right click a clip, Paste at playhead: it lands on the line of that clip', () => {
      updateActiveSequence('seed', (sq) => {
        const [v1, v2] = videoTracks(sq)
        const a = { ...newTitleClip(defaultTitleDef('a'), 0, 2), id: 'A' }
        const b = { ...newTitleClip(defaultTitleDef('b'), 0, 2), id: 'B' }
        return recomputeDuration({
          ...sq,
          tracks: sq.tracks.map((t) => (t.id === v1!.id ? { ...t, clips: [a] } : t.id === v2!.id ? { ...t, clips: [b] } : t)),
        })
      })
      useStore.getState().setUI({ selection: ['A'] })
      copySelection()
      // 5.0123 s: where a Space pause leaves the playhead, between two frames.
      useStore.getState().setUI({ selection: [], playheadS: 5.0123 })
      render(<Timeline height={300} />)
      layOut()
      const bEl = screen.getAllByTestId('clip').find((c) => c.dataset.clipId === 'B')!
      fireEvent.contextMenu(bEl, { clientX: 10, clientY: 40 })
      const paste = useContextMenu.getState().items.find((i) => i.label === 'Paste at playhead')!
      act(() => paste.onClick!())
      const [v1, v2] = videoTracks(seq())
      expect(v1!.clips.map((c) => c.id)).toEqual(['A'])
      expect(v2!.clips).toHaveLength(2)
      expect(v2!.clips[1]!.startS * 30).toBeCloseTo(150, 9)
    })
  })
  // His words, 2026-10-04: *"selecting multiple images and putting effects on them that
  // actually apply to all of them."* An effect dragged from the Effects tab onto one of
  // several selected clips used to land on that clip alone and shrink the selection to it.
  // Markers are how he marks beats while the song plays, and they could only be
  // added and removed by key: a misplaced one had to be deleted and tapped
  // again, and its name never showed (the marker took no pointer at all).
  describe('a marker on the ruler', () => {
    const seedMarker = (t: number) =>
      updateActiveSequence('seed', (sq) => ({ ...sq, markers: [{ id: 'mk', t, label: '', color: '#f00' }] }))
    const markerEl = () => {
      const el = screen.getByTestId('marker')
      el.setPointerCapture = () => {}
      return el
    }
    const markers = () => seq().markers

    it('a click puts the playhead on it', () => {
      seedMarker(4)
      render(<Timeline height={300} />)
      layOut()
      fireEvent.pointerDown(markerEl(), { button: 0, clientX: 40, clientY: 10, pointerId: 1 })
      fireEvent.pointerUp(markerEl(), { button: 0, clientX: 41, clientY: 10, pointerId: 1 })
      expect(useStore.getState().ui.playheadS).toBe(4)
      expect(markers()[0]!.t).toBe(4)
    })

    it('a drag moves it, on a whole frame, in one undo step', () => {
      seedMarker(4)
      useStore.getState().setUI({ snapping: false })
      render(<Timeline height={300} />)
      layOut()
      const undos = useStore.getState().history.undo.length
      fireEvent.pointerDown(markerEl(), { button: 0, clientX: 40, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(markerEl(), { clientX: 50, clientY: 10, pointerId: 1 })
      // 6.0123 s: between two frames at 30 fps.
      fireEvent.pointerMove(markerEl(), { clientX: 60.123, clientY: 10, pointerId: 1 })
      fireEvent.pointerUp(markerEl(), { button: 0, clientX: 60.123, clientY: 10, pointerId: 1 })
      expect(markers()[0]!.t * 30).toBeCloseTo(180, 9)
      expect(useStore.getState().history.undo.length).toBe(undos + 1)
      expect(useStore.getState().history.undo.at(-1)!.label).toBe('Move marker')
      // A drag is not a click: the playhead stayed where it was.
      expect(useStore.getState().ui.playheadS).toBe(0)
    })

    it('a drag snaps onto a clip edge', () => {
      seedMarker(4)
      seedTitle(1) // ends at 3
      render(<Timeline height={300} />)
      layOut()
      fireEvent.pointerDown(markerEl(), { button: 0, clientX: 40, clientY: 10, pointerId: 1 })
      // 3.3 s at 10 px/s: 3 px from the clip's end, inside the 8 px snap.
      fireEvent.pointerMove(markerEl(), { clientX: 33, clientY: 10, pointerId: 1 })
      fireEvent.pointerUp(markerEl(), { button: 0, clientX: 33, clientY: 10, pointerId: 1 })
      expect(markers()[0]!.t).toBe(3)
    })

    it('a right click names it or removes it', async () => {
      seedMarker(4)
      render(<Timeline height={300} />)
      layOut()
      fireEvent.contextMenu(markerEl(), { clientX: 40, clientY: 10 })
      const items = useContextMenu.getState().items
      expect(items.map((i) => i.label)).toEqual(['Name marker', 'Remove marker'])
      act(() => items[0]!.onClick!())
      expect(useNamePrompt.getState().request?.title).toBe('Name this marker')
      await act(async () => {
        answerNamePrompt('Drop')
        await Promise.resolve()
      })
      expect(markers()[0]!.label).toBe('Drop')
      expect(screen.getByTestId('marker').title).toBe('Drop')
      fireEvent.contextMenu(markerEl(), { clientX: 40, clientY: 10 })
      act(() => useContextMenu.getState().items[1]!.onClick!())
      expect(markers()).toEqual([])
    })
  })

  describe('an effect dropped on a selected clip', () => {
    const dropEffect = (clip: HTMLElement, type: string) =>
      fireEvent.drop(clip, {
        dataTransfer: { types: [EFFECT_MIME], getData: (mime: string) => (mime === EFFECT_MIME ? type : '') },
      })
    /** Three pictures-in-waiting on V1, side by side, all selected. */
    const three = () => {
      const clips = [seedTitle(0), seedTitle(2.5), seedTitle(5)]
      useStore.getState().setUI({ selection: clips.map((c) => c.id) })
      return clips
    }
    const effectsOn = (id: string): string[] =>
      seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.effects.map((e) => e.type)

    it('lands on every selected clip, keeps the selection, and is one undo step', () => {
      const clips = three()
      render(<Timeline height={300} />)
      layOut()
      const middle = screen.getAllByTestId('clip').find((c) => c.dataset.clipId === clips[1]!.id)!
      const steps = useStore.getState().history.undo.length
      dropEffect(middle, 'saturation')
      expect(clips.map((c) => effectsOn(c.id))).toEqual([['saturation'], ['saturation'], ['saturation']])
      expect(useStore.getState().ui.selection).toEqual(clips.map((c) => c.id))
      expect(useStore.getState().history.undo.length).toBe(steps + 1)
      useStore.getState().undo()
      expect(clips.map((c) => effectsOn(c.id))).toEqual([[], [], []])
    })

    it('lands on just the clip it is dropped on when that clip is not in the selection', () => {
      const clips = three()
      const outside = seedTitle(8)
      render(<Timeline height={300} />)
      layOut()
      const el = screen.getAllByTestId('clip').find((c) => c.dataset.clipId === outside.id)!
      dropEffect(el, 'saturation')
      expect(effectsOn(outside.id)).toEqual(['saturation'])
      expect(clips.map((c) => effectsOn(c.id))).toEqual([[], [], []])
      // A drop on a lone clip still reveals it in the Inspector, as it always did.
      expect(useStore.getState().ui.selection).toEqual([outside.id])
    })
  })
})
