/**
 * @vitest-environment jsdom
 *
 * jsdom for the window listener the autosave installs at start.
 */

// ⛔ The morning the store lost something, the spare copies on disk are the last
// trace of that footage (2026-07-26: media in the store, the project record never
// written, so no file and no backup). The 7 day cleanup must stand down that
// morning, while the loss can still be told apart: after the first edit saves the
// blank project, the store no longer reads empty.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'

const db = vi.hoisted(() => ({ projects: [] as Project[], healed: [] as string[] }))

vi.mock('idb', () => ({
  openDB: async () => ({
    get: async (store: string, key: string) => (store === 'projects' ? db.projects.find((p) => p.id === key) : undefined),
    getAll: async (store: string) => (store === 'projects' ? db.projects : []),
    getAllKeys: async (store: string) => (store === 'projects' ? db.projects.map((p) => p.id) : []),
    put: async () => undefined,
    count: async (store: string) => (store === 'projects' ? db.projects.length : 0),
    transaction: () => ({ objectStore: () => ({ put: () => undefined }), done: Promise.resolve() }),
  }),
}))
vi.mock('./diskProjects', () => ({
  // The desktop: the Projects folder is there to heal from.
  diskApi: () => ({}),
  healStoreFromDisk: async () => ({ names: db.healed }),
  trashProjectOnDisk: async () => undefined,
  writeProjectToDisk: async () => undefined,
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

/** A fresh start: its own copy of every module, as the app has on each launch. */
async function start(): Promise<{ hold: ReturnType<typeof vi.fn>; held: () => string | null }> {
  vi.resetModules()
  const hold = vi.fn(async () => true)
  vi.stubGlobal('api', { mediaSweepHold: hold })
  const { initPersistence } = await import('./persistence')
  await initPersistence()
  const { spareCopyCleanupHeld } = await import('./spareCopyHold')
  return { hold, held: spareCopyCleanupHeld }
}

beforeEach(() => {
  db.projects = []
  db.healed = []
  vi.unstubAllGlobals()
})

describe('⛔ a start that shows a loss stands the spare copy cleanup down', () => {
  it('the store opens with no project at all (the wipe morning, or media with no project record)', async () => {
    const { hold, held } = await start()
    expect(hold).toHaveBeenCalledWith('the store had no project to open at start')
    expect(held()).toBe('the store had no project to open at start')
  })

  it('projects were put back from their files in Projects', async () => {
    db.projects = [{ ...newProject('Green'), id: 'green-1' }]
    db.healed = ['Green']
    const { hold, held } = await start()
    expect(hold).toHaveBeenCalledWith('projects came back from their files')
    expect(held()).toBeTruthy()
  })

  it('a healthy start, his projects all there, holds nothing', async () => {
    db.projects = [{ ...newProject('Green'), id: 'green-1' }]
    const { hold, held } = await start()
    expect(hold).not.toHaveBeenCalled()
    expect(held()).toBeNull()
  })
})
