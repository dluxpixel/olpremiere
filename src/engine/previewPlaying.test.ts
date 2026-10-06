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
  subscribeBlobArrived: () => () => undefined,
}))
vi.mock('./proxyMedia', () => ({ setProxyBuildingPaused: () => undefined }))

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
