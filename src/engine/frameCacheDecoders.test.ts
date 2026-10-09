// The decoder ceiling, driven through the real frame cache with a fake decoder.
//
// ⛔ THE CEILING WAS ENFORCED ONLY WHEN A DECODER OPENED (found 2026-10-06), and
// that check skips every entry that is decoding at the moment, because closing
// one mid-decode would strand its pump. A scrub across many clips opens nearly
// all of them at once, so nearly all were skipped, and nothing closed them once
// their decode ended: decoder-cap.spec.ts read 12 open against a cap of 8 with
// nothing pumping, queued or decoding, for the rest of the session. Unbounded,
// that is where Chromium quietly drops the whole app to software decode.
//
// This is the same walk without a browser: twelve clips asked for a frame, every
// decode held open until all twelve are decoding at once, the way a scrub's
// overlap, and then let go. Once the cache is idle, every decoder over the cap
// must be closed, and every frame asked for must still have arrived. Held by a
// latch, not a clock, so a busy machine cannot change what it tests.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { frameCacheStats, getFrameAt } from './frameCache'
import type { MediaAsset } from './types'

/** Every fake demuxer, and whether it has been disposed. */
const inputs = vi.hoisted((): { key: string; disposed: boolean }[] => [])
/** Holds every decode until the test lets go, so all twelve are mid-decode at once. */
const latch = vi.hoisted(() => {
  let open = (): void => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open: () => open() }
})

vi.mock('mediabunny', () => {
  class BlobSource {
    constructor(readonly blob: { key: string }) {}
  }
  class Input {
    readonly rec: { key: string; disposed: boolean }
    constructor(opts: { source: BlobSource }) {
      this.rec = { key: opts.source.blob.key, disposed: false }
      inputs.push(this.rec)
    }
    /** The frame cache asks the track how tall the file really is (PB-15), so the fake answers. */
    getPrimaryVideoTrack(): Promise<{ getDisplayHeight: () => Promise<number> }> {
      return Promise.resolve({ getDisplayHeight: () => Promise.resolve(180) })
    }
    dispose(): void {
      this.rec.disposed = true
    }
  }
  class CanvasSink {
    /** Frames at 30 fps from the one at `startS`, once the latch is open. */
    async *canvases(startS: number): AsyncGenerator<{ timestamp: number; canvas: { width: number; height: number } }> {
      await latch.opened
      for (let i = Math.floor(startS * 30); i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1))
        yield { timestamp: i / 30, canvas: { width: 4, height: 4 } }
      }
    }
  }
  return { ALL_FORMATS: [], BlobSource, Input, CanvasSink }
})

vi.mock('../state/persistence', () => ({
  // No preview copies: every clip decodes its original.
  getBlob: (key: string) => Promise.resolve(key.startsWith('blob:') ? { key, size: 1000 } : null),
}))

vi.mock('./proxyMedia', () => ({
  hasProxy: () => false,
  bumpProxyPriority: () => undefined,
  proxyKeyFor: (id: string) => `proxy:${id}`,
}))

const clip = (n: number): MediaAsset => ({
  id: `a${n}`,
  name: `clip ${n}.mp4`,
  kind: 'video',
  blobKey: `blob:a${n}`,
  durationS: 2,
  width: 320,
  height: 180,
  fps: 30,
  hasAudio: false,
  hasVideo: true,
})

describe('the preview never keeps more decoders open than the cap', () => {
  // The frame cache loads both lazily (a dynamic import in openInput). Loaded once
  // here first, and each clip below asked for once the one before it has opened,
  // because twelve dynamic imports of a mocked module issued in the same instant
  // are not all handed the mock: only the first was, and the rest reached the
  // real persistence and its IndexedDB. The decodes still all overlap: the latch
  // holds every one of them.
  beforeAll(async () => {
    await import('mediabunny')
    await import('../state/persistence')
  })

  it('closes the extras once their decodes end, and every frame asked for still arrives', async () => {
    const clips = Array.from({ length: 12 }, (_, n) => clip(n))
    // The scrub: every clip asked for a frame, one after another.
    for (const [n, c] of clips.entries()) {
      expect(getFrameAt(c, 0)).toBeNull()
      await vi.waitFor(() => expect(inputs).toHaveLength(n + 1), { timeout: 5000, interval: 2 })
    }
    await vi.waitFor(() => expect(frameCacheStats().decodingNow).toBe(12), { timeout: 5000, interval: 5 })
    // While they all decode, the cap is exceeded: none can be closed mid-decode.
    expect(inputs).toHaveLength(12)
    expect(frameCacheStats().openDecoders).toBe(12)
    latch.open()

    await vi.waitFor(
      () => {
        const s = frameCacheStats()
        expect(s.pumping + s.queued + s.decodingNow).toBe(0)
      },
      { timeout: 5000, interval: 10 },
    )

    const s = frameCacheStats()
    // The walk really did overrun the cap while it ran, or this proves nothing.
    expect(s.decoderCap).toBeLessThan(12)
    // Idle, every extra is one nobody is using: within the cap itself.
    expect(s.openDecoders, `${s.openDecoders} decoders open with nothing decoding`).toBeLessThanOrEqual(s.decoderCap)
    expect(inputs.filter((i) => !i.disposed)).toHaveLength(s.openDecoders)
    // Closing a decoder keeps its frames: every clip's frame is served from the cache.
    for (const c of clips) expect(getFrameAt(c, 0), `frame of ${c.id}`).not.toBeNull()
  })
})
