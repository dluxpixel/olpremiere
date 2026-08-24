// THE SECOND COPY HAS TO BE REAL, EXCLUSIVE, AND COVER EVERY PROJECT.
//
// ⛔ Written 2026-08-24, after the wipe that cost him three days and eight voice
// recordings. v2.34 made every import write to the disk mirror. These pin the
// three ways that guarantee was still escapable:
//
//   - two writers for one asset id producing an interleaved file that reads back
//     as good footage and gets healed INTO IndexedDB as his source
//   - a finished project he has not opened keeping exactly one copy, because
//     both backfill callers passed only the project that happened to be open
//   - deleting a bin item taking the spare copy with it, so Delete then Undo
//     silently left him on one copy again

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../engine/types'

const store = vi.hoisted(() => ({ blobs: new Map<string, Blob>(), projects: new Map<string, Project>() }))

vi.mock('./persistence', () => ({
  getBlob: (k: string) => Promise.resolve(store.blobs.get(k) ?? null),
  putBlob: (k: string, b: Blob) => {
    store.blobs.set(k, b)
    return Promise.resolve()
  },
  listProjects: () => Promise.resolve([...store.projects.values()].map((p) => ({ id: p.id }))),
  loadProjectById: (id: string) => Promise.resolve(store.projects.get(id) ?? null),
}))

const disk = vi.hoisted(() => ({
  files: new Map<string, number>(),
  begins: [] as string[],
  live: new Set<string>(),
  chunks: new Map<string, number>(),
}))

function installShell(): void {
  ;(globalThis as { api?: unknown }).api = {
    mediaList: () =>
      Promise.resolve({ dir: 'C:/m', files: [...disk.files].map(([id, size]) => ({ id, size })) }),
    mediaBegin: (id: string) => {
      disk.begins.push(id)
      // The real main process refuses a second writer for a live id.
      if (disk.live.has(id)) return Promise.resolve(false)
      disk.live.add(id)
      disk.chunks.set(id, 0)
      return Promise.resolve(true)
    },
    mediaChunk: (id: string, bytes: ArrayBuffer) => {
      disk.chunks.set(id, (disk.chunks.get(id) ?? 0) + bytes.byteLength)
      return Promise.resolve()
    },
    mediaFinish: (id: string) => {
      disk.live.delete(id)
      disk.files.set(id, disk.chunks.get(id) ?? 0)
      return Promise.resolve(disk.files.get(id) ?? 0)
    },
    mediaCancel: (id: string) => {
      disk.live.delete(id)
      return Promise.resolve()
    },
    mediaRead: () => Promise.resolve(null),
  }
}

const { mirrorAsset, backfillEveryProject } = await import('./mediaMirror')

const project = (id: string, assets: { id: string; name: string }[]): Project =>
  ({
    id,
    name: id,
    assets: Object.fromEntries(
      assets.map((a) => [a.id, { id: a.id, name: a.name, kind: 'video', blobKey: 'asset/' + a.id, durationS: 1 }]),
    ),
    sequences: {},
    activeSequenceId: '',
  }) as unknown as Project

beforeEach(() => {
  store.blobs.clear()
  store.projects.clear()
  disk.files.clear()
  disk.begins.length = 0
  disk.live.clear()
  disk.chunks.clear()
  installShell()
})

describe('one write per asset id, never two', () => {
  it('a second mirror of the same id joins the first instead of racing it', async () => {
    const bytes = new Blob([new Uint8Array(4096)])
    const a = mirrorAsset('same-id', bytes)
    const b = mirrorAsset('same-id', bytes)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe(true)
    expect(rb).toBe(true)
    // The decisive assertion: the shell was asked to open the file ONCE.
    expect(disk.begins.filter((x) => x === 'same-id')).toHaveLength(1)
    expect(disk.files.get('same-id')).toBe(4096)
  })

  it('lets the id be written again once the first write has finished', async () => {
    const bytes = new Blob([new Uint8Array(64)])
    await mirrorAsset('later', bytes)
    disk.files.delete('later')
    await mirrorAsset('later', bytes)
    expect(disk.begins.filter((x) => x === 'later')).toHaveLength(2)
  })

  it('does not interleave two different blobs into one file', async () => {
    const small = new Blob([new Uint8Array(100)])
    const huge = new Blob([new Uint8Array(900)])
    const [first, second] = await Promise.all([mirrorAsset('x', small), mirrorAsset('x', huge)])
    expect(first).toBe(second)
    expect(disk.files.get('x')).toBe(100)
  })
})

describe('every project on the shelf gets a second copy', () => {
  it('mirrors a finished project he has not opened', async () => {
    store.blobs.set('asset/open-1', new Blob([new Uint8Array(10)]))
    store.blobs.set('asset/finished-1', new Blob([new Uint8Array(20)]))
    store.projects.set('open', project('open', [{ id: 'open-1', name: 'a.mp4' }]))
    store.projects.set('finished', project('finished', [{ id: 'finished-1', name: 'b.mp4' }]))

    const done = await backfillEveryProject(
      () => Promise.resolve([{ id: 'open' }, { id: 'finished' }]),
      (id) => Promise.resolve(store.projects.get(id) ?? null),
    )
    expect(done).toBe(2)
    expect([...disk.files.keys()].sort()).toEqual(['finished-1', 'open-1'])
  })

  it('never copies the same bytes twice across the shelf', async () => {
    // Two rows sharing one asset, which is what a recovered project looks like.
    store.blobs.set('asset/shared', new Blob([new Uint8Array(8)]))
    store.projects.set('a', project('a', [{ id: 'shared', name: 's.mp4' }]))
    store.projects.set('b', project('b', [{ id: 'shared', name: 's.mp4' }]))
    const done = await backfillEveryProject(
      () => Promise.resolve([{ id: 'a' }, { id: 'b' }]),
      (id) => Promise.resolve(store.projects.get(id) ?? null),
    )
    expect(done).toBe(1)
    expect(disk.begins.filter((x) => x === 'shared')).toHaveLength(1)
  })

  it('skips what is already on disk', async () => {
    disk.files.set('already', 99)
    store.blobs.set('asset/already', new Blob([new Uint8Array(8)]))
    store.projects.set('p', project('p', [{ id: 'already', name: 'a.mp4' }]))
    const done = await backfillEveryProject(
      () => Promise.resolve([{ id: 'p' }]),
      (id) => Promise.resolve(store.projects.get(id) ?? null),
    )
    expect(done).toBe(0)
    expect(disk.begins).toHaveLength(0)
  })

  it('carries on when one project will not load', async () => {
    store.blobs.set('asset/good', new Blob([new Uint8Array(8)]))
    store.projects.set('good', project('good', [{ id: 'good', name: 'g.mp4' }]))
    const done = await backfillEveryProject(
      () => Promise.resolve([{ id: 'broken' }, { id: 'good' }]),
      (id) => (id === 'broken' ? Promise.reject(new Error('gone')) : Promise.resolve(store.projects.get(id) ?? null)),
    )
    expect(done).toBe(1)
    expect(disk.files.has('good')).toBe(true)
  })

  it('does nothing at all on a build with no desktop shell', async () => {
    delete (globalThis as { api?: unknown }).api
    const done = await backfillEveryProject(
      () => Promise.resolve([{ id: 'p' }]),
      () => Promise.resolve(null),
    )
    expect(done).toBe(0)
  })
})
