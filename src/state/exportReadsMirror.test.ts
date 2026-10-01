// "Media for ... is missing from local storage, re-import it" while the file
// was sitting on his disk the whole time.
//
// REPRODUCED in the real app, three times out of three (2026-09-30 and
// 2026-10-01): a profile whose database has lost its media (his own machine
// on 2026-08-23, or any fresh profile) opens his mc night project, the repair
// starts putting 2.8 GB back from the spare copies, and Export pressed in that
// first half minute dies with that message. Retried 15 seconds later, it
// worked. The repair is right; the export simply asked the database before the
// repair had reached that file, and believed the answer.
//
// So the export asks the database first and, when it has nothing, joins the
// repair: it waits for a file already being put back, puts any other back on
// the spot through the same one-read path, and reads the disk copy itself only
// when the database will not take it.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const blobs = new Map<string, Blob>()
vi.mock('./persistence', () => ({
  getBlob: (k: string) => (k === 'asset/throws' ? Promise.reject(new Error('store rebuilt')) : Promise.resolve(blobs.get(k) ?? null)),
  putBlob: (k: string, b: Blob) => {
    if (k === 'asset/full') return Promise.reject(new Error('quota'))
    blobs.set(k, b)
    return Promise.resolve()
  },
}))

const { blobForExport, healProjectMedia } = await import('./mediaMirror')

let disk = new Map<string, Uint8Array>()
let reads = 0

function fakeShell(): void {
  ;(globalThis as { api?: unknown }).api = {
    mediaList: () => Promise.resolve({ dir: 'C:/fake/media', files: [...disk].map(([id, b]) => ({ id, size: b.length })) }),
    mediaBegin: () => Promise.resolve(true),
    mediaRead: (id: string, off: number, len: number) => {
      reads++
      const b = disk.get(id)
      return Promise.resolve(b ? b.slice(off, off + len).buffer : null)
    },
  }
}

beforeEach(() => {
  blobs.clear()
  disk = new Map()
  reads = 0
  delete (globalThis as { api?: unknown }).api
})

const asset = (id: string) => ({ id, blobKey: `asset/${id}` })

describe('the export finds his footage whether or not the repair has put it back yet', () => {
  it('uses the database copy when there is one, and never touches the disk', async () => {
    fakeShell()
    blobs.set('asset/a', new Blob(['from the database']))
    disk.set('a', new TextEncoder().encode('from the disk'))
    const b = await blobForExport(asset('a'))
    expect(await b?.text()).toBe('from the database')
    expect(reads).toBe(0)
  })

  it('reads the spare copy on disk when the database does not have it yet (the race, reproduced)', async () => {
    fakeShell()
    disk.set('gameplay', new TextEncoder().encode('his OBS recording'))
    const b = await blobForExport(asset('gameplay'))
    expect(await b?.text()).toBe('his OBS recording')
    // ...and puts it back in the database on the way, as the repair would have.
    expect(await blobs.get('asset/gameplay')?.text()).toBe('his OBS recording')
  })

  it('joins a repair already putting that file back instead of reading it a second time', async () => {
    fakeShell()
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(7) // 3 chunks of the 8 MB read
    disk.set('big', bytes)
    const project = { assets: { big: { id: 'big', name: 'big.mp4', blobKey: 'asset/big' } } } as unknown as Parameters<typeof healProjectMedia>[0]
    // The boot repair and Export pressed at the same moment.
    const [heal, b] = await Promise.all([healProjectMedia(project), blobForExport(asset('big'))])
    expect(heal.healed).toEqual(['big.mp4'])
    expect(b?.size).toBe(bytes.length)
    // One pass over the file: 3 chunk reads, not 6. His files are gigabytes.
    expect(reads).toBe(3)
  })

  it('still hands the export its bytes when the database will not take them', async () => {
    fakeShell()
    disk.set('full', new TextEncoder().encode('read straight off the disk'))
    expect(await (await blobForExport(asset('full')))?.text()).toBe('read straight off the disk')
  })

  it('reads the spare copy too when the database throws instead of answering', async () => {
    fakeShell()
    disk.set('throws', new TextEncoder().encode('still here'))
    expect(await (await blobForExport(asset('throws')))?.text()).toBe('still here')
  })

  it('only says missing when it is missing in both places', async () => {
    fakeShell()
    expect(await blobForExport(asset('nowhere'))).toBeNull()
  })

  it('on the web build, with no disk copy to read, it is exactly the old database lookup', async () => {
    expect(await blobForExport(asset('gameplay'))).toBeNull()
    blobs.set('asset/gameplay', new Blob(['db']))
    expect(await (await blobForExport(asset('gameplay')))?.text()).toBe('db')
  })
})

describe('both export paths ask through it', () => {
  it('the desktop (ffmpeg) path and the browser (WebCodecs) path', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    for (const f of ['../engine/export/nativeExport.ts', '../engine/export/index.ts']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
      // By the ORIGINAL key, named at the call: proxyMedia.test.ts guards that no
      // export ever resolves a 720p preview copy.
      expect(src, f).toContain('await blobForExport({ id: asset.id, blobKey: asset.blobKey, name: asset.name })')
      expect(src, f).not.toContain('await getBlob(asset.blobKey)')
    }
  })
})
