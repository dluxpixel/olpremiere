// NOTHING DELETES MEDIA A RUNNING EXPORT IS STILL READING.
//
// Since 2026-09-28 the export runs while he keeps working, his words: *"Make it
// so that while the video is exporting, I can work on other videos too,
// because the export time is sometimes very long."* So he can delete the very
// project he is exporting, and the orphan sweep can find that project's media
// unreachable from every stored project. Both used to delete it on the spot.
//
// The browser store is stood in for by plain maps, so what is proven is the
// deciding code in persistence.ts and blobSweep.ts, run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../engine/types'
import { sweepOrphanedBlobs } from './blobSweep'
import { holdBlobKeys, isBlobHeld } from './exportHolds'
import { deleteProject } from './persistence'

const stores = vi.hoisted(() => ({
  projects: new Map<string, unknown>(),
  blobs: new Map<string, unknown>(),
  meta: new Map<string, unknown>(),
}))

vi.mock('idb', () => {
  type Name = keyof typeof stores
  const store = (name: string) => stores[name as Name]
  const fake = {
    get: async (s: string, k: string) => store(s).get(k),
    getAll: async (s: string) => [...store(s).values()],
    getAllKeys: async (s: string) => [...store(s).keys()],
    put: async (s: string, v: unknown, k: string) => void store(s).set(k, v),
    delete: async (s: string, k: string) => void store(s).delete(k),
    transaction: () => ({
      objectStore: (s: string) => ({
        get: async (k: string) => store(s).get(k),
        put: async (v: unknown, k: string) => void store(s).set(k, v),
        delete: async (k: string) => void store(s).delete(k),
      }),
      done: Promise.resolve(),
    }),
  }
  return { openDB: async () => fake }
})

const project = (id: string, keys: string[]): Project =>
  ({
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    activeSequenceId: 'sq',
    sequences: {},
    assets: Object.fromEntries(keys.map((k, i) => [`a${i}`, { id: `a${i}`, name: k, kind: 'video', blobKey: k, durationS: 1 }])),
    settings: {},
  }) as unknown as Project

let release: () => void = () => {}

beforeEach(() => {
  for (const s of Object.values(stores)) s.clear()
})

afterEach(() => release())

describe('holds', () => {
  it('count, so two holds on one key need two releases', () => {
    const a = holdBlobKeys(['asset/x'])
    const b = holdBlobKeys(['asset/x'])
    a()
    expect(isBlobHeld('asset/x')).toBe(true)
    a() // a second call of the same release changes nothing
    expect(isBlobHeld('asset/x')).toBe(true)
    b()
    expect(isBlobHeld('asset/x')).toBe(false)
  })
})

describe('deleting the project being exported', () => {
  it('removes the project but leaves the media the export is reading', async () => {
    stores.projects.set('p1', project('p1', ['asset/held', 'asset/free']))
    stores.blobs.set('asset/held', 'bytes')
    stores.blobs.set('asset/free', 'bytes')
    release = holdBlobKeys(['asset/held'])

    await deleteProject('p1')

    expect(stores.projects.has('p1')).toBe(false)
    expect(stores.blobs.has('asset/held')).toBe(true)
    // Media the export does not read goes as it always did.
    expect(stores.blobs.has('asset/free')).toBe(false)
  })
})

describe('the orphan sweep', () => {
  it('skips media a running export holds, even when no project points at it', async () => {
    stores.projects.set('p2', project('p2', ['asset/live']))
    stores.blobs.set('asset/live', 'bytes')
    stores.blobs.set('asset/held', 'bytes')
    stores.blobs.set('asset/dead', 'bytes')
    release = holdBlobKeys(['asset/held'])

    await sweepOrphanedBlobs()

    expect(stores.blobs.has('asset/held')).toBe(true)
    expect(stores.blobs.has('asset/live')).toBe(true)
    expect(stores.blobs.has('asset/dead')).toBe(false)
  })

  it('reclaims it once the export lets go', async () => {
    stores.projects.set('p2', project('p2', []))
    stores.blobs.set('asset/held', 'bytes')
    holdBlobKeys(['asset/held'])()

    await sweepOrphanedBlobs()

    expect(stores.blobs.has('asset/held')).toBe(false)
  })
})
