// The proxy is what he LOOKS at, never what he SHIPS. These are the two things
// that must stay true: the policy only spends a transcode where it buys
// something, and no export path can ever resolve a preview copy.

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureProxies, forgetProxy, hasProxy, proxyKeyFor, wantsProxy, whenProxiesSettled } from './proxyMedia'
import type { MediaAsset } from './types'

const stored = new Map<string, Blob>()
vi.mock('../state/persistence', () => ({
  getBlob: (key: string) => Promise.resolve(stored.get(key) ?? null),
  putBlob: (key: string, blob: Blob) => {
    stored.set(key, blob)
    return Promise.resolve()
  },
}))

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a1',
  name: 'clip.mp4',
  kind: 'video',
  blobKey: 'asset/a1',
  durationS: 12,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
  ...over,
})

describe('proxy policy', () => {
  it('proxies a tall video in the desktop shell', () => {
    expect(wantsProxy(asset(), true)).toBe(true)
  })

  it('never proxies in the browser build, which has no transcoder', () => {
    expect(wantsProxy(asset(), false)).toBe(false)
  })

  it('leaves a small source alone: it already seeks fast enough to not be worth an import wait', () => {
    expect(wantsProxy(asset({ height: 480 }), true)).toBe(false)
  })

  it('ignores audio and stills, which have no frames to seek through', () => {
    expect(wantsProxy(asset({ kind: 'audio', hasVideo: false }), true)).toBe(false)
    expect(wantsProxy(asset({ kind: 'image', hasVideo: false, height: 2160 }), true)).toBe(false)
  })

  it('keys the preview copy off the asset id, so it survives a reload with no extra state', () => {
    expect(proxyKeyFor('abc')).toBe('proxy:abc')
    expect(proxyKeyFor('abc')).not.toBe(asset().blobKey)
  })
})

// ⛔ THE COPY MUST NEVER CROSS IN ONE PIECE. Measured on his own capture,
// 2026-08-22: 1.37 GB of source makes a 423 MB preview copy, and asking for that
// as a single ArrayBuffer needs it alive four times over. His store has held
// zero preview copies since July. These press on the SHAPE of the round trip,
// not on ffmpeg, so they run anywhere.
describe('the preview copy crosses in chunks, both ways', () => {
  const CHUNK = 8 * 1024 * 1024

  /** A fake desktop shell that records every call and answers with `outSize` bytes. */
  function shell(outSize: number, opts: { failFinish?: boolean } = {}) {
    const calls = { chunks: [] as number[], reads: [] as { off: number; len: number }[], released: 0, finished: 0 }
    const api = {
      isElectron: true,
      proxyBegin: () => Promise.resolve('job-1'),
      proxyChunk: (_id: string, bytes: ArrayBuffer) => {
        calls.chunks.push(bytes.byteLength)
        return Promise.resolve()
      },
      proxyFinish: () => {
        calls.finished++
        return opts.failFinish ? Promise.resolve(null) : Promise.resolve({ size: outSize })
      },
      proxyRead: (_id: string, off: number, len: number) => {
        calls.reads.push({ off, len })
        return Promise.resolve(new Uint8Array(len).buffer)
      },
      proxyRelease: () => {
        calls.released++
        return Promise.resolve()
      },
    }
    ;(globalThis as { api?: unknown }).api = api
    return calls
  }

  afterEach(() => {
    delete (globalThis as { api?: unknown }).api
    stored.clear()
    vi.restoreAllMocks()
  })

  it('reads a big copy back in bounded slices and never in one call', async () => {
    const a = asset({ id: 'big', blobKey: 'asset/big' })
    forgetProxy(a.id)
    stored.set(a.blobKey, new Blob([new Uint8Array(3 * CHUNK)]))
    // 423 MB is what his own footage actually makes. Scaled here to 3 chunks so
    // the test is about the SHAPE of the round trip and not about the clock.
    const calls = shell(3 * CHUNK)

    ensureProxies([a])
    await whenProxiesSettled()

    expect(calls.finished).toBe(1)
    // The old code asked for the whole copy in the finish call and never read.
    expect(calls.reads).toEqual([
      { off: 0, len: CHUNK },
      { off: CHUNK, len: CHUNK },
      { off: 2 * CHUNK, len: CHUNK },
    ])
    expect(Math.max(...calls.reads.map((r) => r.len))).toBeLessThanOrEqual(CHUNK)
    expect(stored.get(proxyKeyFor(a.id))?.size).toBe(3 * CHUNK)
    expect(hasProxy(a.id)).toBe(true)
    expect(calls.released).toBe(1)
  })

  it('asks for the last slice SHORT, so a copy that is not a whole number of chunks is not over-read', async () => {
    const a = asset({ id: 'odd', blobKey: 'asset/odd' })
    forgetProxy(a.id)
    stored.set(a.blobKey, new Blob([new Uint8Array(1024)]))
    const calls = shell(CHUNK + 500)

    ensureProxies([a])
    await whenProxiesSettled()

    expect(calls.reads).toEqual([
      { off: 0, len: CHUNK },
      { off: CHUNK, len: 500 },
    ])
    expect(stored.get(proxyKeyFor(a.id))?.size).toBe(CHUNK + 500)
  })

  it('releases the temp even when no copy could be made, or a full sized one stays on his drive', async () => {
    const a = asset({ id: 'nope', blobKey: 'asset/nope' })
    forgetProxy(a.id)
    stored.set(a.blobKey, new Blob([new Uint8Array(1024)]))
    const calls = shell(0, { failFinish: true })

    ensureProxies([a])
    await whenProxiesSettled()

    expect(calls.reads).toEqual([])
    expect(calls.released).toBe(1)
    expect(hasProxy(a.id)).toBe(false)
    expect(stored.has(proxyKeyFor(a.id))).toBe(false)
  })

  it('never transcodes a copy that already exists, whatever session built it', async () => {
    const a = asset({ id: 'kept', blobKey: 'asset/kept' })
    forgetProxy(a.id)
    stored.set(a.blobKey, new Blob([new Uint8Array(1024)]))
    stored.set(proxyKeyFor(a.id), new Blob([new Uint8Array(64)]))
    const calls = shell(CHUNK)

    ensureProxies([a])
    await whenProxiesSettled()

    expect(calls.finished).toBe(0)
    expect(calls.chunks).toEqual([])
    expect(hasProxy(a.id)).toBe(true)
  })
})

describe('export never sees a preview copy', () => {
  // Read rather than run: the guarantee is about which key the export code
  // RESOLVES, and a source-level assertion cannot be satisfied by a mock that
  // happens to return the right bytes. If someone wires proxyKeyFor into an
  // export path to "make preview and export match", this fails loudly, which is
  // the point: they would match at 720p and every published video would be soft.
  const sources = ['src/engine/export/index.ts', 'src/engine/export/nativeExport.ts']

  for (const path of sources) {
    it(`${path} resolves the original blob only`, () => {
      const src = readFileSync(path, 'utf8')
      expect(src).toContain('asset.blobKey')
      expect(src).not.toContain('proxyKeyFor')
      expect(src).not.toContain('proxyMedia')
      expect(src).not.toMatch(/proxy:/)
    })
  }
})
