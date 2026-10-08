// @vitest-environment jsdom
//
// The PLAYING preview, driven frame by frame with a fake GL renderer, a fake
// frame cache and <video> elements whose play, pause and seeks are recorded.
// The pure window maths lives in preview.test.ts; this file is for what the
// texture ladder actually hands the renderer, which is the picture he sees.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameIndexAt } from './frameIndex'
import type { Clip, MediaAsset, Sequence, Track } from './types'
import type { RenderFrame, RenderLayer } from './render/types'

/** A decoded frame, tagged with the source frame it is. */
interface FakeFrame {
  width: number
  height: number
  tag: string
}

const h = vi.hoisted(() => ({
  frames: new Map<string, unknown>(),
  ranges: [] as Array<{ assetId: string; a: number; b: number }>,
  gets: [] as Array<{ assetId: string; t: number }>,
  drawn: [] as unknown[][],
  urls: new Map<string, string | null>(),
  arrivals: new Set<(key: string) => void>(),
  copy: false,
  scale: 1,
  refines: [] as Array<{ assetId: string; t: number }>,
  cancels: [] as Array<string | undefined>,
  cancelFrames: [] as Array<number | undefined>,
}))

const frameKey = (assetId: string, idx: number): string => `${assetId}:${idx}`

vi.mock('./frameCache', () => {
  const at = (asset: MediaAsset, t: number): unknown =>
    h.frames.get(`${asset.id}:${Math.max(0, Math.floor(t * (asset.fps || 30) + 0.5 - 1e-6))}`) ?? null
  return {
    getFrameAt: (asset: MediaAsset, t: number) => {
      h.gets.push({ assetId: asset.id, t })
      return at(asset, t)
    },
    peekFrameAt: (asset: MediaAsset, t: number) => at(asset, t),
    prefetchAround: () => undefined,
    prefetchRange: (asset: MediaAsset, a: number, b: number) => h.ranges.push({ assetId: asset.id, a, b }),
    previewCapHeight: () => undefined,
    setPreviewSequenceHeight: () => undefined,
    currentPreviewScale: () => h.scale,
    cancelRefine: (assetId?: string, tS?: number) => {
      h.cancels.push(assetId)
      h.cancelFrames.push(tS)
    },
    refineFromOriginal: async (asset: MediaAsset, t: number) => {
      h.refines.push({ assetId: asset.id, t })
      return false
    },
  }
})
vi.mock('./render/glRenderer', () => ({
  createRenderer: () => ({
    render: (frame: RenderFrame, source: (l: RenderLayer) => unknown) => {
      const out: unknown[] = []
      for (const op of frame.ops) {
        if (op.type === 'layer') out.push(source(op.layer))
        else if (op.type === 'transition') out.push(source(op.from), source(op.to))
      }
      h.drawn.push(out)
    },
    warm: () => undefined,
    releaseSources: () => undefined,
  }),
}))
vi.mock('../state/blobUrls', () => ({
  getBlobUrl: async (key: string) => (h.urls.has(key) ? h.urls.get(key) : `blob:${key}`),
  subscribeBlobArrived: (cb: (key: string) => void) => {
    h.arrivals.add(cb)
    return () => h.arrivals.delete(cb)
  },
}))
vi.mock('./proxyMedia', () => ({ setProxyBuildingPaused: () => undefined, hasProxy: () => h.copy }))

const preview = await import('./preview')

// ---- <video> elements that record what was asked of them -------------------

interface VideoState {
  paused: boolean
  t: number
  plays: number
  seeks: number[]
}
const states = new WeakMap<HTMLMediaElement, VideoState>()
const st = (el: HTMLMediaElement): VideoState => {
  let s = states.get(el)
  if (!s) {
    s = { paused: true, t: 0, plays: 0, seeks: [] }
    states.set(el, s)
  }
  return s
}
const videos: HTMLVideoElement[] = []

