import { useEffect, type RefObject } from 'react'
import { useStore } from '../state/store'
import { zoomAroundPlan, zoomFitPxPerS, zoomToPlan } from './timelineZoom'

/**
 * Every way the timeline zooms: Ctrl+wheel around the pointer, "=" / "-" and
 * the toolbar anchored on the playhead, and "\" to fit. Each re-anchors
 * scrollLeft in the same event and re-measures the viewport right away.
 * Returns zoom-to-fit for the toolbar button.
 */
export function useTimelineZoom(
  lanesRef: RefObject<HTMLDivElement | null>,
  measureViewportNow: () => void,
  durationS: number,
): { zoomFit: () => void } {
  const setUI = useStore((s) => s.setUI)

  const zoomAround = (clientX: number, factor: number) => {
    const el = lanesRef.current
    if (!el) return
    const plan = zoomAroundPlan(useStore.getState().ui.pxPerS, factor, clientX - el.getBoundingClientRect().left, el.scrollLeft)
    if (!plan) return
    setUI({ pxPerS: plan.pxPerS })
    el.scrollLeft = plan.scrollLeft
    measureViewportNow()
  }

  // Keyboard / toolbar / slider zoom, anchored on the playhead (see zoomToPlan).
  const zoomTo = (nextRaw: number) => {
    const el = lanesRef.current
    if (!el) return
    const { pxPerS: old, playheadS } = useStore.getState().ui
    const plan = zoomToPlan(old, nextRaw, el.scrollLeft, el.clientWidth, playheadS)
    if (!plan) return
    setUI({ pxPerS: plan.pxPerS })
    el.scrollLeft = plan.scrollLeft
    measureViewportNow()
  }

  // "=" / "-" in the central keymap (store.zoomIn/zoomOut dispatch this).
  useEffect(() => {
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent<{ factor?: number; pxPerS?: number }>).detail
      if (detail?.pxPerS !== undefined) zoomTo(detail.pxPerS)
      else zoomTo(useStore.getState().ui.pxPerS * (detail?.factor ?? 1))
    }
    window.addEventListener('olpremiere:zoom', onZoom)
    return () => window.removeEventListener('olpremiere:zoom', onZoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomAround(e.clientX, e.deltaY < 0 ? 1.2 : 1 / 1.2)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const zoomFit = () => {
    const el = lanesRef.current
    if (!el || durationS <= 0) return
    setUI({ pxPerS: zoomFitPxPerS(el.clientWidth, durationS) })
    el.scrollLeft = 0
    measureViewportNow()
  }

  // "\" in the central keymap.
  useEffect(() => {
    window.addEventListener('olpremiere:zoom-fit', zoomFit)
    return () => window.removeEventListener('olpremiere:zoom-fit', zoomFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationS])

  return { zoomFit }
}
