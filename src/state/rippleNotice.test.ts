// The one line that says which tracks a ripple left where they were.
//
// The engine decides (engine/timeline.test.ts proves no clip ever lands on
// another); this covers what he is told about it, through the real verbs his
// keys call: Shift+Delete, Q and W.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { deleteSelected, topAndTail } from './clipEdits'
import { keptTimingMessage } from './rippleNotice'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = () => activeSequence(useStore.getState().project)
const asset: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const at = (id: string, startS: number, durS: number): Clip => ({ ...newClipFromAsset(asset, startS), id, inS: 0, outS: durS })

/**
 * mc night in miniature: V1 is the cut, 0 to 3 then 3 to 5. V2 holds a title
 * inside 0 to 3 and one after it; A2 holds a voice take inside and one after.
 * newProject() lays the tracks out as [V1, V2, A1, A2].
 */
function seed(): void {
  useStore.getState().setProject({ ...newProject(), assets: { v: asset } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? { ...t, clips: [at('cut', 0, 3), at('next', 3, 2)] }
          : i === 1
            ? { ...t, clips: [at('title1', 1, 1), at('title2', 3, 1)] }
            : i === 3
              ? { ...t, clips: [at('voice1', 0.5, 2), at('voice2', 3, 1.5)] }
              : t,
      ),
    }),
  )
  show.mockClear()
}

const said = (): string[] => show.mock.calls.map((c) => String(c[0]))

beforeEach(seed)

describe('a ripple says which tracks kept their timing', () => {
  it('Shift+Delete names both tracks in ONE toast, and nothing lands on anything', () => {
    useStore.getState().setUI({ selection: ['cut'] })
    deleteSelected(true)
    expect(said()).toEqual(['V2 and A2 kept their timing: something on them sits in the part you cut'])
    const v2 = seq().tracks[1].clips.map((c) => c.startS)
    expect(v2).toEqual([1, 3])
  })

  it('Q says it too', () => {
    useStore.getState().setUI({ selection: ['cut'], playheadS: 2.5 })
    topAndTail('in')
    expect(said()).toEqual(['V2 and A2 kept their timing: something on them sits in the part you cut'])
  })

  it('W says it too', () => {
    useStore.getState().setUI({ selection: ['cut'], playheadS: 0.5 })
    topAndTail('out')
    expect(said()).toEqual(['V2 and A2 kept their timing: something on them sits in the part you cut'])
  })

  it('says nothing when every track followed', () => {
    // Deleting the LAST clip removes time with nothing after it on any track.
    useStore.getState().setUI({ selection: ['next'] })
    deleteSelected(true)
    expect(said()).toEqual([])
  })

  it('a plain Delete moves nothing, so it never says it', () => {
    useStore.getState().setUI({ selection: ['cut'] })
    deleteSelected(false)
    expect(said()).toEqual([])
  })
})

describe('keptTimingMessage', () => {
  it('reads like a sentence for one, two and three tracks', () => {
    const s = seq()
    const id = (i: number) => s.tracks[i].id
    expect(keptTimingMessage(s, { heldTrackIds: [] })).toBeNull()
    expect(keptTimingMessage(s, { heldTrackIds: [id(1)] })).toBe('V2 kept its timing: something on it sits in the part you cut')
    // Named in the timeline's own order, whatever order they were held in.
    expect(keptTimingMessage(s, { heldTrackIds: [id(3), id(1), id(2)] })).toBe(
      'V2, A1 and A2 kept their timing: something on them sits in the part you cut',
    )
  })
})
