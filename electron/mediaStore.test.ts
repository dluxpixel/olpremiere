// The folder that holds his footage outside the database. It writes files, so
// what it REFUSES to write matters as much as what it writes.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({
  app: { getPath: (k: string) => (k === 'userData' ? userData : `C:/${k}`), getName: () => 'OL Premiere' },
}))

const { beginMedia, chunkMedia, cancelMedia, deleteMedia, finishMedia, listMedia, mediaDir, readMedia, sweepMediaTemps } =
  await import('./mediaStore')

const bytes = (n: number, fill: number): ArrayBuffer => new Uint8Array(n).fill(fill).buffer

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-media-'))
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
})

describe('keeping a copy', () => {
  it('writes an asset and reads it back byte for byte', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    await chunkMedia('abc', bytes(4, 2))
    expect(await finishMedia('abc')).toBe(8)

    const back = new Uint8Array((await readMedia('abc', 0, 8))!)
    expect([...back]).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    // Short read at the end returns only what is there, never padding.
    expect(new Uint8Array((await readMedia('abc', 6, 10))!).length).toBe(2)
  })

  // ⛔ A half written file under the asset's real name would be served as though
  // it were whole, and the one thing this folder must never do is hand back a
  // truncated source.
  it('is invisible until the last byte lands', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    expect((await listMedia()).files).toEqual([])
    expect(await readMedia('abc', 0, 4)).toBeNull()
    await finishMedia('abc')
    expect((await listMedia()).files).toEqual([{ id: 'abc', size: 4 }])
  })

  it('leaves nothing behind when a write is abandoned', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    await cancelMedia('abc')
    expect(await readdir(mediaDir())).toEqual([])
  })

  it('clears half written files from a run that died', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    await finishMedia('abc')
    await writeFile(join(mediaDir(), 'ghost.part'), 'x')
    expect(await sweepMediaTemps()).toBe(1)
    expect((await listMedia()).files).toEqual([{ id: 'abc', size: 4 }])
  })

  it('forgets one for good when he deletes the media', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    await finishMedia('abc')
    await deleteMedia('abc')
    expect((await listMedia()).files).toEqual([])
  })
})

// ⛔ THE ID COMES FROM THE RENDERER AND IS NOT TRUSTED. A name carrying a slash
// or a `..` would write outside this folder.
describe('it cannot be talked into writing somewhere else', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', 'x'.repeat(200)]) {
    it(`refuses ${JSON.stringify(bad)}`, async () => {
      expect(await beginMedia(bad)).toBe(false)
      expect(await readMedia(bad, 0, 4)).toBeNull()
      await deleteMedia(bad)
    })
  }

  it('ignores a stray file somebody put in the folder by hand', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    await finishMedia('abc')
    await writeFile(join(mediaDir(), 'notes.txt'), 'hello')
    expect((await listMedia()).files.map((m) => m.id)).toEqual(['abc'])
  })

  it('never lists an empty file as a usable copy', async () => {
    await beginMedia('abc')
    await finishMedia('abc')
    expect((await listMedia()).files).toEqual([])
  })

  it('answers null for an asset it has never heard of', async () => {
    expect(await readMedia('nothere', 0, 4)).toBeNull()
    expect((await listMedia()).files).toEqual([])
  })

  it('refuses a chunk or a finish for a write that was never begun', async () => {
    await expect(chunkMedia('abc', bytes(4, 1))).rejects.toThrow('unknown write')
    await expect(finishMedia('abc')).rejects.toThrow('unknown write')
  })
})

describe('the real bytes', () => {
  it('lands exactly what was written, so a source is never subtly wrong', async () => {
    const payload = new Uint8Array(1000).map((_, i) => i % 251)
    await beginMedia('big')
    await chunkMedia('big', payload.buffer)
    await finishMedia('big')
    const onDisk = await readFile(join(mediaDir(), 'big'))
    expect([...onDisk]).toEqual([...payload])
  })
})