beforeEach(() => {
  const proto = HTMLMediaElement.prototype
  Object.defineProperty(proto, 'paused', { configurable: true, get: function (this: HTMLMediaElement) { return st(this).paused } })
  Object.defineProperty(proto, 'seeking', { configurable: true, get: () => false })
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get: function (this: HTMLMediaElement) {
      return st(this).t
    },
    set: function (this: HTMLMediaElement, v: number) {
      st(this).t = v
      st(this).seeks.push(v)
    },
  })
  proto.play = function (this: HTMLMediaElement) {
    st(this).paused = false
    st(this).plays++
    return Promise.resolve()
  }
  proto.pause = function (this: HTMLMediaElement) {
    st(this).paused = true
  }
  proto.load = () => undefined
  const make = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = make(tag)
    if (tag === 'video') videos.push(el as unknown as HTMLVideoElement)
    return el
  }) as typeof document.createElement)
})

afterEach(() => {
  vi.restoreAllMocks()
  h.frames.clear()
  h.ranges.length = 0
  h.gets.length = 0
  h.drawn.length = 0
  h.urls.clear()
  h.copy = false
  h.scale = 1
  h.refines.length = 0
  h.cancels.length = 0
  h.cancelFrames.length = 0
  videos.length = 0
  preview.releasePreviewScratch()
  for (const id of ['A', 'B']) preview.disposePreviewAsset(id)
})

// ---- fixtures ---------------------------------------------------------------

const asset = (id: string, o: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  name: id,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 60,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: false,
  hasVideo: true,
  ...o,
})

const clip = (o: Partial<Clip> & Pick<Clip, 'id' | 'assetId' | 'startS' | 'inS' | 'outS'>): Clip => ({
  speed: 1,
  enabled: true,
  transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0, anchorY: 0, crop: { t: 0, r: 0, b: 0, l: 0 } },
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...o,
})

const track = (clips: Clip[]): Track => ({
  id: 'T1',
  kind: 'video',
  name: 'V1',
  height: 48,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips,
})

const sequence = (clips: Clip[], fps = 30): Sequence => ({
  id: 'S1',
  name: 'Seq',
  fps,
  width: 1080,
  height: 1920,
  sampleRate: 48000,
  durationS: Math.max(...clips.map((c) => c.startS + (c.outS - c.inS) / Math.abs(c.speed || 1))),
  tracks: [track(clips)],
  markers: [],
})

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = 400
  c.height = 700
  c.getContext = (() => ({ isContextLost: () => false })) as unknown as HTMLCanvasElement['getContext']
  return c
}

/** Put a decoded frame for every source frame of [aS, bS] in the fake cache. */
function cacheFrames(a: MediaAsset, aS: number, bS: number): void {
  const fps = a.fps ?? 30
  for (let i = frameIndexAt(aS, fps); i <= frameIndexAt(bS, fps); i++) {
    h.frames.set(frameKey(a.id, i), { width: 1920, height: 1080, tag: `${a.id}:${i}` } satisfies FakeFrame)
  }
}

/** Let every pending getBlobUrl land and every pooled element report its first frame. */
async function loadVideos(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  for (const v of videos) v.dispatchEvent(new Event('loadeddata'))
}

const lastPicture = (): unknown => h.drawn[h.drawn.length - 1]?.[0]

// ---- PB-1 -------------------------------------------------------------------

