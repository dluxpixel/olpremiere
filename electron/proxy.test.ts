// The two things about a preview copy that are not about ffmpeg.
//
// ⛔ 1. IT COUNTS AS BUSY FROM THE FIRST BYTE, NOT FROM THE TRANSCODE. His
// source is 1.37 GB and streams across in a hundred and seventy odd chunks
// before ffmpeg sees one, and the old counter called all of that "not busy". The
// updater installs itself after five quiet minutes, and streaming a file is as
// quiet as it gets, so the copy he most needed was the one most likely to be
// restarted out from under.
//
// ⛔ 2. THE COPY IS READ BACK IN SLICES. Measured on his own footage,
// 2026-08-22: 423 MB. Handing that over whole needed it alive four times.
//
// No ffmpeg is spawned here. `finishProxy` is the only part that needs one, and
// what these press on is the bookkeeping either side of it.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'OL Premiere',
    getAppPath: () => 'C:/app',
    getPath: (k: string) => (k === 'userData' ? userData : `C:/${k}`),
  },
}))

const { beginProxy, chunkProxy, proxyBusy, readProxy, releaseAllProxies, releaseProxy } = await import('./proxy')

const proxyDir = (): string => join(userData, 'proxies')
const bytes = (n: number, fill: number): ArrayBuffer => new Uint8Array(n).fill(fill).buffer

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-proxy-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
})

describe('the updater must not restart underneath a preview copy', () => {
  it('is busy from beginProxy, BEFORE a single byte has been uploaded', async () => {
    expect(proxyBusy()).toBe(false)
    const id = await beginProxy()
    // The whole point: no chunk sent, no ffmpeg run, and it already counts.
    expect(proxyBusy()).toBe(true)
    await releaseProxy(id)
    expect(proxyBusy()).toBe(false)
  })

  it('stays busy across the upload and only lets go on release', async () => {
    const id = await beginProxy()
    await chunkProxy(id, bytes(1024, 7))
    expect(proxyBusy()).toBe(true)
    await chunkProxy(id, bytes(1024, 9))
    expect(proxyBusy()).toBe(true)
    await releaseProxy(id)
    expect(proxyBusy()).toBe(false)
  })

  it('counts two copies at once and is only idle when both are done', async () => {
    const a = await beginProxy()
    const b = await beginProxy()
    await releaseProxy(a)
    expect(proxyBusy()).toBe(true)
    await releaseProxy(b)
    expect(proxyBusy()).toBe(false)
  })

  it('cannot be driven below zero by a second release, which would strand the updater', async () => {
    const id = await beginProxy()
    await releaseProxy(id)
    await releaseProxy(id)
    await releaseProxy(id)
    expect(proxyBusy()).toBe(false)
    // A fresh job must still register after the repeated releases.
    const next = await beginProxy()
    expect(proxyBusy()).toBe(true)
    await releaseProxy(next)
    expect(proxyBusy()).toBe(false)
  })
})

describe('the finished copy is read back in slices', () => {
  it('returns exactly the requested window, and a SHORT last read at the end of the file', async () => {
    const id = await beginProxy()
    // Stand in for what ffmpeg would have written. The transcode is the one part
    // that needs a real encoder; the read back is not.
    const out = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    await writeFile(join(proxyDir(), `out-${id}.mp4`), out)

    expect(new Uint8Array(await readProxy(id, 0, 4))).toEqual(new Uint8Array([0, 1, 2, 3]))
    expect(new Uint8Array(await readProxy(id, 4, 4))).toEqual(new Uint8Array([4, 5, 6, 7]))
    // Asking for more than is left returns only what is there, never padding.
    expect(new Uint8Array(await readProxy(id, 8, 4))).toEqual(new Uint8Array([8, 9]))
    await releaseProxy(id)
  })

  it('refuses a job it has never heard of rather than reading someone else file', async () => {
    await expect(readProxy('not-a-job', 0, 4)).rejects.toThrow('unknown upload')
  })

  it('takes BOTH temps on release, because the source copy alone is full size', async () => {
    const id = await beginProxy()
    await chunkProxy(id, bytes(2048, 1))
    await writeFile(join(proxyDir(), `out-${id}.mp4`), Buffer.from([1, 2, 3]))
    expect((await readdir(proxyDir())).sort()).toEqual([`in-${id}`, `out-${id}.mp4`])

    await releaseProxy(id)
    expect(await readdir(proxyDir())).toEqual([])
  })

  // ⛔ A job lives in MAIN, so it outlives the page that started it. A reload
  // would otherwise leave its temps on disk and the busy count pinned, and the
  // updater would wait forever for a copy nothing can ask for.
  it('drops every orphaned job at once when the renderer goes away', async () => {
    const a = await beginProxy()
    const b = await beginProxy()
    await chunkProxy(a, bytes(4096, 1))
    await writeFile(join(proxyDir(), `out-${b}.mp4`), Buffer.from([9, 9, 9]))
    expect((await readdir(proxyDir())).length).toBe(3)

    await releaseAllProxies()

    expect(proxyBusy()).toBe(false)
    expect(await readdir(proxyDir())).toEqual([])
  })

  it('is a no-op when nothing is in flight, so a first page load cannot kill a job', async () => {
    await releaseAllProxies()
    expect(proxyBusy()).toBe(false)
    const id = await beginProxy()
    expect(proxyBusy()).toBe(true)
    await releaseProxy(id)
  })

  it('refuses a chunk that arrives after the upload is closed, rather than writing into it', async () => {
    const id = await beginProxy()
    await chunkProxy(id, bytes(16, 3))
    await releaseProxy(id)
    await expect(chunkProxy(id, bytes(16, 4))).rejects.toThrow('unknown upload')
  })
})
