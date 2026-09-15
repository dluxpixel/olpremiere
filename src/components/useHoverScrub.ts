// The <video> behind a hover scrubbed thumbnail (see hoverScrub.ts for the
// idea and the geometry). Mounted only while the pointer is over the picture,
// so a bin of fifty clips holds fifty posters and one decoder, never fifty.
//
// Seeks are coalesced: a decoder that is still landing one seek is not asked
// for another, the latest target waits in `pending` and goes out on `seeked`.
// Without that a fast sweep across the card queues dozens of seeks and the
// picture lags behind the pointer by seconds.

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { MediaAsset } from '../engine/types'
import { useBlobUrl } from '../state/blobUrls'
import { movedAFrame, scrubTimeAt } from './hoverScrub'

export interface HoverScrub {
  /** True while the pointer is over the picture of a scrubbable asset. */
  active: boolean
  /** Object URL of the media, resolved only once the hover begins. */
  url: string | null
  /** Source time under the pointer. */
  tS: number
  /** Pointer x inside the picture, for the position line. */
  xPx: number
  videoRef: RefObject<HTMLVideoElement>
  handlers: {
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerLeave: () => void
  }
  /** Wire to the <video>'s onLoadedMetadata and onSeeked. */
  onReady: () => void
}

export function useHoverScrub(asset: MediaAsset, fps: number): HoverScrub {
  const scrubbable = asset.kind === 'video' && asset.hasVideo && asset.durationS > 0
  const [active, setActive] = useState(false)
  const [tS, setTS] = useState(0)
  const [xPx, setXPx] = useState(0)
  const url = useBlobUrl(active && scrubbable ? asset.blobKey : undefined)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pending = useRef<number | null>(null)
  const shown = useRef(-1)

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      // HAVE_METADATA is 1: before it a currentTime write is dropped by some engines.
      if (!v || v.readyState < 1 || v.seeking) {
        pending.current = t
        return
      }
      if (!movedAFrame(shown.current, t, fps)) return
      shown.current = t
      v.currentTime = t
    },
    [fps],
  )

  const onReady = useCallback(() => {
    const t = pending.current
    if (t === null) return
    pending.current = null
    seek(t)
  }, [seek])

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!scrubbable) return
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left
    const t = scrubTimeAt(x, box.width, asset.durationS, fps)
    setXPx(x)
    setTS(t)
    if (!active) setActive(true)
    seek(t)
  }

  const onPointerLeave = (): void => {
    setActive(false)
    pending.current = null
    shown.current = -1
  }

  return {
    active: active && scrubbable,
    url,
    tS,
    xPx,
    videoRef,
    handlers: { onPointerEnter: onPointerMove, onPointerMove, onPointerLeave },
    onReady,
  }
}
