// Deleting a whole track from its header, his ask of 2026-07-29: "when you
// right-click these audio and video tracks, you can right-click to delete them".
//
// The header toggles were already one undo step each; this proves the delete is
// too, that it takes the clips with it, and that it refuses in the two cases
// where going ahead would leave him worse off than before he clicked.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasts: string[] = []
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))

import {
  activeSequence,
  audioTracks,
  defaultTitleDef,
  migrateProject,
  newClipFromAsset,
  newProject,
  newTitleClip,
  videoTracks,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { clipEmitsAudioOn } from '../engine/audio'
import { addTrack, recomputeDuration } from '../engine/timeline'
import { updateActiveSequence, useStore } from './store'
import { deleteTrack } from './trackEdits'

const seq = (): Sequence => activeSequence(useStore.getState().project)

beforeEach(() => {
  toasts.length = 0
  useStore.setState({ project: newProject(), ui: { ...useStore.getState().ui, selection: [] } })
})

/** A second video track carrying one title clip, and its ids. */
function seedSecondVideoTrack(): { trackId: string; clipId: string } {
  const clip = newTitleClip(defaultTitleDef('doomed'), 0, 1)
  let trackId = ''
  updateActiveSequence('seed', (sq) => {
    const grown = addTrack(sq, 'video')
    const target = videoTracks(grown)[videoTracks(grown).length - 1]
    trackId = target.id
    return {
      ...grown,
      tracks: grown.tracks.map((t) => (t.id === target.id ? { ...t, clips: [clip] } : t)),
    }
  })
  return { trackId, clipId: clip.id }
}

describe('deleteTrack', () => {
  it('removes the track and everything on it in ONE undo step', () => {
    const before = videoTracks(seq()).length
    const { trackId, clipId } = seedSecondVideoTrack()
    expect(videoTracks(seq())).toHaveLength(before + 1)

    deleteTrack(trackId)
    expect(seq().tracks.some((t) => t.id === trackId)).toBe(false)
    expect(seq().tracks.flatMap((t) => t.clips).some((c) => c.id === clipId)).toBe(false)

    // One step back and BOTH the track and its clip return together.
    useStore.getState().undo()
    expect(seq().tracks.some((t) => t.id === trackId)).toBe(true)
    expect(seq().tracks.flatMap((t) => t.clips).some((c) => c.id === clipId)).toBe(true)
  })

  it('clears a selection that lived on the dead track', () => {
    const { trackId, clipId } = seedSecondVideoTrack()
    useStore.getState().setUI({ selection: [clipId] })
    deleteTrack(trackId)
    // Otherwise the Inspector keeps editing a clip that exists nowhere.
    expect(useStore.getState().ui.selection).not.toContain(clipId)
  })

  it('refuses a LOCKED track, and says so', () => {
    const { trackId } = seedSecondVideoTrack()
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.id === trackId ? { ...t, locked: true } : t)),
    }))
    deleteTrack(trackId)
    expect(seq().tracks.some((t) => t.id === trackId)).toBe(true)
    expect(toasts.join(' ')).toContain('locked')
  })

  it('refuses the LAST track of its kind, so the sequence always has somewhere to drop a clip', () => {
    // Delete down to one of each, which is allowed, then the next one is not.
    for (const pick of [videoTracks, audioTracks]) {
      while (pick(seq()).length > 1) deleteTrack(pick(seq())[pick(seq()).length - 1].id)
      expect(pick(seq())).toHaveLength(1)
      toasts.length = 0
      deleteTrack(pick(seq())[0].id)
      expect(pick(seq())).toHaveLength(1)
      expect(toasts.join(' ')).toContain('last')
    }
  })

  it('does nothing for a track id that is not there', () => {
    const before = seq().tracks.length
    expect(() => deleteTrack('no-such-track')).not.toThrow()
    expect(seq().tracks).toHaveLength(before)
  })
})

// Deleting the sound half of a pair one clip at a time was remembered; deleting
// the whole audio line was not, so the next open gave every picture its own
// sound back: sound he deleted, with no clip anywhere to show where it came from.
describe('deleting an audio track keeps its pictures silent', () => {
  const av: MediaAsset = { id: 'av', name: 'gym.mp4', kind: 'video', blobKey: 'b', durationS: 60, hasAudio: true, hasVideo: true }
  const clipById = (id: string) => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)

  function seedPair(): string {
    useStore.getState().setProject({ ...newProject(), assets: { av } })
    updateActiveSequence('seed', (sq) => {
      const grown = addTrack(sq, 'audio') // a second audio line, so A1 can go
      return recomputeDuration({
        ...grown,
        tracks: grown.tracks.map((t) =>
          t.id === videoTracks(grown)[0].id
            ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'vid', outS: 5, linkId: 'L' }] }
            : t.id === audioTracks(grown)[0].id
              ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'aud', outS: 5, linkId: 'L' }] }
              : t,
        ),
      })
    })
    return audioTracks(seq())[0].id
  }

  it('stays silent after the project is opened again', () => {
    deleteTrack(seedPair())
    expect(clipEmitsAudioOn('video', clipById('vid')!)).toBe(false)
    const reopened = activeSequence(migrateProject(useStore.getState().project))
    const vid = reopened.tracks.flatMap((t) => t.clips).find((c) => c.id === 'vid')!
    expect(clipEmitsAudioOn('video', vid)).toBe(false)
  })

  it('one undo brings the track and the pair back, linked and playing', () => {
    deleteTrack(seedPair())
    useStore.getState().undo()
    expect(clipById('aud')?.linkId).toBe('L')
    expect(clipById('vid')?.linkId).toBe('L')
    expect(clipById('vid')?.ownAudioOff).toBeUndefined()
  })
})
