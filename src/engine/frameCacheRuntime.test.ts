// The frame cache's RUNTIME, with mediabunny faked: a decoder whose reads take a
// tick and are cancelled the way the real one cancels them when its Input is
// disposed (InputDisposedError). The pure helpers are pinned in
// frameCache.test.ts; this file is for the pump, the reopen when a preview copy
// lands, and withFullQuality, which is where PB-2 and PB-4 lived.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from './types'

interface FakeBlob {
  size: number
  name: 'orig' | 'copy'
}

const h = vi.hoisted(() => ({
  copyReady: false,
  inputs: [] as Array<{ disposed: boolean; name: string }>,
  /** How tall each file's track says it is, and what every sink was asked for. */
  heights: { orig: 36, copy: 36 } as Record<string, number>,
  sinks: [] as Array<{ file: string; height?: number }>,
}))

vi.mock('mediabunny', () => {
  class InputDisposedError extends Error {}
  class BlobSource {
    constructor(readonly blob: FakeBlob) {}
  }
  class Input {
    disposed = false
    readonly name: string
    constructor(opts: { source: BlobSource }) {
      this.name = opts.source.blob.name
      h.inputs.push(this)
    }
    dispose(): void {
      this.disposed = true
    }
    async getPrimaryVideoTrack(): Promise<{ input: Input; getDisplayHeight: () => Promise<number> }> {
      await new Promise((r) => setTimeout(r, 1))
      return { input: this, getDisplayHeight: async () => h.heights[this.name] ?? 0 }
    }
  }
  class CanvasSink {
    constructor(
      readonly track: { input: Input },
      opts: { height?: number } = {},
    ) {
      h.sinks.push({ file: track.input.name, height: opts.height })
    }
    /** One frame by random access, the way a one-shot reader asks. */
    async getCanvas(tS: number): Promise<{ canvas: object; timestamp: number } | null> {
      await new Promise((r) => setTimeout(r, 2))
      if (this.track.input.disposed) throw new InputDisposedError('disposed')
      const i = Math.floor(tS * 30)
      return { canvas: { width: 64, height: 36, tag: `${this.track.input.name}:${i}` }, timestamp: i / 30 }
    }
    async *canvases(startS: number): AsyncGenerator<{ canvas: object; timestamp: number }, void, unknown> {
      const input = this.track.input
      let i = Math.floor(startS * 30)
      for (;;) {
        // A read takes a moment, and a dispose while it is in the air cancels it.
        await new Promise((r) => setTimeout(r, 2))
        if (input.disposed) throw new InputDisposedError('disposed')
        if (i >= 300) return
        yield { canvas: { width: 64, height: 36, tag: `${input.name}:${i}` }, timestamp: i / 30 }
        i++
      }
    }
  }
  return { ALL_FORMATS: [], BlobSource, CanvasSink, Input, InputDisposedError }
})
vi.mock('../state/persistence', () => ({
  getBlob: async (key: string): Promise<FakeBlob | null> =>
    key.startsWith('proxy:') ? (h.copyReady ? { size: 50, name: 'copy' } : null) : { size: 100, name: 'orig' },
}))
vi.mock('./proxyMedia', () => ({
  hasProxy: () => h.copyReady,
  proxyKeyFor: (id: string) => `proxy:${id}`,
  bumpProxyPriority: () => undefined,
}))
vi.mock('./memoryBudget', () => ({ budgets: () => ({ frames: 1e9 }) }))

const fc = await import('./frameCache')

let n = 0
const asset = (): MediaAsset => ({
  id: `v${++n}`,
  name: 'clip',
  kind: 'video',
  blobKey: `asset/v${n}`,
  durationS: 10,
  width: 64,
  height: 36,
  fps: 30,
  hasAudio: false,
  hasVideo: true,
})

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick()
  }
}

/** Ask for a frame the way the monitor does: every frame until it is there. */
async function frameOf(a: MediaAsset, tS: number): Promise<{ tag: string }> {
  let got: unknown = null
  await until(() => (got = fc.getFrameAt(a, tS)) !== null)
  return got as { tag: string }
}

beforeEach(() => {
  h.copyReady = false
  h.inputs.length = 0
  h.heights = { orig: 36, copy: 36 }
  h.sinks.length = 0
})

describe('PB-2: a reopen never breaks the decode that is running', () => {
  it('a preview copy landing mid-decode does not switch exact frames off', async () => {
    const a = asset()
    expect(fc.getFrameAt(a, 10 / 30)).toBeNull()
    await until(() => fc.frameCacheStats().decodingNow === 1)
    h.copyReady = true
    fc.getFrameAt(a, 12 / 30)
    expect((await frameOf(a, 10 / 30)).tag).toMatch(/:10$/)
    expect(fc.frameCacheStats().failed).toBe(0)
    // And it did move onto the copy for what came after.
    expect((await frameOf(a, 40 / 30)).tag).toBe('copy:40')
    fc.evictAsset(a.id)
  })

  it('a screenshot pressed mid-decode does not switch exact frames off', async () => {
    const a = asset()
    h.copyReady = true
    expect(fc.getFrameAt(a, 10 / 30)).toBeNull()
    await until(() => fc.frameCacheStats().decodingNow === 1)
    await fc.withFullQuality(async () => undefined)
    expect((await frameOf(a, 10 / 30)).tag).toMatch(/:10$/)
    expect(fc.frameCacheStats().failed).toBe(0)
    fc.evictAsset(a.id)
  })

  it('leaves no decoder open that nothing counts', async () => {
    const a = asset()
    fc.getFrameAt(a, 5 / 30)
    // The copy lands while the first open is still in flight.
    h.copyReady = true
    fc.getFrameAt(a, 6 / 30)
    await frameOf(a, 5 / 30)
    // Let that pump finish, so the next frame starts a fresh one.
    await until(() => fc.frameCacheStats().pumping === 0)
    await frameOf(a, 80 / 30)
    await until(() => fc.frameCacheStats().pumping === 0)
    const live = h.inputs.filter((i) => !i.disposed).length
    expect(live).toBeLessThanOrEqual(fc.frameCacheStats().openDecoders)
    fc.evictAsset(a.id)
    await tick(5)
    expect(h.inputs.filter((i) => !i.disposed)).toHaveLength(0)
  })
})

