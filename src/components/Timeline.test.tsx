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
import { EFFECT_MIME } from '../state/dnd'
import { clickedPasteTrack, setPasteTarget } from '../state/pasteTarget'
import { updateActiveSequence, useStore } from '../state/store'
import { Timeline } from './Timeline'
import { installManualRaf, installResizeObserver } from './timelineDomFixtures'
import { buildLaneInfos } from './timelineLanes'

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
  })
  // His words, 2026-10-04: *"selecting multiple images and putting effects on them that
  // actually apply to all of them."* An effect dragged from the Effects tab onto one of
  // several selected clips used to land on that clip alone and shrink the selection to it.
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