describe('a reversed clip plays backward in the preview', () => {
  const A = asset('A')
  // Source 4..8 reversed: the clip opens on 8 and walks down to 4.
  const rev = clip({ id: 'r', assetId: 'A', startS: 0, inS: 4, outS: 8, speed: -1 })

  it('never plays a <video> forward for it, and draws the cached frames in falling order', async () => {
    const seq = sequence([rev])
    cacheFrames(A, 4, 8)
    const c = canvas()
    // Paused first, as he would be before pressing Space: this warms the element.
    preview.renderPreview(c, seq, { A }, 0, false)
    await loadVideos()
    for (let f = 0; f < 30; f++) preview.renderPreview(c, seq, { A }, f / 30, true)

    const el = videos[0]
    expect(el ? st(el).plays : 0).toBe(0)
    const tags = h.drawn.slice(1).map((d) => (d[0] as FakeFrame | null)?.tag)
    // Every playing frame is an exact cached frame, source 8 s down.
    expect(tags[0]).toBe('A:240')
    expect(tags[29]).toBe('A:211')
    const idx = tags.map((t) => Number(String(t).split(':')[1]))
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeLessThan(idx[i - 1])
  })

  it('feeds the decoder in chunks below the playhead, not one frame at a time', async () => {
    const seq = sequence([rev])
    const c = canvas()
    for (let f = 0; f < 60; f++) preview.renderPreview(c, seq, { A }, f / 30, true)
    const lows = new Set(h.ranges.filter((r) => r.assetId === 'A').map((r) => Math.min(r.a, r.b).toFixed(3)))
    // Two seconds of reversed play at 1x reach down in half second chunks.
    expect(lows.size).toBeGreaterThan(1)
    expect(lows.size).toBeLessThanOrEqual(5)
    // Every request reaches from below the playhead up to it, in source time.
    for (const r of h.ranges) expect(Math.min(r.a, r.b)).toBeLessThanOrEqual(Math.max(r.a, r.b))
  })

  it('holds its last good frame on a miss instead of showing something else', async () => {
    const seq = sequence([rev])
    cacheFrames(A, 7.9, 8)
    const c = canvas()
    for (let f = 0; f < 10; f++) preview.renderPreview(c, seq, { A }, f / 30, true)
    // Frames 240..237 were cached; past them the last one stays up.
    expect((lastPicture() as FakeFrame).tag).toBe('A:237')
  })

  it('a frozen clip shows its held frame while playing, and no element plays', async () => {
    const frozen = clip({ id: 'z', assetId: 'A', startS: 0, inS: 4, outS: 8, freezeAtS: 5 })
    const seq = sequence([frozen])
    cacheFrames(A, 5, 5)
    const c = canvas()
    preview.renderPreview(c, seq, { A }, 0, false)
    await loadVideos()
    for (let f = 0; f < 20; f++) preview.renderPreview(c, seq, { A }, f / 30, true)
    expect(videos.every((v) => st(v).plays === 0)).toBe(true)
    expect(h.drawn.slice(1).every((d) => (d[0] as FakeFrame).tag === 'A:150')).toBe(true)
  })
})

describe('the cut warm-up decodes the head the cut will actually show', () => {
  const A = asset('A')
  const B = asset('B')

  it('a reversed clip is warmed at its OUT point, a frozen one at its held frame', () => {
    const first = clip({ id: 'a', assetId: 'A', startS: 0, inS: 0, outS: 2 })
    const rev = clip({ id: 'r', assetId: 'B', startS: 2, inS: 10, outS: 14, speed: -1 })
    preview.renderPreview(canvas(), sequence([first, rev]), { A, B }, 1, true)
    const warm = h.ranges.find((r) => r.assetId === 'B')
    expect(warm).toBeDefined()
    expect(Math.max(warm!.a, warm!.b)).toBe(14)
    expect(Math.min(warm!.a, warm!.b)).toBeGreaterThanOrEqual(13)
  })

  it('a frozen head is warmed at its held frame', () => {
    const first = clip({ id: 'a', assetId: 'A', startS: 0, inS: 0, outS: 2 })
    const frz = clip({ id: 'z', assetId: 'B', startS: 2, inS: 10, outS: 14, freezeAtS: 12.5 })
    preview.renderPreview(canvas(), sequence([first, frz]), { A, B }, 1, true)
    const warm = h.ranges.find((r) => r.assetId === 'B')
    expect(warm).toEqual({ assetId: 'B', a: 12.5, b: 12.5 })
  })
})

// ---- PB-3 -------------------------------------------------------------------

describe('a clip whose media was missing gets its picture back when the media does', () => {
  const A = asset('A')
  const src = (el: HTMLVideoElement): string | null => el.getAttribute('src')

  it('a put back gives the warmed element its source at once', async () => {
    h.urls.set('asset/A', null) // missing when the monitor first warmed it
    preview.prewarmPreview([A])
    await loadVideos()
    expect(videos).toHaveLength(1)
    expect(src(videos[0])).toBeNull()

    h.urls.delete('asset/A') // the boot repair put it back
    for (const cb of h.arrivals) cb('asset/A')
    await new Promise((r) => setTimeout(r, 0))
    expect(src(videos[0])).toBe('blob:asset/A')
  })

  it('without an announcement it still asks again, at most once a second', async () => {
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    h.urls.set('asset/A', null)
    const seq = sequence([clip({ id: 'c', assetId: 'A', startS: 0, inS: 0, outS: 2 })])
    const c = canvas()
    preview.renderPreview(c, seq, { A }, 0.5, true)
    await loadVideos()
    h.urls.delete('asset/A')
    now += 200
    preview.renderPreview(c, seq, { A }, 0.5, true)
    await new Promise((r) => setTimeout(r, 0))
    expect(src(videos[0])).toBeNull() // too soon to ask again
    now += 1000
    preview.renderPreview(c, seq, { A }, 0.6, true)
    await new Promise((r) => setTimeout(r, 0))
    expect(src(videos[0])).toBe('blob:asset/A')
  })
})

