// A preview copy or a conversion whose page is gone (a reload, a crash) is STOPPED, with
// a real ffmpeg, not left to run to the end. Until 2026-10-06 a release only deleted
// the map entry and the files: the encode itself ran on for minutes, a full size
// re-encode at normal priority for nobody, and the updater waited on a conversion that
// could never be asked for again. So "stopped" here means the job has SETTLED by the
// time the release returns, not merely that its files are gone.
//
// Spawns the bundled ffmpeg, so it is slower than the rest of the suite on purpose.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const REPO = join(import.meta.dirname, '..')
const FFMPEG = join(REPO, 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')

let userData = ''
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'OL Premiere',
    getAppPath: () => join(import.meta.dirname, '..'),
    getPath: (k: string) => (k === 'userData' ? userData : `C:/${k}`),
  },
}))

const proxy = await import('./proxy')
const remux = await import('./remux')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let srcDir = ''
let source: Buffer
beforeAll(async () => {
  srcDir = await mkdtemp(join(tmpdir(), 'olp-stop-src-'))
  const src = join(srcDir, 'long.mp4')
  // Long enough that no encode of it can finish inside the half second before release.
  const made = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src],
    { windowsHide: true },
  )
  expect(made.status, `could not make a source: ${made.stderr}`).toBe(0)
  source = await readFile(src)
}, 120_000)

afterAll(async () => {
  await rm(srcDir, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-stop-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
})

async function upload(chunk: (bytes: ArrayBuffer) => Promise<void>): Promise<void> {
  const STEP = 8 * 1024 * 1024
  for (let off = 0; off < source.length; off += STEP) {
    await chunk(Uint8Array.from(source.subarray(off, off + STEP)).buffer)
  }
}

describe('releasing a job whose page is gone', () => {
  it('⛔ stops a running conversion, frees the updater and leaves no temp', async () => {
    const id = await remux.beginRemux()
    await upload((b) => remux.chunkRemux(id, b))
    let encoding = false
    let settled = false
    const finishing = remux.finishRemux(id, 'rescue', () => {
      encoding = true
    })
    finishing.then(
      () => (settled = true),
      () => (settled = true),
    )
    // Into the re-encode itself, the long part, not one of the quick looks before it.
    const t = Date.now()
    while (!encoding && Date.now() - t < 20_000) await sleep(50)
    expect(encoding).toBe(true)
    await sleep(300)
    expect(remux.remuxBusy()).toBe(true)
    const t0 = Date.now()
    await remux.releaseRemux(id)
    expect(Date.now() - t0).toBeLessThan(3000)
    // ffmpeg is gone by the time the release returns, and so is the busy flag.
    expect(settled).toBe(true)
    expect(remux.remuxBusy()).toBe(false)
    await expect(finishing).rejects.toThrow()
    // ffmpeg held both files open, so their being gone is ffmpeg being gone.
    expect(await readdir(join(userData, 'remux'))).toEqual([])
  }, 60_000)

  it('⛔ stops a preview copy being made, frees the updater and leaves no temp', async () => {
    const id = await proxy.beginProxy()
    await upload((b) => proxy.chunkProxy(id, b))
    let settled = false
    const finishing = proxy.finishProxy(id)
    finishing.then(
      () => (settled = true),
      () => (settled = true),
    )
    await sleep(500)
    expect(settled).toBe(false)
    expect(proxy.proxyBusy()).toBe(true)
    const t0 = Date.now()
    await proxy.releaseProxy(id)
    expect(Date.now() - t0).toBeLessThan(3000)
    // The encoder is gone by the time the release returns.
    expect(settled).toBe(true)
    await expect(finishing).rejects.toThrow()
    expect(proxy.proxyBusy()).toBe(false)
    expect(await readdir(join(userData, 'proxies'))).toEqual([])
  }, 60_000)

  it('a run stopped before it starts never spawns ffmpeg at all', async () => {
    const { runFfmpeg, CANCELLED } = await import('./remuxRun')
    const ac = new AbortController()
    ac.abort()
    await expect(runFfmpeg(FFMPEG, ['-version'], { signal: ac.signal })).rejects.toThrow(CANCELLED)
  })
})
