/**
 * @vitest-environment jsdom
 *
 * A dozen edit tabs ran past the edge of the strip with no way to reach them by
 * mouse: no scrollbar, a wheel that moved nothing sideways, and an open tab that
 * could sit out of sight.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'

vi.mock('./ProjectsDialog', () => ({ ProjectsDialog: () => null }))
vi.mock('../state/toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { useEditTabs } = await import('../state/editTabs')
const { useStore } = await import('../state/store')
const { EditTabs } = await import('./EditTabs')

const intoView = vi.fn()

beforeEach(() => {
  Element.prototype.scrollIntoView = intoView
  intoView.mockClear()
  const open = { ...newProject('GYM'), id: 'p1' }
  useStore.getState().setProject(open)
  useEditTabs.setState({
    tabs: Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `Edit ${i + 1}` })),
    waking: null,
  })
})
afterEach(() => cleanup())

describe('the edit tab strip', () => {
  it('the mouse wheel scrolls it sideways', () => {
    render(<EditTabs />)
    const strip = screen.getByTestId('edit-tabs-strip')
    fireEvent.wheel(strip, { deltaY: 120 })
    expect(strip.scrollLeft).toBe(120)
    fireEvent.wheel(strip, { deltaY: -40 })
    expect(strip.scrollLeft).toBe(80)
  })

  it('brings the open tab into view whenever the open edit changes', () => {
    render(<EditTabs />)
    intoView.mockClear()
    act(() => useStore.getState().setProject({ ...newProject('Far right'), id: 'p12' }))
    expect(intoView).toHaveBeenCalledTimes(1)
    expect((intoView.mock.contexts[0] as HTMLElement).getAttribute('data-project-id')).toBe('p12')
  })

  it('lets a tab shrink to its smallest before the strip has to scroll', () => {
    render(<EditTabs />)
    const tab = screen.getAllByTestId('edit-tab')[0]!
    expect(tab.className).toMatch(/(^|\s)shrink(\s|$)/)
    expect(tab.className).not.toMatch(/shrink-0/)
    expect(tab.className).toMatch(/min-w-\[72px\]/)
  })
})