// ---- PB-5 -------------------------------------------------------------------

describe('two layers on one element share one picture per frame', () => {
  const A = asset('A')
  let made = 0
  let draws = 0

  beforeEach(() => {
    made = 0
    draws = 0
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {
        made++
      }
      getContext() {
        return { drawImage: () => draws++ }
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a clip over a bigger copy of itself (the blurred background shape) scales the frame once, at one size', async () => {
    // Same take, same moment, one drawn four times the size of the other, so
    // the two want different upload sizes.
    const big = clip({ id: 'bg', assetId: 'A', startS: 0, inS: 0, outS: 4 })
    big.transform = { ...big.transform, scale: 4 }
    const front = clip({ id: 'fg', assetId: 'A', startS: 0, inS: 0, outS: 4 })
    const seq: Sequence = { ...sequence([big]), tracks: [track([big]), { ...track([front]), id: 'T2' }] }
    const c = canvas()
    preview.renderPreview(c, seq, { A }, 0, false)
    await loadVideos()
    for (let f = 1; f <= 10; f++) preview.renderPreview(c, seq, { A }, f / 30, true)
    // One scratch canvas for the element, made once, and one scaled copy per frame.
    expect(made).toBe(1)
    expect(draws).toBe(10)
    // Both layers drew that same picture.
    const last = h.drawn[h.drawn.length - 1]
    expect(last).toHaveLength(2)
    expect(last[0]).toBe(last[1])
  })
})

// ---- PB-6 -------------------------------------------------------------------

describe("pressing Play never shows the element's old picture", () => {
  const A = asset('A')
  const forward = clip({ id: 'f', assetId: 'A', startS: 0, inS: 0, outS: 4 })
  type Rvfc = (now: number, meta: { mediaTime: number; presentedFrames: number }) => void
  const rvfc = new Map<HTMLVideoElement, Rvfc>()
  let now = 1000
  /** The element puts a frame on screen. */
  const present = (el: HTMLVideoElement, mediaTime: number): void => {
    const cb = rvfc.get(el)
    rvfc.delete(el)
    cb?.(now, { mediaTime, presentedFrames: 1 })
  }

  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>
    proto.requestVideoFrameCallback = function (this: HTMLVideoElement, cb: Rvfc) {
      rvfc.set(this, cb)
      return 1
    }
    proto.cancelVideoFrameCallback = () => undefined
  })
  afterEach(() => {
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>
    delete proto.requestVideoFrameCallback
    delete proto.cancelVideoFrameCallback
    rvfc.clear()
  })

  it('serves the cached frame until the element has shown one after its seek', async () => {
    const seq = sequence([forward])
    cacheFrames(A, 0, 1)
    const c = canvas()
    preview.prewarmPreview([A])
    await loadVideos()
    // Parked on 0.5, a cached frame: the element itself is still back at 0.
    preview.renderPreview(c, seq, { A }, 0.5, false)
    const el = videos[0]
    for (let f = 0; f < 4; f++) {
      now += 16
      preview.renderPreview(c, seq, { A }, 0.5 + f / 30, true)
    }
    const playing = h.drawn.slice(-4).map((d) => d[0])
    expect(playing.every((p) => p !== el && (p as FakeFrame).tag.startsWith('A:'))).toBe(true)
    // The seek lands and the element shows a frame: from here it is the element.
    now += 16
    present(el, 0.5 + 4 / 30)
    preview.renderPreview(c, seq, { A }, 0.5 + 4 / 30, true)
    expect(lastPicture()).toBe(el)
  })

  it('parks the paused element on the playhead once it has rested, and only then', async () => {
    const seq = sequence([forward])
    cacheFrames(A, 0, 2)
    const c = canvas()
    preview.prewarmPreview([A])
    await loadVideos()
    for (const t of [0.2, 0.4, 0.6, 0.8]) preview.renderPreview(c, seq, { A }, t, false)
    const el = videos[0]
    expect(st(el).seeks).toEqual([])
    await new Promise((r) => setTimeout(r, 260))
    expect(st(el).seeks).toEqual([0.8])
  })

  /**
   * The decoder keeping up between draws: every range asked for lands, but at
   * most 16 new frames of it, which is all the real queue keeps of one request
   * (frameCache PENDING_CAP). Returns how many requests it has handled.
   */
  const deliver = (a: MediaAsset, from: number): number => {
    const fps = a.fps ?? 30
    for (; from < h.ranges.length; from++) {
      const r = h.ranges[from]
      if (r.assetId !== a.id) continue
      let n = 0
      for (let i = frameIndexAt(Math.min(r.a, r.b), fps); i <= frameIndexAt(Math.max(r.a, r.b), fps) && n < 16; i++) {
        if (h.frames.has(frameKey(a.id, i))) continue
        h.frames.set(frameKey(a.id, i), { width: 1920, height: 1080, tag: frameKey(a.id, i) } satisfies FakeFrame)
        n++
      }
    }
    return from
  }

  it('keeps the frame cache decoding ahead while the element is off its frame, so the exact frame is there', async () => {
    h.copy = true
    const A60 = asset('A', { fps: 60 })
    const seq = sequence([forward], 60)
    const c = canvas()
    preview.prewarmPreview([A60])
    await loadVideos()
    const el = videos[0]
    preview.renderPreview(c, seq, { A: A60 }, 1, true) // starts it
    let seen = deliver(A60, 0)
    // One second with the element stuck half a second or more behind the
    // playhead, where a slow seek on his long GOP capture leaves it.
    for (let f = 1; f <= 60; f++) {
      now += 1000 / 60
      present(el, 0.5)
      preview.renderPreview(c, seq, { A: A60 }, 1 + f / 60, true)
      seen = deliver(A60, seen)
    }
    // Every one of those frames was the exact frame, never the element behind it.
    const tags = h.drawn.slice(-60).map((d) => (d[0] as FakeFrame | null)?.tag)
    expect(tags).toEqual(Array.from({ length: 60 }, (_, i) => `A:${61 + i}`))
    // In a handful of requests, not one per frame.
    expect(h.ranges.length).toBeGreaterThan(2)
    expect(h.ranges.length).toBeLessThanOrEqual(8)
  })

  it('asks the cache for each frame once while the seek is in flight, so the miss limit keeps its length', async () => {
    const seq = sequence([forward])
    const c = canvas()
    preview.prewarmPreview([A])
    await loadVideos()
    // The seek never presents a frame and nothing is cached.
    for (let f = 0; f < 6; f++) {
      now += 33
      preview.renderPreview(c, seq, { A }, 1 + f / 30, true)
    }
    const asked = h.gets.filter((g) => g.assetId === 'A').map((g) => g.t)
    expect(asked).toEqual([...new Set(asked)])
    expect(asked).toHaveLength(6)
  })

  // ⛔ AT PLAY START THE ELEMENT RAN AHEAD OF THE HELD PICTURE (sweep review S1).
  // The picture holds the first frame until the first sound reaches his ears: the
  // scheduling latency plus the output latency (PB-8), 0.09 s on his default
  // output and 0.35 s on Bluetooth. The element was started on the first draw and
  // ran on through the hold, so it began the run that far AHEAD of the picture
  // and the 2% servo needed 4.5 to 17 s to absorb it; at 0.3 s and up the gap
  // passed the 0.35 s hard-seek limit and the element seeked back during the hold.
  describe('the element does not run ahead of a picture held at play start', () => {
    const HZ = 60
    /** One display frame on: the clock moves, an element that is playing moves with it, and shows a frame. */
    function tick(el: HTMLVideoElement): void {
      now += 1000 / HZ
      if (!st(el).paused) {
        st(el).t += 1 / HZ
        present(el, st(el).t)
      }
    }

    /** Warm the element, rest on the frame at `from`, then press Play there. */
    async function pressPlay(seq: Sequence, from: number): Promise<{ c: HTMLCanvasElement; el: HTMLVideoElement }> {
      const c = canvas()
      preview.prewarmPreview([A])
      await loadVideos()
      const el = videos[0]
      preview.renderPreview(c, seq, { A }, from, false)
      return { c, el }
    }

    it.each([
      ['his default output, 0.09 s', 0.09],
      ['Bluetooth, 0.35 s', 0.35],
    ])('stays parked on the held frame through %s, then plays once the picture moves', async (_name, holdS) => {
      const seq = sequence([forward])
      const { c, el } = await pressPlay(seq, 1)
      const seeksAtPlay = st(el).seeks.length
      const holdFrames = Math.round(holdS * HZ)
      for (let f = 0; f <= holdFrames; f++) {
        preview.renderPreview(c, seq, { A }, 1, true)
        tick(el)
      }
      expect(st(el).plays).toBe(0)
      expect(st(el).paused).toBe(true)
      expect(st(el).t).toBeCloseTo(1, 9)
      // No seek back either: it never left the frame the picture holds.
      expect(st(el).seeks.length).toBe(seeksAtPlay)

      // The sound reaches him and the picture moves: the element goes with it.
      const moved: number[] = []
      for (let f = 1; f <= 90; f++) {
        preview.renderPreview(c, seq, { A }, 1 + f / HZ, true)
        tick(el)
        moved.push(st(el).t - (1 + f / HZ))
      }
      expect(st(el).plays).toBe(1)
      // Never ahead of the picture (it starts a frame behind it, not 0.09 to 0.35 s in front).
      expect(Math.max(...moved)).toBeLessThan(1 / 30 / 2)
      expect(Math.min(...moved)).toBeGreaterThan(-3 / 30)
    })

    it('an element that is not ready during the hold is still not started ahead of it', async () => {
      const seq = sequence([forward])
      const c = canvas()
      // Press Play on a cold element: it has not reported its first frame yet.
      preview.renderPreview(c, seq, { A }, 1, false)
      preview.renderPreview(c, seq, { A }, 1, true)
      for (let f = 0; f < 10; f++) preview.renderPreview(c, seq, { A }, 1, true)
      await loadVideos()
      const el = videos[0]
      for (let f = 0; f < 20; f++) {
        preview.renderPreview(c, seq, { A }, 1, true)
        tick(el)
      }
      expect(st(el).plays).toBe(0)
      preview.renderPreview(c, seq, { A }, 1 + 1 / HZ, true)
      expect(st(el).plays).toBe(1)
    })

    it('a shuttle, whose picture moves at once, starts the element on its second frame', async () => {
      const seq = sequence([forward])
      const { c, el } = await pressPlay(seq, 1)
      preview.renderPreview(c, seq, { A }, 1, true)
      tick(el)
      preview.renderPreview(c, seq, { A }, 1 + 2 / HZ, true)
      expect(st(el).plays).toBe(1)
    })

    it('a clip that comes up mid-play starts its element on its first frame, as before', async () => {
      const first = clip({ id: 'f1', assetId: 'A', startS: 0, inS: 0, outS: 2 })
      const second = clip({ id: 'f2', assetId: 'B', startS: 2, inS: 0, outS: 2 })
      const B = asset('B')
      const seq = sequence([first, second])
      const c = canvas()
      preview.prewarmPreview([A, B])
      await loadVideos()
      preview.renderPreview(c, seq, { A, B }, 0, false)
      // Run well into the first clip, then across the cut.
      for (let f = 0; f <= 30; f++) {
        now += 1000 / HZ
        preview.renderPreview(c, seq, { A, B }, f / HZ, true)
      }
      const elB = videos.find((v) => v !== videos[0])
      expect(elB ? st(elB).plays : -1).toBe(0)
      now += 1000 / HZ
      preview.renderPreview(c, seq, { A, B }, 2, true)
      expect(elB ? st(elB).plays : -1).toBe(1)
    })
  })
})

