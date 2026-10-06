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

/** What the bin picture maker was handed, by file name. */
const probed: { name: string; type: string }[] = []
vi.mock('../engine/probe', () => ({
  probeFile: async (f: File) => {
    probed.push({ name: f.name, type: f.type })
    return { thumbnailBlob: new Blob(['picture of ' + f.name], { type: 'image/jpeg' }) }
  },
}))

const { backfillMirror, healProjectMedia, isHealing, mirrorAsset, mirrorApi, readMirrored, useMediaHeal } = await import(
  './mediaMirror'
)

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

describe('⛔ one spare copy written at a time, never one per file at once', () => {
  it('six imports at once never overlap on the disk, and all six land', async () => {
    fakeShell()
    const api = (globalThis as { api?: Record<string, (...a: never[]) => Promise<unknown>> }).api!
    const { mediaBegin, mediaChunk, mediaFinish } = api as unknown as {
      mediaBegin: (id: string) => Promise<boolean>
      mediaChunk: (id: string, b: ArrayBuffer) => Promise<void>
      mediaFinish: (id: string) => Promise<number>
    }
    let open = 0
    let most = 0
    Object.assign(api, {
      mediaBegin: (id: string) => {
        open++
        most = Math.max(most, open)
        return mediaBegin(id)
      },
      // A real disk takes a while per slice, which is when the others pile up.
      mediaChunk: async (id: string, b: ArrayBuffer) => {
        await new Promise((r) => setTimeout(r, 2))
        return mediaChunk(id, b)
      },
      mediaFinish: (id: string) => {
        open--
        return mediaFinish(id)
      },
    })
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const landed = await Promise.all(ids.map((id) => mirrorAsset(id, new Blob([new Uint8Array(10).fill(1)]))))
    expect(landed).toEqual(ids.map(() => true))
    expect(most).toBe(1)
    expect([...disk.keys()].sort()).toEqual(ids)
    expect(ids.map((id) => disk.get(id)?.length)).toEqual(ids.map(() => 10))
  })

  it('a copy that fails does not stop the ones queued behind it', async () => {
    fakeShell()
    const api = (globalThis as { api?: Record<string, unknown> }).api!
    const begin = api.mediaBegin as (id: string) => Promise<boolean>
    api.mediaBegin = (id: string) => (id === 'bad' ? Promise.reject(new Error('no disk')) : begin(id))
    const [bad, good] = await Promise.all([
      mirrorAsset('bad', new Blob(['x'])),
      mirrorAsset('good', new Blob(['y'])),
    ])
    expect(bad).toBe(false)
    expect(good).toBe(true)
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

describe('the put-back says what it is doing, and runs once however many ask', () => {
  // MEASURED 2026-10-01 on a fresh profile, the state after a wipe: mc night
  // took 21.5 s to come back, in silence, and Export pressed 10 s in failed
  // with "re-import it" while the bytes were on their way back.
  const withId = (id: string, assets: Record<string, unknown>): Project => ({ id, assets }) as unknown as Project

  it('shows which file it is on while it moves them, and nothing once it is done', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(30))
    disk.set('b', new Uint8Array(10))
    const seen: (string | null)[] = []
    const off = useMediaHeal.subscribe((s) => seen.push(s.progress ? `${s.progress.done + 1}/${s.progress.total} ${s.progress.name}` : null))
    await healProjectMedia(withId('mc', { a: asset('a', 'clip.mp4'), b: asset('b', 'voice.webm') }))
    off()
    expect(seen).toEqual(['1/2 clip.mp4', '2/2 voice.webm', null])
  })

  it('a second caller (the export) joins the run already going instead of reading it all again', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(30))
    const p = withId('mc', { a: asset('a', 'clip.mp4') })
    const first = healProjectMedia(p)
    expect(isHealing('mc')).toBe(true)
    const second = healProjectMedia(p)
    expect(second).toBe(first)
    expect((await second).healed).toEqual(['clip.mp4'])
    expect(calls.lists).toBe(1)
    expect(isHealing('mc')).toBe(false)
    // And when it is done the bytes are in the store for the export to read.
    expect(blobs.get('asset/a')?.size).toBe(30)
  })
})

// ⛔ The bin pictures were never copied to disk and nothing remade them, so after
// a wipe every card in his bin stayed a plain icon for good.
describe('the bin pictures come back with the media', () => {
  const withThumb = (id: string, name: string, kind = 'video') => ({ ...asset(id, name), kind, thumbnailKey: `thumb/${id}` })

  beforeEach(() => {
    probed.length = 0
  })

  it('a heal where the picture is gone too makes it again from the bytes put back', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(32).fill(3))
    await healProjectMedia(project({ a: withThumb('a', 'clip.mov') }))
    await vi.waitFor(() => expect(blobs.get('thumb/a')).toBeInstanceOf(Blob))
    // The spare copy keeps bytes, not a type, so the maker is told what it is.
    expect(probed).toEqual([{ name: 'clip.mov', type: 'video/quicktime' }])
  })

  it('a picture still in the store is left alone, and sound has none to make', async () => {
    fakeShell()
    disk.set('a', new Uint8Array(32).fill(3))
    disk.set('s', new Uint8Array(32).fill(4))
    const kept = new Blob(['his own picture'])
    blobs.set('thumb/a', kept)
    await healProjectMedia(project({ a: withThumb('a', 'clip.mp4'), s: withThumb('s', 'song.mp3', 'audio') }))
    await new Promise((r) => setTimeout(r, 20))
    expect(blobs.get('thumb/a')).toBe(kept)
    expect(blobs.has('thumb/s')).toBe(false)
    expect(probed).toEqual([])
  })
})
