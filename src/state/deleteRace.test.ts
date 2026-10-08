// A listing that lands in the middle of a delete must not put the project back.
//
// Every listing refills the store from the Projects folder (diskProjects.ts). The
// delete used to drop the record first and move the file to Trash after, so a
// listing in between (the Projects dialog, the two minute backup) saw a file with
// no record and put the project straight back, after its bytes had been dropped.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'
import { serialize } from './backupFormat'

let records = new Map<string, Project>()
/** The Projects folder: one file per project id. */
const folder = new Map<string, string>()
/** Runs as the delete's store write finishes: the listing that lands in between. */
let between: (() => Promise<unknown>) | null = null

vi.mock('idb', () => ({
  openDB: async () => ({
    get: async (store: string, key: string) => (store === 'projects' ? records.get(key) : undefined),
    getAll: async (store: string) => (store === 'projects' ? [...records.values()] : []),
    getAllKeys: async (store: string) => (store === 'projects' ? [...records.keys()] : []),
    put: async (store: string, value: Project, key: string) => {
      if (store === 'projects') records.set(key, value)
    },
    transaction: () => {
      const objectStore = (name: string) => ({
        delete: (key: string) => {
          if (name === 'projects') records.delete(key)
        },
        get: async () => undefined,
      })
      return {
        objectStore,
        store: objectStore('blobs'),
        get done() {
          const hook = between
          between = null
          return hook ? hook().then(() => undefined) : Promise.resolve()
        },
      }
    },
  }),
}))

/** The desktop shell's project files, over the folder above. */
const disk = {
  projectWrite: async () => '',
  projectList: async () =>
    [...folder.keys()].map((id) => ({ id, name: id, path: `P/${id}.olpbak`, updatedAt: 1, sizeBytes: 1 })),
  projectRead: async (p: string) => folder.get(p.slice(2, -7))!,
  projectTrash: async (id: string) => (folder.delete(id) ? 1 : 0),
}
vi.mock('./diskProjects', async (importOriginal) => {
  const real = await importOriginal<typeof import('./diskProjects')>()
  return {
    ...real,
    diskApi: () => disk,
    trashProjectOnDisk: (id: string) => real.trashProjectOnDisk(id, disk),
    writeProjectToDisk: async () => undefined,
  }
})
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { deleteProject, listProjects } = await import('./persistence')

beforeEach(() => {
  records = new Map()
  folder.clear()
  between = null
})

describe('⛔ a listing in the middle of a delete', () => {
  it('does not put the deleted project back', async () => {
    const gym = { ...newProject('GYM'), id: 'gym' }
    records.set('gym', gym)
    folder.set('gym', serialize(gym, 'desktop'))

    let ran = false
    let seen: string[] = ['not read']
    between = async () => {
      ran = true
      seen = (await listProjects()).map((p) => p.id)
    }
    await deleteProject('gym')

    // The listing in between ran, and found nothing to put back.
    expect(ran).toBe(true)
    expect(seen).toEqual([])
    expect(records.has('gym')).toBe(false)
    expect(folder.has('gym')).toBe(false)
    expect((await listProjects()).map((p) => p.id)).toEqual([])
  })

  it('a file that could not go to Trash still comes back on the next listing, as before', async () => {
    const gym = { ...newProject('GYM'), id: 'gym' }
    records.set('gym', gym)
    folder.set('gym', serialize(gym, 'desktop'))
    const trash = disk.projectTrash
    disk.projectTrash = async () => {
      throw new Error('EBUSY')
    }
    try {
      await deleteProject('gym')
    } finally {
      disk.projectTrash = trash
    }
    expect((await listProjects()).map((p) => p.id)).toEqual(['gym'])
  })
})
