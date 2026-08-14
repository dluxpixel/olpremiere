import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'
import { createProject, openProject, removeProject } from './projectActions'
import { useStore } from './store'

const saved = new Map<string, Project>()
let roomSession: object | null = null
/** Flip on to make the autosave flush REJECT, as a full disk / dead IDB would. */
let saveFails = false

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({
  useCollab: { getState: () => ({ session: roomSession }) },
}))
vi.mock('./persistence', () => ({
  saveNow: vi.fn(async () => {
    if (saveFails) throw new Error('quota exceeded')
    const p = useStore.getState().project
    saved.set(p.id, p)
  }),
  saveProject: vi.fn(async (p: Project) => {
    saved.set(p.id, p)
  }),
  loadProjectById: vi.fn(async (id: string) => saved.get(id) ?? null),
  deleteProject: vi.fn(async (id: string) => {
    saved.delete(id)
  }),
  listProjects: vi.fn(async () =>
    [...saved.values()].map((p, i) => ({ id: p.id, name: p.name, updatedAt: i })),
  ),
}))

beforeEach(() => {
  saved.clear()
  roomSession = null
  saveFails = false
  useStore.getState().setProject(newProject('Current'))
  useStore.getState().setUI({ selection: ['x'], playheadS: 7, playing: false })
})

describe('openProject', () => {
  it('autosaves the current edit, adopts the other one, and resets the UI', async () => {
    const other = newProject('Other')
    saved.set(other.id, other)
    const currentId = useStore.getState().project.id

    await openProject(other.id)

    expect(useStore.getState().project.id).toBe(other.id)
    expect(saved.has(currentId)).toBe(true) // nothing was lost by switching
    expect(useStore.getState().ui.selection).toEqual([])
    expect(useStore.getState().ui.playheadS).toBe(0)
  })

  it('refuses inside a collab room', async () => {
    roomSession = {}
    const other = newProject('Other')
    saved.set(other.id, other)
    const before = useStore.getState().project.id
    await openProject(other.id)
    expect(useStore.getState().project.id).toBe(before)
  })
})

describe('createProject', () => {
  it('banks the current project and starts a fresh one', async () => {
    const before = useStore.getState().project.id
    await createProject()
    const after = useStore.getState().project
    expect(after.id).not.toBe(before)
    expect(saved.has(before)).toBe(true)
    expect(saved.has(after.id)).toBe(true) // the new one exists immediately
  })
})

describe('removeProject', () => {
  // ⛔ THIS USED TO SAY 'never deletes the open project'. He asked for the
  // opposite on 2026-08-14: the delete button is on the open row now, and
  // having to open something else first purely to satisfy the app was the bug.
  // What must still hold is that the editor is never left holding a corpse.
  it('deletes the open project, landing on another one first', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)
    const other = newProject('Other')
    saved.set(other.id, other)

    await removeProject(current.id)

    expect(saved.has(current.id)).toBe(false)
    expect(useStore.getState().project.id).toBe(other.id)
  })

  it('deletes the open project when it is the last one, onto a fresh one', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)

    await removeProject(current.id)

    expect(saved.has(current.id)).toBe(false)
    // Somewhere real to be, not an empty editor.
    expect(useStore.getState().project.id).not.toBe(current.id)
    expect(saved.has(useStore.getState().project.id)).toBe(true)
  })

  it('⛔ deletes NOTHING when the switch away could not save', async () => {
    // The order is the whole safety property: a delete that went ahead here
    // would pull the file out from under an editor still showing it.
    const current = useStore.getState().project
    saved.set(current.id, current)
    const other = newProject('Other')
    saved.set(other.id, other)
    saveFails = true

    await removeProject(current.id)

    expect(saved.has(current.id)).toBe(true)
    expect(useStore.getState().project.id).toBe(current.id)
  })

  it('refuses inside a collab room, where switching would tear the doc away', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)
    roomSession = {}
    await removeProject(current.id)
    expect(saved.has(current.id)).toBe(true)
  })

  it('deletes another project', async () => {
    const other = newProject('Other')
    saved.set(other.id, other)
    await removeProject(other.id)
    expect(saved.has(other.id)).toBe(false)
  })
})

describe('a failed flush never costs the user their edits', () => {
  it('openProject aborts instead of adopting over unsaved work', async () => {
    const other = newProject('Other')
    saved.set(other.id, other)
    const currentId = useStore.getState().project.id
    saveFails = true

    await openProject(other.id)

    // Still on the project that could not be written, because switching would have
    // replaced the in-memory document and dropped every edit since the last
    // successful save.
    expect(useStore.getState().project.id).toBe(currentId)
  })

  it('createProject aborts too', async () => {
    const currentId = useStore.getState().project.id
    saveFails = true
    await createProject()
    expect(useStore.getState().project.id).toBe(currentId)
  })
})
