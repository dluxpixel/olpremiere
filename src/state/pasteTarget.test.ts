/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node, for the page's clipboard.
 */

// His words, 2026-10-04, with a screenshot of a picture on V2: *"I click and paste
// it on that. It pastes it at the right time, but make sure it also pastes it on
// the same line because I clicked the V4."* Ctrl+V used to ignore every click:
// pasted clips went back to the line they were copied from, a pasted picture to V2.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addTrack, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { copySelection, pasteAt, pasteAtPlayhead } from './clipboard'
import { clickedPasteTrack, setPasteTarget, usePasteTarget } from './pasteTarget'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const said = (): string[] => show.mock.calls.map((c) => String(c[0]))
const line = (name: string) => seq().tracks.find((t) => t.name === name)!
const clipsOn = (name: string): Clip[] => line(name).clips
const title = (id: string, startS = 0, durS = 2): Clip => ({ ...newTitleClip(defaultTitleDef(id), startS, durS), id })

/** A project with V1 to V4 and A1, A2, and these clips on these lines. */
function lay(byLine: Record<string, Clip[]>): void {
  useStore.getState().setProject(newProject('paste target'))
  updateActiveSequence('seed', (sq) => {
    let next = addTrack(addTrack(sq, 'video'), 'video')
    next = { ...next, tracks: next.tracks.map((t) => (byLine[t.name] ? { ...t, clips: byLine[t.name]! } : t)) }
    return recomputeDuration(next)
  })
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  setPasteTarget(null)
  show.mockClear()
}

/** Select these clips, copy them, and leave nothing selected, the way a click on empty space does. */
function copy(ids: string[]): void {
  useStore.getState().setUI({ selection: ids })
  expect(copySelection()).toBe(true)
  useStore.getState().setUI({ selection: [] })
  show.mockClear()
}

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })
})
afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'clipboard')
})

