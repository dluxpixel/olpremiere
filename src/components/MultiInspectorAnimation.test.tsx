/**
 * @vitest-environment jsdom
 *
 * Select two titles and the multi Inspector offered an "Animation" row with the
 * entrance alone: no Out, no Speed, so a whole Short of captions could pop in
 * from the panel and never fade out from it (2026-10-06). It now has the same In,
 * Out and Speed rows as one title's panel, on every selected title, through the
 * real store.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type AppearanceSpec, type Clip } from '../engine/types'
import { setClipsAppearance } from '../state/appearanceActions'
import { updateActiveSequence, useStore } from '../state/store'
import { MultiInspector, type SelectedClip } from './MultiInspector'
import { installResizeObserver } from './timelineDomFixtures'

const seq = () => activeSequence(useStore.getState().project)
const appearanceOf = (ids: string[]): (AppearanceSpec | undefined)[] =>
  ids.map((id) => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.appearance)

/** Two captions back to back on V1. */
function twoTitles(): string[] {
  const clips: Clip[] = [0, 1].map((i) => newTitleClip(defaultTitleDef(`w${i}`), i, 1))
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.name === 'V1' ? { ...t, clips } : t)) }),
  )
  return clips.map((c) => c.id)
}

const selectedOf = (ids: string[]): SelectedClip[] =>
  seq().tracks.flatMap((track) =>
    track.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ clip, track, emitsAudio: false })),
  )

/** The panel re rendered on every store change, the way the Inspector shows it. */
function Live({ ids }: { ids: string[] }) {
  useStore((s) => s.project)
  return <MultiInspector selected={selectedOf(ids)} />
}

beforeEach(() => {
  installResizeObserver()
  useStore.getState().setProject(newProject())
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the multi Inspector Animation rows, two titles selected', () => {
  it('In, Out and Speed reach every selected title', async () => {
    const ids = twoTitles()
    render(<Live ids={ids} />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByTestId('multi-animation'), 'pop')
    await user.selectOptions(screen.getByTestId('multi-animation-out'), 'fadeOut')
    expect(appearanceOf(ids).map((a) => [a?.in, a?.out])).toEqual([
      ['pop', 'fadeOut'],
      ['pop', 'fadeOut'],
    ])
    await user.selectOptions(screen.getByTestId('multi-animation-speed'), '0.1')
    expect(appearanceOf(ids).map((a) => a?.durS)).toEqual([0.1, 0.1])
    // One undo takes the speed back off both.
    useStore.getState().undo()
    expect(appearanceOf(ids).map((a) => a?.durS === 0.1)).toEqual([false, false])
  })
})

// Review, 2026-10-07: the rows showed the FIRST title's animation. One popping
// and one not read Pop, and picking Pop fired nothing, so the second never got
// it; Speed hid whenever the first title was still.
describe('the Animation rows when the titles disagree', () => {
  const popFirst = (ids: string[], durS = 0.25) => setClipsAppearance([ids[0]!], { in: 'pop', durS })

  it('In reads Mixed, and picking Pop reaches the title that did not pop', async () => {
    const ids = twoTitles()
    popFirst(ids)
    render(<Live ids={ids} />)
    expect((screen.getByTestId('multi-animation') as HTMLSelectElement).value).toBe('mixed')
    await userEvent.setup().selectOptions(screen.getByTestId('multi-animation'), 'pop')
    expect(appearanceOf(ids).map((a) => a?.in)).toEqual(['pop', 'pop'])
  })

  it('Speed shows when only a later title moves, and reads Mixed when their speeds differ', () => {
    const ids = twoTitles()
    setClipsAppearance([ids[1]!], { in: 'pop', durS: 0.25 })
    const { unmount } = render(<Live ids={ids} />)
    expect(screen.getByTestId('multi-animation-speed')).toBeTruthy()
    unmount()
    popFirst(ids, 0.1)
    render(<Live ids={ids} />)
    expect((screen.getByTestId('multi-animation-speed') as HTMLSelectElement).value).toBe('mixed')
  })
})
