/**
 * @vitest-environment jsdom
 *
 * DELETING PROJECTS WITHOUT THE DIALOG GOING AWAY (2026-10-03). His words: "make
 * it so that when you double-click and delete something, it doesn't erase the
 * screen. I don't want to click that again if I want to delete more projects."
 *
 * The trash button sits INSIDE the row, and the row opens its project on a double
 * click. Arming and confirming the delete is two quick clicks, which the browser
 * also reports as a double click on the row, so the second click deleted the
 * project and the row then OPENED it: the dialog closed (open() ends in onClose),
 * and the project came back, because opening writes it to storage again.
 *
 * Rendered, because the fault lives in how the events reach the row, which no
 * state-layer test can see.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'
import { useStore } from '../state/store'
import { ProjectsDialog } from './ProjectsDialog'

const saved = new Map<string, Project>()

vi.mock('../state/toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
vi.mock('../state/playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({
  useCollab: { getState: () => ({ session: null }) },
}))
// A store that answers a tick late, as IndexedDB does. The lag is what lets a stray
// open() land between a delete starting and finishing, so it has to be here.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
vi.mock('../state/persistence', async () => {
  const real = await vi.importActual<typeof import('../state/persistence')>('../state/persistence')
  return {
    ...real,
    saveNow: vi.fn(async () => {
      saved.set(useStore.getState().project.id, useStore.getState().project)
    }),
    // The save a switch makes on its way out (edit tabs, state/editTabs.ts).
    saveSettled: vi.fn(async () => {
      saved.set(useStore.getState().project.id, useStore.getState().project)
    }),
    saveProject: vi.fn(async (p: Project) => {
      await tick()
      saved.set(p.id, p)
    }),
    loadProjectById: vi.fn(async (id: string) => {
      await tick()
      return saved.get(id) ?? null
    }),
    deleteProject: vi.fn(async (id: string) => {
      await tick()
      saved.delete(id)
    }),
    listProjects: vi.fn(async () => {
      await tick()
      return [...saved.values()].map((p) => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
        assetCount: 0,
        clipCount: 0,
      }))
    }),
  }
})

function seed(name: string, updatedAt: number): Project {
  const p = { ...newProject(name), updatedAt }
  saved.set(p.id, p)
  return p
}

const rowOf = (name: string) => screen.getAllByTestId('project-row').find((r) => r.textContent?.includes(name))
// The name alone: the "open" tag after it lives in its own span.
const names = () =>
  screen.queryAllByTestId('project-row').map((r) => r.querySelector('.truncate')?.firstChild?.textContent ?? '')

beforeEach(() => {
  saved.clear()
  const open = seed('Open one', 100)
  useStore.getState().setProject(open)
})

afterEach(cleanup)

describe('deleting from the Projects dialog', () => {
  it('two projects in a row, on a double click each, and the dialog never closes', async () => {
    seed('Alpha', 90)
    seed('Bravo', 80)
    seed('Charlie', 70)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsDialog onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(4))
    const openId = useStore.getState().project.id

    // First click arms the trash button, second confirms: to the browser that is a
    // double click on the row too.
    await user.dblClick(within(rowOf('Alpha')!).getByTestId('project-delete'))
    await waitFor(() => expect(names()).not.toContain('Alpha'))
    await user.dblClick(within(rowOf('Bravo')!).getByTestId('project-delete'))
    await waitFor(() => expect(names()).not.toContain('Bravo'))

    // Still here, still the same project open, and the list is what is left.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('projects-dialog')).toBeTruthy()
    expect(useStore.getState().project.id).toBe(openId)
    expect(names()).toContain('Open one')
    expect(names()).toContain('Charlie')
    // And they are really gone: nothing opened them again behind the delete.
    await tick()
    await tick()
    expect([...saved.values()].map((p) => p.name).sort()).toEqual(['Charlie', 'Open one'])
  })

  it('two separate clicks per project works the same way', async () => {
    seed('Alpha', 90)
    seed('Bravo', 80)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsDialog onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(3))

    for (const name of ['Alpha', 'Bravo']) {
      const trash = within(rowOf(name)!).getByTestId('project-delete')
      await user.click(trash)
      await user.click(trash)
      await waitFor(() => expect(names()).not.toContain(name))
    }
    expect(onClose).not.toHaveBeenCalled()
    expect(names()).toEqual(['Open one'])
  })

  it('Enter on the trash button confirms the delete and does not open the project', async () => {
    seed('Alpha', 90)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsDialog onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(2))
    const openId = useStore.getState().project.id

    const trash = within(rowOf('Alpha')!).getByTestId('project-delete')
    trash.focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(names()).not.toContain('Alpha'))

    expect(onClose).not.toHaveBeenCalled()
    expect(useStore.getState().project.id).toBe(openId)
  })

  it('still opens a project from a double click on the row itself', async () => {
    const alpha = seed('Alpha', 90)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsDialog onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(2))

    await user.dblClick(rowOf('Alpha')!)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(useStore.getState().project.id).toBe(alpha.id)
  })

  it('the project that is open can be deleted safely: another opens first, the dialog stays', async () => {
    const alpha = seed('Alpha', 90)
    seed('Bravo', 80)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsDialog onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(3))
    const openId = useStore.getState().project.id

    await user.dblClick(within(rowOf('Open one')!).getByTestId('project-delete'))
    await waitFor(() => expect(saved.has(openId)).toBe(false))

    // The most recently touched other project took its place, so the editor never
    // holds a project that no longer exists (an autosave would write it straight back).
    expect(useStore.getState().project.id).toBe(alpha.id)
    await waitFor(() => expect(names()).not.toContain('Open one'))
    expect(onClose).not.toHaveBeenCalled()
    // The open marker moved with it.
    expect(rowOf('Alpha')!.textContent).toContain('open')

    // And the next delete needs no reopening of anything.
    await user.dblClick(within(rowOf('Bravo')!).getByTestId('project-delete'))
    await waitFor(() => expect(names()).not.toContain('Bravo'))
    expect(onClose).not.toHaveBeenCalled()
    expect(useStore.getState().project.id).toBe(alpha.id)
  })
})
