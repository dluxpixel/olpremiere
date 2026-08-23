// The second home for his footage, and the repair that reads it back.
//
// The rule: a project whose media the database has lost must come back WITHOUT
// the edit moving. Same asset ids, same keys, same clips.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../engine/types'

const blobs = new Map<string, Blob>()
vi.mock('./persistence', () => ({
  getBlob: (k: string) => Promise.resolve(blobs.get(k) ?? null),
  putBlob: (k: string, b: Blob) => {
    if (k === 'asset/nowrite') return Promise.reject(new Error('quota'))
    blobs.set(k, b)
    return Promise.resolve()
  },
}))

const { backfillMirror, healProjectMedia, mirrorAsset, mirrorApi, readMirrored } = await import('./mediaMirror')

/** The disk, as the desktop shell would present it. */
let disk = new Map<string, Uint8Array>()
const calls = { begins: [] as string[], reads: 0, lists: 0 }

function fakeShell(opts: { failWrite?: boolean; failRead?: boolean } = {}) {
  ;(globalThis as { api?: unknown }).api = {
    isElectron: true,
    mediaList: () => {
      calls.lists++
      return Promise.resolve({ dir: 'C:/fake/media', files: [...disk].map(([id, b]) => ({ id, size: b.length })) })
    },
    mediaBegin: (id: string) => {
      calls.begins.push(id)
      if (opts.failWrite) return Promise.reject(new Error('no disk'))
      disk.set(id, new Uint8Array(0))
      return Promise.resolve(true)
    },
    mediaChunk: (id: string, bytes: ArrayBuffer) => {
      const prev = disk.get(id) ?? new Uint8Array(0)
      const next = new Uint8Array(prev.length + bytes.byteLength)
      next.set(prev)
      next.set(new Uint8Array(bytes), prev.length)
      disk.set(id, next)
      return Promise.resolve()
    },
    mediaFinish: (id: string) => Promise.resolve(disk.get(id)?.length ?? 0),
    mediaCancel: (id: string) => {
      disk.delete(id)
      return Promise.resolve()
    },
    mediaRead: (id: string, off: number, len: number) => {
      calls.reads++
      if (opts.failRead) return Promise.resolve(null)
      const b = disk.get(id)
      if (!b) return Promise.resolve(null)
      return Promise.resolve(b.slice(off, off + len).buffer)
    },
    mediaDelete: (id: string) => {
      disk.delete(id)
      return Promise.resolve()
    },
  }
}

const project = (assets: Record<string, unknown>): Project => ({ assets }) as unknown as Project
const asset = (id: string, name: string) => ({ id, name, blobKey: `asset/${id}` })

beforeEach(() => {
  blobs.clear()
  disk = new Map()
  calls.begins = []
  calls.reads = 0
  calls.lists = 0
  delete (globalThis as { api?: unknown }).api
})

describe('the web build has no mirror and behaves exactly as before', () => {
  it('writes nothing, reads nothing, and heals nothing', async () => {
    expect(mirrorApi()).toBeNull()
    expect(await mirrorAsset('a', new Blob(['x']))).toBe(false)
    expect(await readMirrored('a', 10)).toBeNull()
    expect(await healProjectMedia(project({ a: asset('a', 'clip.mp4') }))).toEqual({ healed: [], lost: [] })
    expect(await backfillMirror(project({ a: asset('a', 'clip.mp4') }))).toBe(0)
  })
})

describe('keeping the second copy', () => {
  it('writes the bytes to disk under the asset id', async () => {
    fakeShell()
    expect(await mirrorAsset('vid', new Blob([new Uint8Array(20)]))).toBe(true)
    expect(disk.get('vid')?.length).toBe(20)
  })

  it('reads them back whole, in slices', async () => {
    fakeShell()
    await mirrorAsset('vid', new Blob([new Uint8Array(64).fill(7)]))
    const back = await readMirrored('vid', 64)
    expect(back?.size).toBe(64)
  })

  // ⛔ A mirror that THROWS would cost him the import itself, which is far worse
  // than costing him the safety net.
  it('never lets a disk failure break the import', async () => {
    fakeShell({ failWrite: true })
    expect(await mirrorAsset('vid', new Blob(['x']))).toBe(false)
  })

  it('skips an empty blob, which is nothing worth keeping', async () => {
    fakeShell()
    expect(await mirrorAsset('vid', new Blob([]))).toBe(false)
    expect(calls.begins).toEqual([])
  })
})

