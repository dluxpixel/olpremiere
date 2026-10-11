// Room media sync: the half of a relay room that moves the footage itself, so a
// collaborator sees his clips and not a placeholder. Nothing ran it before
// 2026-10-08 (collab.spec.ts drives two tabs, which share IndexedDB and skip all
// of this). These drive the scan loop on fake timers with a fake room manifest, a
// fake local store and a fake uploader, and prove it by what moves and what is
// called missing. A file that arrives from the room also brings its sound back,
// not only its picture (healArrivedBlob, last describe).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MB = 1024 * 1024
const SCAN_MS = 4_000

interface Asset {
  id: string
  name: string
  blobKey: string
}
const project: { assets: Record<string, Asset> } = { assets: {} }
/** What this machine has in IndexedDB, by key. */
let local = new Map<string, Blob>()
const stored: string[] = []
const healed: string[] = []
const toasts: { message: string; kind?: string }[] = []

/** Every upload asked for; each stays on its way until `finish` is called. */
let uploads: { path: string; signal: AbortSignal; finish: () => void }[] = []

vi.mock('@vercel/blob/client', () => ({
  upload: (path: string, _blob: Blob, opts: { abortSignal: AbortSignal }) =>
    new Promise<void>((resolve) => {
      uploads.push({ path, signal: opts.abortSignal, finish: resolve })
    }),
}))
vi.mock('../state/persistence', () => ({
  getBlob: async (key: string) => local.get(key) ?? null,
  putBlob: async (key: string, blob: Blob) => {
    stored.push(key)
    local.set(key, blob)
  },
}))
vi.mock('../state/store', () => ({ useStore: { getState: () => ({ project }) } }))
vi.mock('../state/toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string, kind?: string) => toasts.push({ message, kind }) }) },
}))
vi.mock('../state/blobUrls', () => ({ notifyBlobArrived: (key: string) => healed.push(`blob ${key}`) }))
vi.mock('../engine/frameCache', () => ({ evictAsset: (id: string) => healed.push(`decoder ${id}`) }))
vi.mock('../engine/assetSound', () => ({ forgetAssetSound: (id: string) => healed.push(`sound ${id}`) }))
vi.mock('../engine/preview', () => ({
  disposePreviewAsset: (id: string) => healed.push(`element ${id}`),
  invalidatePreview: () => healed.push('preview'),
}))

const { healArrivedBlob, startMediaSync, useMediaSync } = await import('./mediaSync')

/** The room's media manifest, as api/room.ts lists it, and every fetch made. */
let manifest: { key: string; url: string; size: number }[] = []
let fetches: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  project.assets = { a1: { id: 'a1', name: 'clip.mp4', blobKey: 'k1' } }
  local = new Map()
  stored.length = 0
  healed.length = 0
  toasts.length = 0
  uploads = []
  manifest = []
  fetches = []
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('fetch', async (url: string) => {
    fetches.push(url)
    if (url.startsWith('/api/room')) return Response.json({ media: manifest })
    return new Response(new Blob([new Uint8Array(1000)]))
  })
})

let stops: (() => void)[] = []
const start = (): (() => void) => {
  const stop = startMediaSync('room-1')
  stops.push(stop)
  return stop
}
const scans = (n: number): Promise<void> => vi.advanceTimersByTimeAsync(SCAN_MS * n).then(() => undefined)

afterEach(() => {
  for (const s of stops) s()
  stops = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('his footage goes up', () => {
  it('once, for a file the room does not have, and not again while it is on its way', async () => {
    local.set('k1', new Blob([new Uint8Array(1000)]))
    start()
    await scans(0)
    await scans(2)
    expect(uploads.map((u) => u.path)).toEqual(['olpremiere-rooms/room-1/media/k1'])

    // Up: the room lists it now, and nothing is sent again.
    uploads[0]!.finish()
    manifest = [{ key: 'k1', url: 'https://blob.test/k1', size: 1000 }]
    await scans(2)
    expect(uploads).toHaveLength(1)
  })

  it('not over 512 MB (Locate covers the others), and such a file is not called missing either', async () => {
    local.set('k1', { size: 513 * MB } as Blob)
    start()
    await scans(0)
    await scans(2)
    expect(uploads).toHaveLength(0)
    expect(useMediaSync.getState().missing).toEqual([])
  })

  it('not at all in a scan whose manifest hit the list cap, where "not listed" no longer means "not there"', async () => {
    local.set('k1', new Blob([new Uint8Array(1000)]))
    manifest = Array.from({ length: 500 }, (_, i) => ({ key: `other-${i}`, url: `https://blob.test/${i}`, size: 1 }))
    start()
    await scans(0)
    await scans(2)
    expect(uploads).toHaveLength(0)
  })
})

describe('a collaborator\'s footage comes down', () => {
  it('when the room has it and this side does not: stored, and every placeholder healed', async () => {
    manifest = [{ key: 'k1', url: 'https://blob.test/k1', size: 1000 }]
    start()
    await scans(0)
    expect(fetches).toContain('https://blob.test/k1')
    expect(stored).toEqual(['k1'])
    expect(healed).toEqual(['blob k1', 'decoder a1', 'element a1', 'sound a1', 'preview'])
    expect(toasts).toContainEqual({ message: 'clip.mp4 synced from the room', kind: 'success' })
    await scans(2)
    expect(stored).toEqual(['k1'])
  })

  it('not on a small device past its cap: listed for Locate instead of filling the memory', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 4 })
    manifest = [{ key: 'k1', url: 'https://blob.test/k1', size: 200 * MB }]
    start()
    await scans(0)
    expect(fetches).not.toContain('https://blob.test/k1')
    expect(useMediaSync.getState().missing).toEqual([{ assetId: 'a1', name: 'clip.mp4', blobKey: 'k1' }])
  })
})

describe('a file on neither side', () => {
  // The owner may still be uploading it, so one empty scan proves nothing.
  it('is called missing only after two scans in a row without it', async () => {
    start()
    await scans(0)
    expect(useMediaSync.getState().missing).toEqual([])
    await scans(1)
    expect(useMediaSync.getState().missing).toEqual([{ assetId: 'a1', name: 'clip.mp4', blobKey: 'k1' }])
  })
})

describe('leaving the room', () => {
  it('cancels what is on its way, clears the list, and scans no more', async () => {
    local.set('k1', new Blob([new Uint8Array(1000)]))
    const stop = start()
    await scans(0)
    expect(uploads).toHaveLength(1)
    stop()
    expect(uploads[0]!.signal.aborted).toBe(true)
    expect(useMediaSync.getState()).toEqual({ transfers: [], missing: [] })
    const seen = fetches.length
    await scans(3)
    expect(fetches.length).toBe(seen)
  })
})

describe('healArrivedBlob', () => {
  // ⛔ AU-10. The picture was re-read and the sound, read as nothing while the
  // bytes were missing, stayed silent until a restart.
  it('forgets the sound read while the bytes were missing', () => {
    healArrivedBlob('asset/a1', 'a1')
    expect(healed).toContain('decoder a1')
    expect(healed).toContain('sound a1')
    // Through the one put back road, so the preview's <video> elements are told too.
    expect(healed).toContain('element a1')
    expect(healed).toContain('preview')
  })
})
