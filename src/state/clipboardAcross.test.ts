/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node, for the page's clipboard.
 */

// Two clipboard verbs that used to do something he never asked for, without a
// word: a paste into another project dropped every video and audio clip, and
// Alt+Up/Down moved a clip seconds along the timeline. Both measured 2026-10-01
// on copies of his own projects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
} from '../engine/types'
import { copySelection, moveSelectionToAdjacentTrack, pasteAtPlayhead } from './clipboard'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = () => activeSequence(useStore.getState().project)
const said = (): string[] => show.mock.calls.map((c) => String(c[0]))
const footage: MediaAsset = {
  id: 'gym-footage',
  name: '15yo armwrestling.mp4',
  kind: 'video',
  blobKey: 'asset/gym-footage',
  durationS: 30,
  hasAudio: false,
  hasVideo: true,
}

/** Put clips on tracks by index. newProject() is [V1, V2, A1, A2]. */
function lay(byTrack: Record<number, Clip[]>): void {
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (byTrack[i] ? { ...t, clips: byTrack[i] } : t)) }),
  )
}

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })
  show.mockClear()
})

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'clipboard')
})

describe('a paste into another project', () => {
  /** GYM: a footage clip on V1 and a title on V2, both selected and copied. */
  function copyFromGym(): void {
    useStore.getState().setProject({ ...newProject('GYM'), assets: { [footage.id]: footage } })
    const clip = { ...newClipFromAsset(footage, 0), id: 'gym-clip' }
    const title = { ...newTitleClip(defaultTitleDef('national champion'), 0, 2), id: 'gym-title' }
    lay({ 0: [clip], 1: [title] })
    useStore.getState().setUI({ selection: ['gym-clip', 'gym-title'] })
    expect(copySelection()).toBe(true)
  }

  it('brings the footage clip AND its media record, not just the title', () => {
    copyFromGym()
    // He opens mc night, which has never seen that footage.
    useStore.getState().setProject(newProject('mc night'))
    useStore.getState().setUI({ selection: [], playheadS: 3 })
    show.mockClear()

    pasteAtPlayhead()

    const pasted = seq().tracks.flatMap((t) => t.clips)
    expect(pasted).toHaveLength(2)
    expect(pasted.some((c) => c.assetId === footage.id)).toBe(true)
    // Same id, same blobKey: the bytes he already has, never a second copy.
    expect(useStore.getState().project.assets[footage.id]).toEqual(footage)
    expect(said()).toEqual([])
  })

  it('is one undo step, and the undo takes the record back out with the clips', () => {
    copyFromGym()
    useStore.getState().setProject(newProject('mc night'))
    pasteAtPlayhead()
    useStore.getState().undo()
    expect(seq().tracks.flatMap((t) => t.clips)).toHaveLength(0)
    expect(useStore.getState().project.assets[footage.id]).toBeUndefined()
  })

  it('says plainly how many clips it could not bring, instead of dropping them in silence', () => {
    // The footage was deleted from GYM's bin BEFORE the copy, so its record is
    // nowhere this app can reach.
    useStore.getState().setProject(newProject('GYM'))
    lay({ 0: [{ ...newClipFromAsset(footage, 0), id: 'orphan' }], 1: [{ ...newTitleClip(defaultTitleDef('hi'), 0, 2), id: 't' }] })
    useStore.getState().setUI({ selection: ['orphan', 't'] })
    copySelection()
    useStore.getState().setProject(newProject('mc night'))
    show.mockClear()

    pasteAtPlayhead()

    expect(seq().tracks.flatMap((t) => t.clips)).toHaveLength(1)
    expect(said()).toEqual(['1 clip needs media that is not on this computer, so it was left out'])
  })
})

describe('Alt+Up/Down never moves a clip in time', () => {
  /** "Round 2" on V2 at 11 s, and V1 busy at that time. */
  function gym(): void {
    useStore.getState().setProject(newProject('GYM'))
    lay({
      0: [{ ...newTitleClip(defaultTitleDef('busy'), 10, 3), id: 'busy' }],
      1: [{ ...newTitleClip(defaultTitleDef('Round 2'), 11, 1), id: 'round2' }],
    })
    useStore.getState().setUI({ selection: ['round2'] })
    show.mockClear()
  }
  const where = (id: string) => {
    const s = seq()
    const track = s.tracks.find((t) => t.clips.some((c) => c.id === id))!
    return { track: track.name, startS: track.clips.find((c) => c.id === id)!.startS }
  }

  it('on a busy line it stays exactly where it was, and says why', () => {
    gym()
    moveSelectionToAdjacentTrack(1)
    // It used to land on V1 at 13 s, the nearest gap that fit.
    expect(where('round2')).toEqual({ track: 'V2', startS: 11 })
    expect(said()).toEqual(['V1 is busy at this time, so the clip stayed where it is'])
    expect(useStore.getState().history.undo.at(-1)?.label).toBe('seed')
  })

  it('on a free line it moves there at its own time, as before', () => {
    gym()
    lay({ 0: [] })
    moveSelectionToAdjacentTrack(1)
    expect(where('round2')).toEqual({ track: 'V1', startS: 11 })
    expect(said()).toEqual([])
  })
})
