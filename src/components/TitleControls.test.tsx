/**
 * @vitest-environment jsdom
 *
 * The title panel, through the real store.
 *
 * Box behind text starts as 60 percent black. The colour picker only holds
 * #rrggbb, so the first colour he picked made the box solid and nothing in the
 * panel could make it see through again, short of switching the box off and on,
 * which also threw the colour away (measured 2026-10-06). Same for the shadow.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip, type TitleDef } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { TitleControls } from './TitleControls'

const titleOf = (id: string): TitleDef =>
  activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.title!

/** The panel for the live clip, re rendered on every store change, the way the Inspector shows it. */
function Live({ id }: { id: string }) {
  const clip = useStore((s) => activeSequence(s.project).tracks.flatMap((t) => t.clips).find((c) => c.id === id))
  return clip ? <TitleControls clip={clip} /> : null
}

function seed(patch: Partial<TitleDef>): Clip {
  const clip = newTitleClip({ ...defaultTitleDef('hi'), ...patch }, 0, 3)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
  )
  return clip
}

/** Type a value into a scrub field and press Enter, the way he types a number. */
function typeInto(testId: string, value: string): void {
  const field = screen.getByTestId(testId)
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
})
afterEach(cleanup)

describe('the box and shadow colour keep their see through', () => {
  it('picking a box colour keeps the opacity, and the Opacity row sets it', () => {
    const c = seed({ box: { color: 'rgba(0,0,0,0.6)', paddingPx: 24, radiusPx: 8 } })
    render(<Live id={c.id} />)
    expect((screen.getByTestId('title-box-opacity') as HTMLInputElement).value).toBe('60')
    fireEvent.change(screen.getByTestId('title-box-color'), { target: { value: '#333333' } })
    expect(titleOf(c.id).box!.color).toBe('rgba(51,51,51,0.6)')
    typeInto('title-box-opacity', '100')
    expect(titleOf(c.id).box!.color).toBe('#333333')
    typeInto('title-box-opacity', '25')
    expect(titleOf(c.id).box!.color).toBe('rgba(51,51,51,0.25)')
  })

  it('picking a shadow colour keeps the opacity, and the Opacity row sets it', () => {
    const c = seed({ shadow: { color: 'rgba(0,0,0,0.6)', blurPx: 12, dx: 0, dy: 4 } })
    render(<Live id={c.id} />)
    fireEvent.change(screen.getByTestId('title-shadow-color'), { target: { value: '#ff0000' } })
    expect(titleOf(c.id).shadow!.color).toBe('rgba(255,0,0,0.6)')
    typeInto('title-shadow-opacity', '0')
    expect(titleOf(c.id).shadow!.color).toBe('rgba(255,0,0,0)')
  })
})
