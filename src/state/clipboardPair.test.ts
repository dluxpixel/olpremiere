// Copy and Duplicate on the picture half of a pair.
//
// One click selects one half, so Ctrl+C, Ctrl+V on his gameplay used to copy the
// picture alone. A lone picture is unlinked, and an unlinked picture plays its
// file's own sound at 0 dB, hidden: not the -18 dB he set on the A1 half, and
// with no audio clip anywhere to see or change it.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, audioTracks, newClipFromAsset, newProject, videoTracks, type MediaAsset } from '../engine/types'
import { copySelection, cutSelection, duplicateSelection, pasteAtPlayhead } from './clipboard'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const av: MediaAsset = { id: 'av', name: 'gym.mp4', kind: 'video', blobKey: 'b', durationS: 60, hasAudio: true, hasVideo: true }
const seq = () => activeSequence(useStore.getState().project)
const fresh = () => seq().tracks.flatMap((t) => t.clips).filter((c) => c.id !== 'vid' && c.id !== 'aud')

beforeEach(() => {
  useStore.getState().setProject({ ...newProject(), assets: { av } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'vid', outS: 4, linkId: 'L' }] }
          : i === 2
            ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'aud', outS: 4, linkId: 'L', audioGainDb: -18 }] }
            : t,
      ),
    }),
  )
  show.mockClear()
})

describe('the picture half brings its sound', () => {
  it('copy then paste makes a real pair, its sound on an audio line as he set it', () => {
    useStore.getState().setUI({ selection: ['vid'], playheadS: 0 })
    copySelection()
    expect(show).toHaveBeenCalledWith('Copied 1 clip and its sound', 'info')
    useStore.getState().setUI({ selection: [], playheadS: 10 })
    pasteAtPlayhead()
    const made = fresh()
    expect(made).toHaveLength(2)
    const pic = videoTracks(seq()).flatMap((t) => t.clips).find((c) => made.includes(c))!
    const snd = audioTracks(seq()).flatMap((t) => t.clips).find((c) => made.includes(c))!
    expect(pic.linkId).toBeDefined()
    expect(pic.linkId).not.toBe('L')
    expect(snd.linkId).toBe(pic.linkId)
    expect(snd.audioGainDb).toBe(-18)
  })

  it('a sound copied alone stays alone', () => {
    useStore.getState().setUI({ selection: ['aud'], playheadS: 0 })
    copySelection()
    expect(show).toHaveBeenCalledWith('Copied 1 clip', 'info')
    useStore.getState().setUI({ selection: [], playheadS: 10 })
    pasteAtPlayhead()
    expect(fresh()).toHaveLength(1)
  })

  it('Ctrl+D on the picture duplicates the pair', () => {
    useStore.getState().setUI({ selection: ['vid'] })
    duplicateSelection()
    const made = fresh()
    expect(made).toHaveLength(2)
    expect(made[0]!.linkId).toBe(made[1]!.linkId)
    expect(useStore.getState().ui.selection).toHaveLength(2)
  })

  it('Cut with nothing to cut says why, the way Copy does', () => {
    useStore.getState().setUI({ selection: [] })
    cutSelection()
    expect(show).toHaveBeenCalledWith('Select a clip to cut', 'danger')
    // The picture's sound on a locked track holds the pair whole.
    show.mockClear()
    updateActiveSequence('lock A1', (sq) => ({ ...sq, tracks: sq.tracks.map((t, i) => (i === 2 ? { ...t, locked: true } : t)) }))
    useStore.getState().setUI({ selection: ['vid'] })
    cutSelection()
    expect(seq().tracks[0].clips.map((c) => c.id)).toEqual(['vid'])
    expect(show).toHaveBeenCalledWith('Its linked partner is on a locked track, so the pair stays as it is', 'info')
    // And a clip on a locked track itself.
    show.mockClear()
    useStore.getState().setUI({ selection: ['aud'] })
    cutSelection()
    expect(show).toHaveBeenCalledWith('Those clips are on a locked track', 'danger')
  })

  it('Ctrl+D on a picture whose sound is on a locked track says why nothing came', () => {
    // The pair cannot land (its sound would go on the locked line), and a
    // shortcut that quietly does nothing reads as a broken key.
    updateActiveSequence('lock A1', (sq) => ({ ...sq, tracks: sq.tracks.map((t, i) => (i === 2 ? { ...t, locked: true } : t)) }))
    useStore.getState().setUI({ selection: ['vid'] })
    duplicateSelection()
    expect(fresh()).toHaveLength(0)
    expect(show).toHaveBeenCalledWith('Its sound is on a locked track, so it was not duplicated', 'danger')
  })
})
