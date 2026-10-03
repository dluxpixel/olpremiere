// Parking or archiving the OPEN project survives undo and redo.
//
// MEASURED 2026-10-01 in his GYM: a split, GYM parked under Later, Ctrl+Z, and
// GYM was back under Working on, in the store and in its .olpbak file. Where a
// project sits on his shelf is not an edit, so no undo may move it.

import { beforeEach, describe, expect, it } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { defaultTitleDef, newProject, newTitleClip } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

/**
 * What persistence.ts `stampOpenProject` does to the live document when he
 * parks or files the project he has open: the flag goes on outside history.
 */
const stamp = (field: 'laterAt' | 'archivedAt', on: boolean): void => {
  const next = { ...useStore.getState().project }
  if (on) next[field] = 1790865113436
  else delete next[field]
  useStore.setState({ project: next })
}
const project = () => useStore.getState().project

/** One real edit, so there is something for Ctrl+Z to take back. */
function edit(): void {
  updateActiveSequence('Add title', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [newTitleClip(defaultTitleDef('Round 2'), 0, 2)] } : t)),
    }),
  )
}
const clipCount = () => Object.values(project().sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips)).length

beforeEach(() => {
  useStore.getState().setProject(newProject('GYM'))
})

describe('the shelf a project sits on is not an edit', () => {
  it('parking it, then Ctrl+Z of an earlier edit, leaves it parked', () => {
    edit()
    stamp('laterAt', true)
    useStore.getState().undo()
    // The edit came back out...
    expect(clipCount()).toBe(0)
    // ...and the project stayed exactly where he put it.
    expect(project().laterAt).toBe(1790865113436)
  })

  it('and redo leaves it parked too', () => {
    edit()
    useStore.getState().undo()
    stamp('laterAt', true)
    useStore.getState().redo()
    expect(clipCount()).toBe(1)
    expect(project().laterAt).toBe(1790865113436)
  })

  it('archiving it survives undo the same way', () => {
    edit()
    stamp('archivedAt', true)
    useStore.getState().undo()
    expect(project().archivedAt).toBe(1790865113436)
  })

  it('taking it OFF the shelf survives undo as well, rather than parking it again', () => {
    stamp('laterAt', true)
    edit()
    stamp('laterAt', false)
    useStore.getState().undo()
    expect(clipCount()).toBe(0)
    expect(Object.hasOwn(project(), 'laterAt')).toBe(false)
  })
})
