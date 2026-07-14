import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'
import { createProject, openProject, removeProject } from './projectActions'
import { useStore } from './store'

const saved = new Map<string, Project>()
let roomSession: object | null = null

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({
  useCollab: { getState: () => ({ session: roomSession }) },
}))
vi.mock('./persistence', () => ({
  saveNow: vi.fn(async () => {
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
}))

beforeEach(() => {
  saved.clear()
  roomSession = null
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
  it('never deletes the open project', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)
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
