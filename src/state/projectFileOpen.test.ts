// Opening a project file over the projects already here: what is put back as it
// is, what simply opens, and what lands beside as a copy so nothing is written
// over.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'
import { serialize } from './backupFormat'

const saved = new Map<string, Project>()
const shown: string[] = []

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string) => shown.push(message) }) },
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))
vi.mock('./mediaMirror', () => ({ backfillMirror: async () => {} }))
vi.mock('./persistence', () => ({
  saveSettled: vi.fn(async () => {
    const { useStore } = await import('./store')
    saved.set(useStore.getState().project.id, useStore.getState().project)
  }),
  rememberOpenProject: vi.fn(async () => {}),
  settleAfterLoad: vi.fn(),
  saveProject: vi.fn(async (p: Project) => {
    saved.set(p.id, p)
  }),
  loadProjectById: vi.fn(async (id: string) => saved.get(id) ?? null),
  listProjects: vi.fn(async () => [...saved.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))),
  getBlob: vi.fn(async () => null),
  putBlob: vi.fn(async () => {}),
  deleteBlob: vi.fn(async () => {}),
}))

const { importProjectFromFile, isProjectFileName, routeDroppedFiles } = await import('./projectFile')
const { useStore } = await import('./store')

/** His project file, as the Projects folder writes it. */
const olpbak = (p: Project): File => new File([serialize(p, 'desktop')], `${p.name}_${p.id.slice(0, 8)}.olpbak`)

beforeEach(() => {
  saved.clear()
  shown.length = 0
  useStore.getState().setProject(newProject('Open now'))
})

describe('⛔ his own .olpbak files open as projects', () => {
  it('are routed to the project path when dropped, not to the media importer', () => {
    expect(isProjectFileName('Green_ab9fe413.olpbak')).toBe(true)
    const file = new File(['{}'], 'Green_ab9fe413.olpbak')
    expect(routeDroppedFiles([file]).project).toBe(file)
  })

  it('a project that is not here (from Trash) comes back as it is, same id and name, and opens', async () => {
    const green = { ...newProject('Green'), updatedAt: 1000 }
    await importProjectFromFile(olpbak(green))
    expect(saved.get(green.id)?.name).toBe('Green')
    expect(useStore.getState().project.id).toBe(green.id)
    expect(shown).toContain('Opened "Green"')
  })

  it('the same save already here simply opens, nothing written over', async () => {
    const green = { ...newProject('Green'), updatedAt: 1000 }
    saved.set(green.id, green)
    await importProjectFromFile(olpbak(green))
    expect(useStore.getState().project.id).toBe(green.id)
    expect(saved.get(green.id)).toBe(green)
  })

  it('a different save of a project here lands beside it as a copy, both kept', async () => {
    const mine = { ...newProject('Green'), updatedAt: 2000 }
    saved.set(mine.id, mine)
    await importProjectFromFile(olpbak({ ...mine, updatedAt: 1000, name: 'Green' }))
    const opened = useStore.getState().project
    expect(opened.id).not.toBe(mine.id)
    expect(opened.name).toBe('Green_1')
    expect(saved.get(mine.id)).toBe(mine)
  })

  it('a damaged one says so and changes nothing', async () => {
    const before = useStore.getState().project.id
    await importProjectFromFile(new File(['{"kind":"ol-premiere-backup","project":{"id":5}}'], 'x.olpbak'))
    expect(shown).toContain('That project file is damaged')
    expect(useStore.getState().project.id).toBe(before)
  })
})
