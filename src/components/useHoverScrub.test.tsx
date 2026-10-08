/**
 * @vitest-environment jsdom
 */
// The bin's hover scrub loads the preview copy when there is one (PB-14): a
// seek in his long GOP original decodes seconds of video before it lands.

import { act, cleanup, renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '../engine/types'

const h = vi.hoisted(() => ({ copies: new Set<string>() }))
vi.mock('../state/blobUrls', () => ({ useBlobUrl: (key: string | undefined) => (key ? `blob:${key}` : null) }))
vi.mock('../engine/proxyMedia', () => ({
  thumbnailSourceKey: (a: { id: string; blobKey: string }) => (h.copies.has(a.id) ? `proxy:${a.id}` : a.blobKey),
}))

const { useHoverScrub } = await import('./useHoverScrub')

const asset: MediaAsset = {
  id: 'A',
  name: 'A',
  kind: 'video',
  blobKey: 'asset/A',
  durationS: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: false,
  hasVideo: true,
}

const over = (x: number) =>
  ({ clientX: x, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) } }) as unknown as ReactPointerEvent<HTMLElement>

afterEach(() => {
  cleanup()
  h.copies.clear()
})

describe('hover scrub', () => {
  it('loads the preview copy once there is one', () => {
    h.copies.add('A')
    const { result } = renderHook(() => useHoverScrub(asset, 30))
    expect(result.current.url).toBeNull()
    act(() => result.current.handlers.onPointerMove(over(40)))
    expect(result.current.url).toBe('blob:proxy:A')
  })

  it('and the original while there is none', () => {
    const { result } = renderHook(() => useHoverScrub(asset, 30))
    act(() => result.current.handlers.onPointerMove(over(40)))
    expect(result.current.url).toBe('blob:asset/A')
  })

  // n-D (sweep review 2): `shown` remembers the last time written to the <video>,
  // and a new url is a new source that starts at 0. The preview copy landing under
  // a pointer that has not moved a frame left the picture on frame 0 until it did.
  it('seeks the new source to the pointer even if the pointer has not moved since the url changed', () => {
    const { result, rerender } = renderHook(() => useHoverScrub(asset, 30))
    const video = { readyState: 1, seeking: false, currentTime: 0 }
    ;(result.current.videoRef as { current: unknown }).current = video
    act(() => result.current.handlers.onPointerMove(over(40)))
    expect(video.currentTime).toBeGreaterThan(3.9)
    // The preview copy lands: a new source, which starts from the top.
    h.copies.add('A')
    rerender()
    expect(result.current.url).toBe('blob:proxy:A')
    video.currentTime = 0
    act(() => result.current.handlers.onPointerMove(over(40)))
    expect(video.currentTime).toBeGreaterThan(3.9)
  })
})