describe('PB-4: a still is made from his footage, not the preview copy', () => {
  it('a frame already cached from the copy is decoded again from the original', async () => {
    const a = asset()
    h.copyReady = true
    expect((await frameOf(a, 10 / 30)).tag).toBe('copy:10')
    const still = await fc.withFullQuality(() => frameOf(a, 10 / 30))
    expect(still.tag).toBe('orig:10')
    expect(fc.frameCacheStats().failed).toBe(0)
    fc.evictAsset(a.id)
  })
})

describe('PB-15: a preview copy is decoded at its own size, never blown up', () => {
  it('a 4K clip in a 1920 tall short decodes its 1080 copy natively, and the original capped to the short', async () => {
    fc.setPreviewSequenceHeight(1920)
    h.heights = { orig: 2160, copy: 1080 }
    const big = { ...asset(), width: 3840, height: 2160 }
    h.copyReady = true
    await frameOf(big, 1 / 30)
    expect(h.sinks.at(-1)).toEqual({ file: 'copy', height: undefined })
    fc.evictAsset(big.id)

    h.copyReady = false
    const orig = { ...asset(), width: 3840, height: 2160 }
    await frameOf(orig, 1 / 30)
    expect(h.sinks.at(-1)).toEqual({ file: 'orig', height: 1920 })
    fc.evictAsset(orig.id)
    fc.setPreviewSequenceHeight(0)
  })
})

/** Which file and frame the cache holds for this moment, without asking for a decode. */
const tagAt = (a: MediaAsset, tS: number): string | undefined =>
  (fc.peekFrameAt(a, tS) as unknown as { tag: string } | null)?.tag

describe('PB-13: the frame he rests on at Full is redone from his footage', () => {
  it('replaces the copy frame with the original one, through a reader it closes again', async () => {
    const a = asset()
    h.copyReady = true
    expect((await frameOf(a, 10 / 30)).tag).toBe('copy:10')
    const before = h.inputs.length
    expect(await fc.refineFromOriginal(a, 10 / 30)).toBe(true)
    expect(tagAt(a, 10 / 30)).toBe('orig:10')
    expect(h.inputs.slice(before).map((i) => [i.name, i.disposed])).toEqual([['orig', true]])
    // A later pass of the copy reader over the same frame never puts the copy back.
    fc.prefetchRange(a, 5 / 30, 15 / 30)
    await until(() => fc.peekFrameAt(a, 15 / 30) !== null)
    expect(tagAt(a, 10 / 30)).toBe('orig:10')
    expect(tagAt(a, 12 / 30)).toBe('copy:12')
    fc.evictAsset(a.id)
  })

  it('a refine he moved away from is stopped, and the copy frame stays', async () => {
    const a = asset()
    h.copyReady = true
    expect((await frameOf(a, 10 / 30)).tag).toBe('copy:10')
    const before = h.inputs.length
    const redo = fc.refineFromOriginal(a, 10 / 30)
    await until(() => h.inputs.length > before)
    fc.cancelRefine(a.id)
    expect(await redo).toBe(false)
    expect(h.inputs.slice(before).every((i) => i.disposed)).toBe(true)
    expect(tagAt(a, 10 / 30)).toBe('copy:10')
    fc.evictAsset(a.id)
  })

  // N3 (sweep review): the one-shot readers were kept one per ASSET, so a second
  // layer of the same take (a dissolve on one take, a clip over a bigger copy of
  // itself) stopped the first layer's redo, and cancelling one stopped both.
  it('two frames of one asset are redone side by side, and stopping one leaves the other', async () => {
    const a = asset()
    h.copyReady = true
    await frameOf(a, 10 / 30)
    await frameOf(a, 20 / 30)
    const before = h.inputs.length
    const one = fc.refineFromOriginal(a, 10 / 30)
    await until(() => h.inputs.length > before)
    const two = fc.refineFromOriginal(a, 20 / 30)
    await until(() => h.inputs.length > before + 1)
    fc.cancelRefine(a.id, 10 / 30)
    expect(await one).toBe(false)
    expect(await two).toBe(true)
    expect(tagAt(a, 10 / 30)).toBe('copy:10')
    expect(tagAt(a, 20 / 30)).toBe('orig:20')
    fc.evictAsset(a.id)
  })

  it('does nothing for a frame that is his footage already', async () => {
    const a = asset()
    expect((await frameOf(a, 10 / 30)).tag).toBe('orig:10')
    const before = h.inputs.length
    expect(await fc.refineFromOriginal(a, 10 / 30)).toBe(false)
    expect(h.inputs.length).toBe(before)
    fc.evictAsset(a.id)
  })
})