// ⛔ FOUND 2026-10-08 by e2e/transition-stale-frame.spec.ts, red since PB-6:
// a dissolve on one razored take, played into from a second and a half before
// the cut, showed only the incoming clip, never the outgoing one (0 green
// frames of 38). PB-6 stopped the element's old picture after Play counting as
// this clip's own; that old picture had been the only thing the outgoing side
// ever got to hold. On his long GOP capture without a preview copy the cache
// cannot keep up and the element runs a few frames late the whole way in, so
// no picture was held at all and the outgoing side drew nothing.
describe('the outgoing side of a dissolve has its own clip to hold, even when the element runs late into it', () => {
  const A = asset('A')
  // One take razored: a keeps 20..22, b keeps 30..34 with a 1 s dissolve at its head.
  const a = clip({ id: 'a', assetId: 'A', startS: 0, inS: 20, outS: 22 })
  const b = clip({ id: 'b', assetId: 'A', startS: 2, inS: 30, outS: 34, transitionIn: { type: 'crossDissolve', durationS: 1 } })
  type Rvfc = (now: number, meta: { mediaTime: number; presentedFrames: number }) => void
  const rvfc = new Map<HTMLVideoElement, Rvfc>()
  let now = 1000
  /** The element puts a frame on screen. */
  const present = (el: HTMLVideoElement, mediaTime: number): void => {
    const cb = rvfc.get(el)
    rvfc.delete(el)
    cb?.(now, { mediaTime, presentedFrames: 1 })
  }
  /** The incoming clip's own element, which the pre-roll made. */
  const incoming = (): HTMLVideoElement => videos.find((v) => v !== videos[0])!

  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>
    proto.requestVideoFrameCallback = function (this: HTMLVideoElement, cb: Rvfc) {
      rvfc.set(this, cb)
      return 1
    }
    proto.cancelVideoFrameCallback = () => undefined
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: () => undefined }
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 })
  })
  afterEach(() => {
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>
    delete proto.requestVideoFrameCallback
    delete proto.cancelVideoFrameCallback
    rvfc.clear()
    vi.unstubAllGlobals()
  })

  it('a picture of the outgoing clip a few frames late is held, and the dissolve shows it', async () => {
    const seq = sequence([a, b])
    const c = canvas()
    preview.prewarmPreview([A])
    await loadVideos()
    const el = videos[0]
    // Play from 0.5 (source 20.5). Nothing is ever in the cache, and the shared
    // element runs a quarter second behind the playhead: its own clip, never
    // inside tolerance.
    for (let f = 0; f < 45; f++) {
      const tS = 0.5 + f / 30
      now += 1000 / 30
      present(el, 20 + tS - 0.25)
      preview.renderPreview(c, seq, { A }, tS, true)
    }
    // The incoming clip's own element (warmed by the pre-roll) is ready.
    await loadVideos()
    // Into the dissolve. The outgoing side has no decoded frame, and the shared
    // element has fallen further back than it may be trusted for.
    const before = h.drawn.length
    for (let f = 0; f < 30; f++) {
      const tS = 2 + f / 30
      now += 1000 / 30
      present(el, 20 + tS - 0.6)
      present(incoming(), 30 + tS - 2) // the incoming clip is right on time
      preview.renderPreview(c, seq, { A }, tS, true)
    }
    // Drawn on every frame (a missing side right after the cut would hold the
    // frame before it instead), and every one still has the outgoing clip.
    const inWindow = h.drawn.slice(before)
    expect(inWindow).toHaveLength(30)
    expect(inWindow.every((d) => d[0] !== null)).toBe(true)
  })

  it('a picture of another part of the take is never held for it', async () => {
    const seq = sequence([a, b])
    const c = canvas()
    preview.prewarmPreview([A])
    await loadVideos()
    const el = videos[0]
    // The element is stuck a second away: not this clip's own moment.
    for (let f = 0; f < 45; f++) {
      const tS = 0.5 + f / 30
      now += 1000 / 30
      present(el, 19)
      preview.renderPreview(c, seq, { A }, tS, true)
    }
    await loadVideos()
    const before = h.drawn.length
    for (let f = 0; f < 30; f++) {
      const tS = 2 + f / 30
      now += 1000 / 30
      present(el, 19)
      present(incoming(), 30 + tS - 2)
      preview.renderPreview(c, seq, { A }, tS, true)
    }
    const inWindow = h.drawn.slice(before)
    expect(inWindow.length).toBeGreaterThan(0)
    expect(inWindow.every((d) => d[0] === null)).toBe(true)
  })
})

