// A deleted project's media wait while its Undo is on offer, then go, and never
// a byte another project, the open edit or its undo history still uses.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type MediaAsset, type Project } from '../engine/types'

let projects: Project[] = []
/** Every blob key a store write deleted, in order. */
const deletedBlobs: string[] = []

// The database, faked down to the calls a delete and a drop make.
vi.mock('idb', () => ({
  openDB: async () => ({
    get: async (store: string, key: string) => (store === 'projects' ? projects.find((p) => p.id === key) : undefined),
    getAll: async (store: string) => (store === 'projects' ? projects : []),
    transaction: () => {
      const objectStore = (name: string) => ({
        delete: (key: string) => {
          if (name === 'blobs') deletedBlobs.push(key)
          if (name === 'projects') projects = projects.filter((p) => p.id !== key)
        },
        get: async () => undefined,
      })
      return { objectStore, store: objectStore('blobs'), done: Promise.resolve() }
    },
  }),
}))
vi.mock('./diskProjects', () => ({
  diskApi: () => null,
  healStoreFromDisk: async () => ({ names: [] }),
  trashProjectOnDisk: async () => undefined,
  writeProjectToDisk: async () => undefined,
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { deleteProject, dropUnusedBlobs } = await import('./persistence')
const { useStore } = await import('./store')

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  thumbnailKey: `thumb/${id}`,
  durationS: 4,
  hasAudio: true,
  hasVideo: true,
})
const withAssets = (name: string, ...ids: string[]): Project => ({
  ...newProject(name),
  assets: Object.fromEntries(ids.map((id) => [id, asset(id)])),
})

beforeEach(() => {
  projects = []
  deletedBlobs.length = 0
  useStore.getState().setProject(newProject('Open'))
})

describe('deleteProject', () => {
  it('with keepBytes, takes the project away and leaves every byte, handing back the document', async () => {
    const gym = withAssets('GYM', 'a1')
    projects = [gym]
    const gone = await deleteProject(gym.id, { keepBytes: true })
    expect(gone).toEqual(gym)
    expect(projects).toEqual([])
    expect(deletedBlobs).toEqual([])
  })

  it('without it, still frees the media only it used, as before', async () => {
    const gym = withAssets('GYM', 'a1', 'shared')
    const other = withAssets('Other', 'shared')
    projects = [gym, other]
    await deleteProject(gym.id)
    expect(deletedBlobs.sort()).toEqual(['asset/a1', 'thumb/a1'])
  })
})

describe('dropUnusedBlobs', () => {
  it('lets go of what nothing uses, and keeps what another project or the open edit uses', async () => {
    projects = [withAssets('Other', 'shared')]
    useStore.getState().setProject(withAssets('Open', 'open'))
    const n = await dropUnusedBlobs(['asset/gone', 'thumb/gone', 'asset/shared', 'asset/open'])
    expect(n).toBe(2)
    expect(deletedBlobs).toEqual(['asset/gone', 'thumb/gone'])
  })

  it('keeps media a project put back by Undo uses again', async () => {
    const gym = withAssets('GYM', 'a1')
    projects = [gym]
    expect(await dropUnusedBlobs(['asset/a1', 'thumb/a1'])).toBe(0)
    expect(deletedBlobs).toEqual([])
  })
})
