// The folder that holds his footage outside the database. It writes files, so
// what it REFUSES to write matters as much as what it writes.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
let appData = 'C:/appData'
vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'userData' ? userData : k === 'appData' ? appData : `C:/${k}`),
    getName: () => 'OL Premiere',
  },
}))

const { beginMedia, chunkMedia, cancelMedia, deleteMedia, finishMedia, listMedia, mediaDir, mediaWriteDir, readMedia, sweepMediaTemps } =
  await import('./mediaStore')

const bytes = (n: number, fill: number): ArrayBuffer => new Uint8Array(n).fill(fill).buffer

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-media-'))
  appData = 'C:/appData-that-is-not-there'
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

// ⛔ `userData` IS NOT AS FIXED AS IT LOOKS. This app has renamed its own profile
// once already, `--user-data-dir` moves it wholesale, and on 2026-08-23 his app
// reported no spare copies while 7.1 GB of them sat on the disk. Reading one
// place and calling it settled cost him two more days.
describe('a copy in a profile the app used to use is still found', () => {
  it('falls back to the roaming folder under the app name, and says which it used', async () => {
    // The primary is empty; the copy is where an older arrangement put it.
    const roaming = await mkdtemp(join(tmpdir(), 'olp-roaming-'))
    const older = join(roaming, 'OL Premiere', 'media')
    await mkdir(older, { recursive: true })
    await writeFile(join(older, 'abc'), 'hello')
    appData = roaming

    const listed = await listMedia()
    expect(listed.files).toEqual([{ id: 'abc', size: 5 }])
    expect(listed.dir).toBe(older)

    // And it can actually be READ from there, or finding it would be worse than
    // not finding it.
    expect(new Uint8Array((await readMedia('abc', 0, 5))!).length).toBe(5)
    await rm(roaming, { recursive: true, force: true })
  })

  it('names every folder it tried when there is nothing anywhere', async () => {
    const listed = await listMedia()
    expect(listed.files).toEqual([])
    expect(listed.error).toBe('no spare copies found')
    expect(listed.dir).toContain(userData)
  })

  it('always WRITES to the primary, whatever the fallbacks turned up', async () => {
    await beginMedia('abc')
    await chunkMedia('abc', bytes(4, 1))
    await finishMedia('abc')
    expect(mediaWriteDir()).toBe(mediaDir())
    expect((await listMedia()).dir).toBe(mediaDir())
  })
})
