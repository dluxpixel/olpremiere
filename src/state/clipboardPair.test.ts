// Copy and Duplicate on the picture half of a pair.
//
// One click selects one half, so Ctrl+C, Ctrl+V on his gameplay used to copy the
// picture alone. A lone picture is unlinked, and an unlinked picture plays its
// file's own sound at 0 dB, hidden: not the -18 dB he set on the A1 half, and
// with no audio clip anywhere to see or change it.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, audioTracks, newClipFromAsset, newProject, videoTracks, type MediaAsset } from '../engine/types'
import { benchRatio } from '../engine/perfRatio'
import { copySelection, cutSelection, duplicateSelection, pasteAtPlayhead, selectAllClips } from './clipboard'
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

  // Copy takes the picture's sound along, and pasteClips refused a pair whose
  // sound line was locked: the same keys that pasted the picture before pasted
  // nothing, with a toast about a locked track for a picture on an open V1.
  it('copy then paste with the sound line locked: the pair lands, its sound on the next free line, and says so', () => {
    updateActiveSequence('lock A1', (sq) => ({ ...sq, tracks: sq.tracks.map((t, i) => (i === 2 ? { ...t, locked: true } : t)) }))
    useStore.getState().setUI({ selection: ['vid'], playheadS: 0 })
    copySelection()
    show.mockClear()
    useStore.getState().setUI({ selection: [], playheadS: 10 })
    pasteAtPlayhead()
    const made = fresh()
    expect(made).toHaveLength(2)
    const pic = seq().tracks[0]!.clips.find((c) => made.includes(c))!
    const snd = seq().tracks[3]!.clips.find((c) => made.includes(c))!
    expect(pic.startS).toBe(10)
    expect(snd.startS).toBe(10)
    expect(snd.linkId).toBe(pic.linkId)
    expect(snd.audioGainDb).toBe(-18)
    // The locked line itself is untouched.
    expect(seq().tracks[2]!.clips.map((c) => c.id)).toEqual(['aud'])
    expect(show.mock.calls).toEqual([['A1 is locked, so its sound went on A2', 'info']])
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

  // Measured from the sound as well, a J cut put the copy's picture 2 s after
  // the original's end: a hole on V1 where Ctrl+D always butted it.
  it('Ctrl+D on a picture with a J cut sound butts the copy against it, and says where the sound went', () => {
    updateActiveSequence('J cut', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) =>
          i === 0
            ? { ...t, clips: [{ ...t.clips[0]!, startS: 1, inS: 1, outS: 4 }] }
            : i === 2
              ? { ...t, clips: [{ ...t.clips[0]!, startS: 0, inS: 0, outS: 5 }] }
              : t,
        ),
      }),
    )
    show.mockClear()
    useStore.getState().setUI({ selection: ['vid'] })
    duplicateSelection()
    const made = fresh()
    expect(made).toHaveLength(2)
    const pic = seq().tracks[0]!.clips.find((c) => made.includes(c))!
    const snd = seq().tracks[3]!.clips.find((c) => made.includes(c))!
    expect(pic.startS).toBe(4)
    // Still a J cut: its sound leads its picture by the same second.
    expect(snd.startS).toBe(3)
    expect(snd.linkId).toBe(pic.linkId)
    expect(show).toHaveBeenCalledWith('A1 is busy at that time, so the clip went on A2', 'info')
  })

  it('Cut with nothing to cut says why, the way Copy does', () => {
    useStore.getState().setUI({ selection: [] })
    cutSelection()
    expect(show).toHaveBeenCalledWith('Select a clip to cut', 'info')
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

describe('Copy stays linear in the clip count', () => {
  // withPictureSound found each picture's group with clipGroupIds, a findClip
  // plus a scan of every clip, and serializeClips found each clip with a
  // findClip of its own: Ctrl+A, Ctrl+C on a long edit was O(selection x clips).
  //
  // A ratio to the yardstick, as the close gap budgets (perfRatio.ts). Measured
  // on this machine, 2026-10-08, at 4000 pairs: the old code 16283x and 16942x
  // (355 and 428 ms); one pass 1266x, 1461x, 1647x and 2208x (54 to 65 ms, most
  // of it the structuredClone of each clip, which is linear and stays). 6000 is
  // about 2.7 times the worst of those, and the old code reads 2.7 times over it.
  const BUDGET_RATIO = 6000
  it('Ctrl+A, Ctrl+C on 4000 pairs stays inside its budget', () => {
    const n = 4000
    const pair = (prefix: string, k: number) => ({ ...newClipFromAsset(av, k), id: `${prefix}${k}`, outS: 0.5, linkId: `L${k}` })
    updateActiveSequence('long edit', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) =>
          i === 0
            ? { ...t, clips: Array.from({ length: n }, (_, k) => pair('v', k)) }
            : i === 2
              ? { ...t, clips: Array.from({ length: n }, (_, k) => pair('a', k)) }
              : t,
        ),
      }),
    )
    selectAllClips()
    expect(useStore.getState().ui.selection).toHaveLength(2 * n)
    copySelection()
    const { ratio, perCallMs } = benchRatio(() => void copySelection(), 1, 5)
    expect(ratio, `Copy ran at ${ratio.toFixed(1)}x the yardstick (${perCallMs.toFixed(1)} ms)`).toBeLessThan(BUDGET_RATIO)
    expect(show).toHaveBeenLastCalledWith(`Copied ${2 * n} clips`, 'info')
  })
})
