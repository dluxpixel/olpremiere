// A locked track holds through the link. He locks A1 to protect his voice take,
// then edits the picture on V1 with the keys: C, Q, W and Shift+Delete used to
// cut, trim and ripple delete the locked voice along with it.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type MediaAsset } from '../engine/types'
import { closeGapBeforeClip, crossfadeWithNeighbour, deleteSelected, PAIR_LOCKED_MESSAGE, splitAtPlayhead, topAndTail } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const av: MediaAsset = { id: 'av', name: 'gym.mp4', kind: 'video', blobKey: 'b', durationS: 60, hasAudio: true, hasVideo: true }
const seq = () => activeSequence(useStore.getState().project)
const said = (): string[] => show.mock.calls.map((c) => String(c[0]))

/** V1 picture 0 to 5 linked to its voice on A1 (locked); A2 two free sounds, butted. */
function seed(): void {
  useStore.getState().setProject({ ...newProject(), assets: { av } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'vid', outS: 5, linkId: 'L' }] }
          : i === 2
            ? { ...t, locked: true, clips: [{ ...newClipFromAsset(av, 0), id: 'voice', outS: 5, linkId: 'L' }] }
            : i === 3
              ? { ...t, locked: true, clips: [{ ...newClipFromAsset(av, 0), id: 's1', outS: 2 }, { ...newClipFromAsset(av, 2), id: 's2', inS: 2, outS: 4 }] }
              : t,
      ),
    }),
  )
  show.mockClear()
}

beforeEach(seed)

describe('a locked partner holds through the keys', () => {
  it('C cuts the picture and leaves the locked voice whole, and says so', () => {
    useStore.getState().setUI({ selection: [], playheadS: 2 })
    splitAtPlayhead()
    expect(seq().tracks[0].clips).toHaveLength(2)
    expect(seq().tracks[2].clips).toHaveLength(1)
    expect(said()).toEqual(['Its linked partner is on a locked track, so only the unlocked half was cut'])
  })

  it('Q and W leave the pair as it is, and say why', () => {
    useStore.getState().setUI({ selection: [], playheadS: 2 })
    const before = useStore.getState().project
    topAndTail('in')
    topAndTail('out')
    expect(useStore.getState().project).toBe(before)
    expect(said()).toEqual([PAIR_LOCKED_MESSAGE, PAIR_LOCKED_MESSAGE])
  })

  it('Shift+Delete on the picture leaves the pair, and says why', () => {
    useStore.getState().setUI({ selection: ['vid'] })
    const before = useStore.getState().project
    deleteSelected(true)
    expect(useStore.getState().project).toBe(before)
    expect(said()).toEqual([PAIR_LOCKED_MESSAGE])
  })

  // The gap he pointed at stayed open while the clips after the held pair slid
  // on, or nothing happened with no word at all.
  it('Close gap before a pair held by its locked partner moves nothing, and names the lock', () => {
    updateActiveSequence('make a gap', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) =>
          i === 0
            ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'first', outS: 1 }, { ...t.clips[0]!, startS: 2 }] }
            : i === 2
              ? { ...t, clips: [{ ...t.clips[0]!, startS: 2 }] }
              : t,
        ),
      }),
    )
    show.mockClear()
    const before = useStore.getState().project
    closeGapBeforeClip('vid')
    expect(useStore.getState().project).toBe(before)
    expect(said()).toEqual(['The gap stayed open: a clip after it is linked to one on A1, which is locked'])
  })

  it('a crossfade is not written onto a locked track', () => {
    const before = useStore.getState().project
    crossfadeWithNeighbour('s1', 'next')
    expect(useStore.getState().project).toBe(before)
  })
})
