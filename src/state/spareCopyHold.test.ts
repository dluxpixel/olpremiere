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

/**
 * A fresh start: its own copy of every module, as the app has on each launch.
 * `written` is main's answer: whether it could write the hold file.
 */
async function start(written = true): Promise<{ hold: ReturnType<typeof vi.fn>; held: () => string | null }> {
  vi.resetModules()
  const hold = vi.fn(async () => written)
  vi.stubGlobal('api', { mediaSweepHold: hold })
  const { initPersistence } = await import('./persistence')
  await initPersistence()
  const { spareCopyCleanupHeld } = await import('./spareCopyHold')
  return { hold, held: spareCopyCleanupHeld }
}

/** Let main's answer land. */
const answered = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  db.projects = []
  db.healed = []
  vi.unstubAllGlobals()
  localStorage.clear()
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

// ⛔ A full drive on the wipe morning (his is 97% full) can fail the hold file's
// write. Main then held for that run alone, and the next start, its store no
// longer empty after one edit, had nothing to set the hold again.
describe('⛔ a hold main could not write is asked for again at every start until it is', () => {
  it('the wipe morning cannot write it; the next start, its store not empty any more, still holds and asks again', async () => {
    const wipe = await start(false)
    expect(wipe.hold).toHaveBeenCalledWith('the store had no project to open at start')
    await answered()

    // He made an edit that morning, so the store no longer reads empty.
    db.projects = [{ ...newProject('Untitled Project'), id: 'blank-1' }]
    const next = await start(false)
    expect(next.hold).toHaveBeenCalledWith('the store had no project to open at start')
    expect(next.held()).toBe('the store had no project to open at start')
    await answered()

    // This time main writes it: the start after that asks for nothing.
    const written = await start(true)
    expect(written.hold).toHaveBeenCalledTimes(1)
    await answered()
    const after = await start(true)
    expect(after.hold).not.toHaveBeenCalled()
    expect(after.held()).toBeNull()
  })

  it('a hold main writes at once is not asked for again', async () => {
    await start(true)
    await answered()
    db.projects = [{ ...newProject('Green'), id: 'green-1' }]
    const next = await start(true)
    expect(next.hold).not.toHaveBeenCalled()
  })
})
