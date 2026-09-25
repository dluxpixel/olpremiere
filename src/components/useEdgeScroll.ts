import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { edgeSpeedX, edgeSpeedY } from './timelineEdgeScroll'

type Pointer = { clientX: number; clientY: number }

/**
 * Edge auto-scroll during drags. Park the pointer near a side of the lanes
 * and the view travels; each frame re-runs `onStep` from the parked pointer
 * so the clip/trim/scrub keeps following. Speeds: timelineEdgeScroll.ts.
 *
 * The rAF loop marks its scroll writes as programmatic (playback-follow must
 * not suspend). A running loop keeps the `onStep` it started with.
 */
export function useEdgeScroll(
  lanesRef: RefObject<HTMLDivElement | null>,
  programmaticScroll: MutableRefObject<boolean>,
): {
  /** Where the drag pointer last was. Set it before maybeEdgeScroll; null ends the loop. */
  lastDragPointer: MutableRefObject<Pointer | null>
  maybeEdgeScroll: (onStep: (p: Pointer) => void) => void
  stopEdgeScroll: () => void
} {
  const lastDragPointer = useRef<Pointer | null>(null)
  const edgeScrollRaf = useRef<number | null>(null)
  const edgeSpeed = (el: HTMLElement, clientX: number): number => edgeSpeedX(el.getBoundingClientRect(), clientX)
  const edgeSpeedYOf = (el: HTMLElement, clientY: number): number => edgeSpeedY(el.getBoundingClientRect(), clientY)

  const stopEdgeScroll = () => {
    if (edgeScrollRaf.current !== null) cancelAnimationFrame(edgeScrollRaf.current)
    edgeScrollRaf.current = null
  }

  const maybeEdgeScroll = (onStep: (p: Pointer) => void) => {
    const el = lanesRef.current
    const p = lastDragPointer.current
    if (!el || !p || (edgeSpeed(el, p.clientX) === 0 && edgeSpeedYOf(el, p.clientY) === 0)) {
      stopEdgeScroll()
      return
    }
    if (edgeScrollRaf.current !== null) return // loop already alive
    const step = () => {
      const el2 = lanesRef.current
      const p2 = lastDragPointer.current
      if (!el2 || !p2) {
        edgeScrollRaf.current = null
        return
      }
      const sp = edgeSpeed(el2, p2.clientX)
      const spY = edgeSpeedYOf(el2, p2.clientY)
      if (sp === 0 && spY === 0) {
        edgeScrollRaf.current = null
        return
      }
      const before = el2.scrollLeft
      const beforeY = el2.scrollTop
      programmaticScroll.current = true
      if (sp !== 0) el2.scrollLeft = Math.max(0, before + sp)
      if (spY !== 0) el2.scrollTop = Math.max(0, beforeY + spY)
      // At the rail ends nothing moved - don't spin the loop for free.
      if (el2.scrollLeft === before && el2.scrollTop === beforeY) {
        edgeScrollRaf.current = null
        return
      }
      onStep(p2)
      edgeScrollRaf.current = requestAnimationFrame(step)
    }
    edgeScrollRaf.current = requestAnimationFrame(step)
  }

  // A dying component must never leave a scroll loop running.
  useEffect(() => stopEdgeScroll, [])

  return { lastDragPointer, maybeEdgeScroll, stopEdgeScroll }
}
