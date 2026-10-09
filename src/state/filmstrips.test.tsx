/**
 * @vitest-environment jsdom
 */
// Filmstrip generation, driven with <video> elements whose loads and seeks the
// test controls (PB-14): strips are cut from the preview copy when there is one,
// and one seek that never lands no longer stops every later clip's strip.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '../engine/types'

const h = vi.hoisted(() => ({
  copies: new Set<string>(),
  /** Element sources whose seeks never fire `seeked`. */
  stuck: new Set<string>(),
  /** Element sources whose load fails. */
  broken: new Set<string>(),
  made: [] as HTMLVideoElement[],
}))

vi.mock('./blobUrls', () => ({ getBlobUrl: async (key: string) => `blob:${key}` }))
vi.mock('../engine/proxyMedia', () => ({
  thumbnailSourceKey: (a: { id: string; blobKey: string }) => (h.copies.has(a.id) ? `proxy:${a.id}` : a.blobKey),
}))

const { useFilmstrip, stripVideoSourceCountForTests } = await import('./filmstrips')

const asset = (id: string): MediaAsset => ({
  id,
  name: id,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: false,
  hasVideo: true,
})

let strips = 0

beforeEach(() => {
  vi.useFakeTimers()
  const media = HTMLMediaElement.prototype
  Object.defineProperty(media, 'src', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return this.getAttribute('src') ?? ''
    },
    set(this: HTMLMediaElement, v: string) {
      this.setAttribute('src', v)
      void Promise.resolve().then(() =>
        h.broken.has(v) ? this.onerror?.(new Event('error')) : this.onloadeddata?.(new Event('loadeddata')),
      )
    },
  })
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get: () => 0,
    set(this: HTMLMediaElement) {
      if (h.stuck.has(this.getAttribute('src') ?? '')) return
      setTimeout(() => this.onseeked?.(new Event('seeked')), 5)
    },
  })
  media.load = () => undefined
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 })
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['jpeg']))
  }
  URL.createObjectURL = () => `blob:strip:${++strips}`
  URL.revokeObjectURL = () => undefined
  const make = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = make(tag)
    if (tag === 'video') h.made.push(el as HTMLVideoElement)
    return el
  }) as typeof document.createElement)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  h.copies.clear()
  h.stuck.clear()
  h.broken.clear()
  h.made.length = 0
})

const run = (ms: number): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

describe('filmstrips', () => {
  it('are cut from the preview copy once there is one', async () => {
    const a = asset('copied')
    h.copies.add(a.id)
    const { result } = renderHook(() => useFilmstrip(a, 128, 0, 4, 1))
    await run(200)
    expect(h.made.map((v) => v.getAttribute('src'))).toEqual(['blob:proxy:copied'])
    expect(result.current).toMatch(/^blob:strip:/)
  })

  it('one seek that never lands does not stop every later strip', async () => {
    const stuck = asset('stuck')
    const fine = asset('fine')
    h.stuck.add('blob:asset/stuck')
    const first = renderHook(() => useFilmstrip(stuck, 128, 0, 4, 1))
    const second = renderHook(() => useFilmstrip(fine, 128, 0, 4, 1))
    await run(1000)
    expect(second.result.current).toBeNull() // still queued behind the stuck one
    await run(3000)
    // The stuck strip gave up and keeps its poster; the queue moved on.
    expect(first.result.current).toBeNull()
    expect(second.result.current).toMatch(/^blob:strip:/)
  })

  // n-E (sweep review 2): a load that fails dropped the loaded element but kept
  // the note of the URL it was loaded from, one stale entry per asset that ever
  // failed, which nothing but a retry of the same asset would clear.
  it('a video that fails to load leaves no note of its source behind', async () => {
    const broken = asset('broken')
    h.broken.add('blob:asset/broken')
    // Other strips' videos stay loaded between tests, so count against what was held.
    const held = stripVideoSourceCountForTests()
    const { result } = renderHook(() => useFilmstrip(broken, 128, 0, 4, 1))
    await run(200)
    expect(result.current).toBeNull() // it keeps its poster
    expect(stripVideoSourceCountForTests()).toBe(held)
  })
})
