import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { LanesViewport } from './timelineLanes'

/**
 * Clip virtualization: the visible slice of the lanes, kept current.
 *
 * Only clips intersecting the visible time range (+ one full viewport of
 * margin each side, so ordinary scrolling never pops clips in at the edge)
 * are mounted. Until the first measure, everything renders (null viewport).
 */
export function useLanesViewport(lanesRef: RefObject<HTMLDivElement | null>): {
  viewport: LanesViewport | null
  /** The scroll-event measure, rAF-throttled. */
  scheduleViewportMeasure: () => void
  /** A measure right now, dropping any throttled one still owed. */
  measureViewportNow: () => void
} {
  const [viewport, setViewport] = useState<LanesViewport | null>(null)
  const scrollRafRef = useRef(0)
  const scheduleViewportMeasure = useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el = lanesRef.current
      if (el) setViewport({ left: el.scrollLeft, width: el.clientWidth })
    })
  }, [lanesRef])
  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    setViewport({ left: el.scrollLeft, width: el.clientWidth })
    const ro = new ResizeObserver(scheduleViewportMeasure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
  }, [lanesRef, scheduleViewportMeasure])

  // Zoom re-anchors scrollLeft in the SAME event as the pxPerS change, so the
  // virtualization window must be re-measured synchronously too - the async
  // scroll-event measure lands after paint, and one frame culled against the
  // stale scrollLeft blanks every visible clip.
  const measureViewportNow = () => {
    const el = lanesRef.current
    if (!el) return
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
    setViewport({ left: el.scrollLeft, width: el.clientWidth })
  }

  return { viewport, scheduleViewportMeasure, measureViewportNow }
}