describe('putting his edit back on launch', () => {
  const p = project({ a: asset('a', 'clip.mp4'), b: asset('b', 'voice.webm') })

  it('restores every asset the database lost, from the disk copy', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(30))
    disk.set('b', new Uint8Array(10))
    const r = await healProjectMedia(p)
    expect(r.healed.sort()).toEqual(['clip.mp4', 'voice.webm'])
    expect(r.lost).toEqual([])
    // ⛔ UNDER THE KEY THE DOCUMENT ALREADY POINTS AT. Nothing in the edit moves.
    expect(blobs.get('asset/a')?.size).toBe(30)
    expect(blobs.get('asset/b')?.size).toBe(10)
  })

  it('leaves alone what the database still has, and does not read the disk for it', async () => {
    fakeShell()
    blobs.set('asset/a', new Blob(['already here']))
    disk.set('a', new Uint8Array(30))
    disk.set('b', new Uint8Array(10))
    await healProjectMedia(p)
    expect(blobs.get('asset/a')?.size).toBe('already here'.length)
    // Only b was read back.
    expect(calls.reads).toBe(1)
  })

  it('names what it could not put back rather than pretending', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(30))
    const r = await healProjectMedia(p)
    expect(r.healed).toEqual(['clip.mp4'])
    expect(r.lost).toEqual(['voice.webm'])
  })

  it('counts a disk copy it cannot actually read as lost, never as healed', async () => {
    fakeShell({ failRead: true })
    disk.set('a', new Uint8Array(30))
    disk.set('b', new Uint8Array(10))
    const r = await healProjectMedia(p)
    expect(r.healed).toEqual([])
    expect(r.lost.sort()).toEqual(['clip.mp4', 'voice.webm'])
  })

  // ⛔ 1.38 GB across twenty files is the better part of a minute. A silent row
  // for that long, after five days without his editor, reads as still broken.
  it('says which file it is on while it works, and only for the ones it moves', async () => {
    fakeShell()
    blobs.set('asset/a', new Blob(['already here']))
    disk.set('a', new Uint8Array(30))
    disk.set('b', new Uint8Array(10))
    const seen: string[] = []
    await healProjectMedia(p, (done, total, name) => seen.push(`${done + 1}/${total} ${name}`))
    expect(seen).toEqual(['1/1 voice.webm'])
  })

  it('says nothing at all when there is nothing to put back', async () => {
    fakeShell()
    blobs.set('asset/a', new Blob(['x']))
    blobs.set('asset/b', new Blob(['x']))
    const seen: string[] = []
    await healProjectMedia(p, (d, t, n) => seen.push(`${d}${t}${n}`))
    expect(seen).toEqual([])
  })

  // ⛔ HE OPENED v2.27 TO A BANNER SAYING HIS MEDIA WAS GONE AND NOTHING ANYWHERE
  // SAYING WHAT HAD BEEN TRIED. A silent failure is the one thing this must never
  // do.
  it('says WHY when it cannot even read the folder', async () => {
    fakeShell()
    ;(globalThis as { api?: { mediaList: () => Promise<never> } }).api!.mediaList = () =>
      Promise.reject(new Error('EPERM'))
    const r = await healProjectMedia(p)
    expect(r.healed).toEqual([])
    expect(r.failure).toContain('EPERM')
    expect(r.lost.sort()).toEqual(['clip.mp4', 'voice.webm'])
  })

  it('says so plainly when there are no spare copies yet, rather than nothing', async () => {
    fakeShell()
    const r = await healProjectMedia(p)
    expect(r.failure).toContain('nothing in C:/fake/media')
  })

  // A rebuilt store can REJECT a read rather than answer null, and one throw used
  // to abandon the whole repair.
  it('carries on when the database THROWS instead of answering', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(30))
    disk.set('b', new Uint8Array(10))
    blobs.set('asset/a', new Blob(['x']))
    const real = blobs.get.bind(blobs)
    vi.spyOn(blobs, 'get').mockImplementation((k: string) => {
      if (k === 'asset/a') throw new Error('store is broken')
      return real(k)
    })
    const r = await healProjectMedia(p)
    vi.restoreAllMocks()
    expect(r.healed.sort()).toEqual(['clip.mp4', 'voice.webm'])
  })

  it('costs one listing, not one question per asset', async () => {
    fakeShell()
    blobs.set('asset/a', new Blob(['x']))
    blobs.set('asset/b', new Blob(['x']))
    await healProjectMedia(p)
    expect(calls.lists).toBe(1)
  })
})

describe('the footage he already had', () => {
  it('copies what is not mirrored yet and skips what is', async () => {
    fakeShell()
    blobs.set('asset/a', new Blob([new Uint8Array(12)]))
    blobs.set('asset/b', new Blob([new Uint8Array(8)]))
    disk.set('a', new Uint8Array(12))
    const done = await backfillMirror(project({ a: asset('a', 'clip.mp4'), b: asset('b', 'voice.webm') }))
    expect(done).toBe(1)
    expect(calls.begins).toEqual(['b'])
    expect(disk.get('b')?.length).toBe(8)
  })

  it('never copies an asset whose bytes the database has already lost', async () => {
    fakeShell()
    const done = await backfillMirror(project({ a: asset('a', 'clip.mp4') }))
    expect(done).toBe(0)
    expect(calls.begins).toEqual([])
  })
})