// ---- PB-16 ------------------------------------------------------------------

describe('what a pause lands on: the frame the monitor last drew while playing', () => {
  const A = asset('A')
  const forward = clip({ id: 'f', assetId: 'A', startS: 0, inS: 0, outS: 4 })

  it('remembers a playing draw, never a paused one, until the next run of play', async () => {
    const seq = sequence([forward])
    cacheFrames(A, 0, 4)
    const c = canvas()
    preview.prewarmPreview([A])
    await loadVideos()
    preview.forgetPlayedFrame()
    expect(preview.lastPlayedFrameS()).toBeNull()
    preview.renderPreview(c, seq, { A }, 1.5, true)
    expect(preview.lastPlayedFrameS()).toBe(1.5)
    preview.renderPreview(c, seq, { A }, 2, false)
    expect(preview.lastPlayedFrameS()).toBe(1.5)
    preview.forgetPlayedFrame()
    expect(preview.lastPlayedFrameS()).toBeNull()
  })
})

// ---- PB-13 ------------------------------------------------------------------

describe('at Full, the frame he rests on is redone from his footage', () => {
  const A = asset('A')
  const forward = clip({ id: 'f', assetId: 'A', startS: 0, inS: 0, outS: 4 })

  it('asks once the playhead has rested, never while it moves', async () => {
    const seq = sequence([forward])
    cacheFrames(A, 0, 2)
    const c = canvas()
    for (const t of [0.2, 0.4, 0.6, 0.8]) preview.renderPreview(c, seq, { A }, t, false)
    expect(h.refines).toEqual([])
    await new Promise((r) => setTimeout(r, 300))
    expect(h.refines).toEqual([{ assetId: 'A', t: 0.8 }])
  })

  it('moving on stops the redo of the frame he left, and so does Play', async () => {
    const seq = sequence([forward])
    cacheFrames(A, 0, 2)
    const c = canvas()
    preview.renderPreview(c, seq, { A }, 0.8, false)
    await new Promise((r) => setTimeout(r, 300))
    expect(h.refines).toHaveLength(1)
    preview.renderPreview(c, seq, { A }, 1, false)
    expect(h.cancels).toEqual(['A'])
    preview.renderPreview(c, seq, { A }, 1, true)
    expect(h.cancels).toEqual(['A', undefined])
  })

  // N3 (sweep review): the settle timer was kept per ASSET, so two layers of one
  // take at different moments (a dissolve on one take, a clip over a copy of
  // itself at another offset) each re-armed it for the other at every draw and
  // neither frame was ever redone.
  it('every layer of one take is redone for its own frame, each draw re-asking changes nothing', async () => {
    const early = clip({ id: 'early', assetId: 'A', startS: 0, inS: 0, outS: 4 })
    const late = clip({ id: 'late', assetId: 'A', startS: 0, inS: 2, outS: 6 })
    const seq: Sequence = { ...sequence([early]), tracks: [track([early]), { ...track([late]), id: 'T2' }] }
    cacheFrames(A, 0, 6)
    const c = canvas()
    for (let i = 0; i < 3; i++) preview.renderPreview(c, seq, { A }, 0.8, false)
    await new Promise((r) => setTimeout(r, 300))
    expect(h.refines.map((r) => r.t).sort()).toEqual([0.8, 2.8])
    // Moving on stops each layer's own old frame, not the take's every frame.
    preview.renderPreview(c, seq, { A }, 1, false)
    expect(h.cancelFrames.sort()).toEqual([0.8, 2.8])
  })

  it('never at Half or Quarter', async () => {
    h.scale = 0.5
    const seq = sequence([forward])
    cacheFrames(A, 0, 2)
    preview.renderPreview(canvas(), seq, { A }, 0.8, false)
    await new Promise((r) => setTimeout(r, 300))
    expect(h.refines).toEqual([])
  })
})
