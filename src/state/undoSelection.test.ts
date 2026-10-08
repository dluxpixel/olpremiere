// What an undo or a redo leaves selected, and the time it stamps.
//
// His ask, 2026-10-03: "C would not cut". One way in: add a title (it is
// selected), Ctrl+Z, and the title is gone but its id was still selected, so C
// narrowed the cut to a clip that no longer existed and said "Playhead isn't
// over a selected clip" with nothing on screen selected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { splitAtPlayhead } from './clipEdits'
import { updateActiveSequence, useStore } from './store'
import { addTitleClip } from './titleActions'

const toasts: string[] = []
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))

const ui = () => useStore.getState().ui
const clips = () => activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)

/** A clip on the first video track, [startS, startS + 5]. */
function seed(startS: number, trackIndex = 0): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), startS, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

beforeEach(() => {
  toasts.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, motionPicks: [], motionSelection: null })
})

describe('undo and redo keep only clips that are still there selected', () => {
  it('a title he added and took back is no longer selected', () => {
    addTitleClip('Round 2')
    expect(ui().selection).toHaveLength(1)
    useStore.getState().undo()
    expect(ui().selection).toEqual([])
  })

  it('so C cuts the clip under the playhead right after', () => {
    const a = seed(0)
    useStore.getState().setUI({ selection: [a.id], playheadS: 2 })
    addTitleClip('Round 2')
    useStore.getState().undo()
    splitAtPlayhead()
    expect(toasts).not.toContain("Playhead isn't over a selected clip")
    // The one clip, cut in two at the playhead.
    expect(clips().map((c) => c.startS).sort()).toEqual([0, 2])
  })

  it('keeps the clips that survive, and drops the moments picked on the one that went', () => {
    const a = seed(0)
    const b = seed(0, 1)
    useStore.getState().undo() // takes b back out
    useStore.getState().setUI({ selection: [a.id, b.id] })
    useStore.getState().redo() // b again, nothing to prune
    useStore.getState().setUI({
      selection: [a.id, b.id],
      motionPicks: [{ channel: 'scale', t: 1 }],
      motionSelection: { channel: 'scale', kind: 'key', t: 1 },
    })
    useStore.getState().undo()
    expect(ui().selection).toEqual([a.id])
    expect(ui().motionPicks).toEqual([])
    expect(ui().motionSelection).toBeNull()
  })

  it('a redo that deletes a selected clip again lets go of it', () => {
    const a = seed(0)
    updateActiveSequence('Delete', (sq) => ({ ...sq, tracks: sq.tracks.map((t) => ({ ...t, clips: [] })) }))
    useStore.getState().undo()
    useStore.getState().setUI({ selection: [a.id] })
    useStore.getState().redo()
    expect(ui().selection).toEqual([])
  })

  it('an undo that removes nothing selected leaves the selection and the picks alone', () => {
    const a = seed(0)
    seed(6)
    const picks = [{ channel: 'scale' as const, t: 1 }]
    useStore.getState().setUI({ selection: [a.id], motionPicks: picks })
    useStore.getState().undo()
    expect(ui().selection).toEqual([a.id])
    expect(ui().motionPicks).toBe(picks)
  })
})

describe('the time an undo stamps', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is now, so Projects keeps the project where he last worked on it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    seed(0)
    vi.setSystemTime(2000)
    seed(6)
    vi.setSystemTime(3000)
    useStore.getState().undo()
    expect(useStore.getState().project.updatedAt).toBe(3000)
    vi.setSystemTime(4000)
    useStore.getState().redo()
    expect(useStore.getState().project.updatedAt).toBe(4000)
  })
})
