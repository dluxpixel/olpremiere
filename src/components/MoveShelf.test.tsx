/**
 * @vitest-environment jsdom
 *
 * THE SHELF ITSELF, rendered, for the one gesture that has no other way to be
 * checked: adding a SECOND move to a clip.
 *
 * The state layer is tested against the document in moveActions.test.ts. What
 * cannot be reached from there is whether the panel offers the gesture, whether
 * one click spends it, and whether a chained clip draws a bar for each of its two
 * moves with each one's name on it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip, type Sequence } from '../engine/types'
import { applyMoveToSelection, movesOnClip } from '../state/moveActions'
import { updateActiveSequence, useStore } from '../state/store'
import { MoveShelf } from './MoveShelf'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

function seedClip(durS: number): Clip {
  const made = [newTitleClip(defaultTitleDef('x'), 0, durS)]
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: made } : t)) }),
  )
  return made[0]
}

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, punchDepth: 1.2, punchRiseFrames: 5 })
})

afterEach(cleanup)

/** The shelf redraws off the clip, so every assertion renders the clip as it is NOW. */
const show = (id: string): void => {
  cleanup()
  render(<MoveShelf clips={[clipById(id)]} />)
}

describe('the second move, from the panel', () => {
  it('offers the line only for a move something can follow', async () => {
    const clip = seedClip(6)
    useStore.getState().setUI({ selection: [clip.id] })

    // A clip with no move at all has nothing to chain after.
    show(clip.id)
    expect(screen.queryByTestId('add-second-move')).toBeNull()

    // Push in ends up close and stays there, so the picture would have to slide
    // back out on its own between the two. Not offered rather than refused.
    //
    // ⛔ AND IT SAYS WHY. Seven of the twelve tiles end up somewhere and stay, so
    // for most clips this is what he sees, and an absent control with no sentence
    // beside it reads as a broken feature rather than as a rule.
    applyMoveToSelection('pushIn')
    show(clip.id)
    expect(screen.queryByTestId('add-second-move')).toBeNull()
    expect(screen.getByTestId('no-second-move').textContent).toBe(
      'Push in ends up there and stays, so nothing can follow it',
    )

    applyMoveToSelection('inAndOut')
    show(clip.id)
    expect(screen.getByTestId('add-second-move')).toBeTruthy()
  })

  it('spends the arming on ONE click, and chains what he picks', async () => {
    const clip = seedClip(6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    show(clip.id)

    const user = userEvent.setup()
    await user.click(screen.getByTestId('add-second-move'))
    expect(screen.getByTestId('add-second-move').textContent).toContain('Pick the move')

    await user.click(screen.getByTestId('move-tile-leftThenRight'))
    expect(movesOnClip(clipById(clip.id)).map((m) => m.id)).toEqual(['inAndOut', 'leftThenRight'])

    // ⛔ ONE SHOT. The next tile click has to REPLACE, the way every tile always
    // has, or the panel is carrying a mode he cannot see.
    show(clip.id)
    await user.click(screen.getByTestId('move-tile-shake'))
    expect(movesOnClip(clipById(clip.id)).map((m) => m.id)).toEqual(['shake'])
  })

  it('draws a bar for each move, names both, and lights both tiles', async () => {
    const clip = seedClip(6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    show(clip.id)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('add-second-move'))
    await user.click(screen.getByTestId('move-tile-leftThenRight'))

    show(clip.id)
    expect(screen.getAllByTestId('move-ribbon')).toHaveLength(2)
    expect(screen.getByTestId('move-state').textContent).toBe('In and out, then Left, then right')
    expect(screen.getByTestId('move-tile-inAndOut').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('move-tile-leftThenRight').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('move-tile-shake').getAttribute('aria-pressed')).toBe('false')
    // The offer is gone: a clip holds two.
    expect(screen.queryByTestId('add-second-move')).toBeNull()
  })

  it('takes one half off and leaves the other', async () => {
    const clip = seedClip(6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    show(clip.id)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('add-second-move'))
    await user.click(screen.getByTestId('move-tile-leftThenRight'))

    show(clip.id)
    await user.click(screen.getByTestId('drop-move-inAndOut'))
    expect(movesOnClip(clipById(clip.id)).map((m) => m.id)).toEqual(['leftThenRight'])
  })
})
