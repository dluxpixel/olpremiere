// Q and W with nothing selected: which clip gets trimmed.
//
// Tracks are stored [V1, V2, A1, A2], and the old pick was the LAST clip under
// the playhead in that order: the song on A2. He pressed Q to cut the head of
// the gameplay he was watching and lost the first seconds of his music instead.

import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { topAndTail } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const av: MediaAsset = { id: 'av', name: 'gym.mp4', kind: 'video', blobKey: 'b', durationS: 60, hasAudio: true, hasVideo: true }
const song: MediaAsset = { id: 'song', name: 'song.mp3', kind: 'audio', blobKey: 's', durationS: 60, hasAudio: true, hasVideo: false }
const clipOf = (id: string): Clip => activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** V1 gameplay linked to A1, a caption on V2, a song on A2 under all of it. */
function seed(withPicture = true): void {
  useStore.getState().setProject({ ...newProject(), assets: { av, song } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0 && withPicture
          ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'vid', inS: 0, outS: 5, linkId: 'L' }] }
          : i === 1
            ? { ...t, clips: [{ ...newTitleClip(defaultTitleDef('hi'), 1, 3), id: 'cap' }] }
            : i === 2 && withPicture
              ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'aud', inS: 0, outS: 5, linkId: 'L' }] }
              : i === 3
                ? { ...t, clips: [{ ...newClipFromAsset(song, 0), id: 'music', inS: 0, outS: 30 }] }
                : t,
      ),
    }),
  )
  show.mockClear()
}

beforeEach(() => seed())

describe('Q and W with nothing selected trim the picture', () => {
  it('Q trims the gameplay and its sound, the song keeps its head', () => {
    useStore.getState().setUI({ selection: [], playheadS: 2 })
    topAndTail('in')
    expect(clipOf('vid').inS).toBeCloseTo(2, 9)
    expect(clipOf('aud').inS).toBeCloseTo(2, 9)
    expect(clipOf('music').inS).toBe(0)
  })

  it('W trims the gameplay tail, the song keeps its length', () => {
    useStore.getState().setUI({ selection: [], playheadS: 2 })
    topAndTail('out')
    expect(clipOf('vid').outS).toBeCloseTo(2, 9)
    expect(clipOf('aud').outS).toBeCloseTo(2, 9)
    expect(clipOf('music').outS).toBe(30)
  })

  it('a selected clip under the playhead still wins', () => {
    useStore.getState().setUI({ selection: ['music'], playheadS: 2 })
    topAndTail('in')
    expect(clipOf('music').inS).toBeCloseTo(2, 9)
    expect(clipOf('vid').inS).toBe(0)
  })

  it('with no picture under the playhead a title comes before the song', () => {
    seed(false)
    useStore.getState().setUI({ selection: [], playheadS: 2 })
    topAndTail('out')
    expect(clipOf('music').outS).toBe(30)
    // The caption ran 1 to 4; W at 2 leaves it 1 s long.
    const cap = clipOf('cap')
    expect((cap.outS - cap.inS) / cap.speed).toBeCloseTo(1, 9)
  })
})