describe('Ctrl+V onto the line he clicked', () => {
  it('puts the clip on V4 at the playhead when V4 is the line he clicked, not back on V2', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    setPasteTarget(line('V4').id)
    useStore.getState().setUI({ playheadS: 5 })

    pasteAtPlayhead()

    expect(clipsOn('V4')).toHaveLength(1)
    expect(clipsOn('V4')[0]!.startS).toBe(5)
    expect(clipsOn('V2')).toHaveLength(1)
    expect(said()).toEqual([])
  })

  it('still puts a clip back on its own line when he has clicked no line', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    useStore.getState().setUI({ playheadS: 5 })

    pasteAtPlayhead()

    expect(clipsOn('V2').map((c) => c.startS).sort()).toEqual([0, 5])
    expect(clipsOn('V4')).toHaveLength(0)
  })

  it('keeps the top clip on the clicked line and the others in their lanes under it', () => {
    lay({ V2: [title('low')], V3: [title('high')] })
    copy(['low', 'high'])
    setPasteTarget(line('V4').id)
    useStore.getState().setUI({ playheadS: 6 })

    pasteAtPlayhead()

    expect(clipsOn('V4')).toHaveLength(1)
    expect(clipsOn('V4')[0]!.startS).toBe(6)
    // The original V3 is untouched, and the other pasted clip sits on V3 next to it.
    expect(clipsOn('V3').map((c) => c.startS).sort()).toEqual([0, 6])
    expect(clipsOn('V2')).toHaveLength(1)
  })

  it('is one undo step', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    setPasteTarget(line('V4').id)
    const steps = useStore.getState().history.undo.length

    pasteAtPlayhead()
    expect(clipsOn('V4')).toHaveLength(1)
    expect(useStore.getState().history.undo.length).toBe(steps + 1)
    useStore.getState().undo()

    expect(clipsOn('V4')).toHaveLength(0)
  })

  it('says where the clip went when the clicked line is busy there, and deletes nothing', () => {
    lay({ V2: [title('copied')], V4: [title('busy', 4, 6)] })
    copy(['copied'])
    setPasteTarget(line('V4').id)
    useStore.getState().setUI({ playheadS: 5 })

    pasteAtPlayhead()

    expect(clipsOn('V4').map((c) => c.id)).toEqual(['busy'])
    expect(clipsOn('V4')[0]).toMatchObject({ startS: 4 })
    // V5 did not exist: the clip went on a new line above, at its own time.
    expect(seq().tracks.some((t) => t.name === 'V5' && t.clips.length === 1 && t.clips[0]!.startS === 5)).toBe(true)
    expect(said()).toEqual(['V4 is busy at that time, so the clip went on V5'])
  })

  it('says so when the clicked line is audio and the copied clip is a picture', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    setPasteTarget(line('A1').id)
    useStore.getState().setUI({ playheadS: 5 })

    pasteAtPlayhead()

    expect(clipsOn('A1')).toHaveLength(0)
    expect(clipsOn('V2')).toHaveLength(2)
    expect(said()).toEqual(['A1 is an audio track, so what you copied went back on the tracks it came from'])
  })

  it('refuses a locked clicked line out loud and puts the clip nowhere else', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    updateActiveSequence('lock', (sq) => ({ ...sq, tracks: sq.tracks.map((t) => (t.name === 'V4' ? { ...t, locked: true } : t)) }))
    setPasteTarget(line('V4').id)

    pasteAtPlayhead()

    expect(seq().tracks.flatMap((t) => t.clips)).toHaveLength(1)
    expect(said()).toEqual(['That clip belongs on a locked track'])
  })

  it('lifts a stack that would not fit under the clicked line, and says so', () => {
    lay({ V2: [title('low')], V3: [title('high')] })
    copy(['low', 'high'])
    setPasteTarget(line('V1').id)
    useStore.getState().setUI({ playheadS: 6 })

    pasteAtPlayhead()

    expect(clipsOn('V1').map((c) => c.startS)).toEqual([6])
    expect(clipsOn('V2').map((c) => c.startS).sort()).toEqual([0, 6])
    expect(said()).toEqual(['The copied clips would not fit under V1, so they sit one track higher to keep their shape'])
  })

  it('selects what it pasted and keeps the clicked line for the next paste', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    setPasteTarget(line('V4').id)
    useStore.getState().setUI({ playheadS: 5 })

    pasteAtPlayhead()

    expect(useStore.getState().ui.selection).toEqual([clipsOn('V4')[0]!.id])
    expect(usePasteTarget.getState().trackId).toBe(line('V4').id)
    useStore.getState().setUI({ playheadS: 9 })
    pasteAtPlayhead()
    expect(clipsOn('V4').map((c) => c.startS).sort()).toEqual([5, 9])
  })

  it('right click Paste here still lands on the line it was clicked on', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])

    pasteAt(seq().tracks.findIndex((t) => t.name === 'V3'), 4)

    expect(clipsOn('V3').map((c) => c.startS)).toEqual([4])
  })
})

describe('the line he clicked', () => {
  it('is forgotten the moment he picks a clip', () => {
    lay({ V2: [title('copied')] })
    setPasteTarget(line('V4').id)
    useStore.getState().setUI({ selection: ['copied'] })
    expect(usePasteTarget.getState().trackId).toBeNull()
    expect(clickedPasteTrack(seq())).toBeNull()
  })

  it('survives clearing the selection, which is what a click on empty space does', () => {
    lay({ V2: [title('copied')] })
    useStore.getState().setUI({ selection: ['copied'] })
    useStore.getState().setUI({ selection: [] })
    setPasteTarget(line('V4').id)
    useStore.getState().setUI({ selection: [] })
    expect(clickedPasteTrack(seq())?.name).toBe('V4')
  })

  it('stops meaning anything once the line is deleted, and the paste goes where it used to', () => {
    lay({ V2: [title('copied')] })
    copy(['copied'])
    setPasteTarget(line('V4').id)
    updateActiveSequence('delete V4', (sq) => ({ ...sq, tracks: sq.tracks.filter((t) => t.name !== 'V4') }))
    useStore.getState().setUI({ playheadS: 5 })

    pasteAtPlayhead()

    expect(clickedPasteTrack(seq())).toBeNull()
    expect(clipsOn('V2').map((c) => c.startS).sort()).toEqual([0, 5])
    expect(said()).toEqual([])
  })
})
