import { quantizeToFrame } from '../engine/timecode'
import { MAX_PX_PER_S, MIN_PX_PER_S } from '../state/store'

/** The zoom a request would land on, held inside the store's zoom range. */
export const clampPxPerS = (pxPerS: number): number => Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, pxPerS))

/** A zoom to apply: the new scale and the scrollLeft that keeps the anchor still. */
export interface ZoomPlan {
  pxPerS: number
  scrollLeft: number
}

/**
 * Ctrl+wheel zoom around the pointer. `offsetX` is the pointer's distance from
 * the lanes' left edge. Null when the zoom is already at its limit.
 */
export function zoomAroundPlan(oldPxPerS: number, factor: number, offsetX: number, scrollLeft: number): ZoomPlan | null {
  const next = clampPxPerS(oldPxPerS * factor)
  if (next === oldPxPerS) return null
  const tAt = (offsetX + scrollLeft) / oldPxPerS
  return { pxPerS: next, scrollLeft: Math.max(0, tAt * next - offsetX) }
}

// Keyboard / toolbar / slider zoom: anchor on the playhead when it's in
// view, else the viewport center - zooming must never slide the thing you
// are looking at out of the window (raw setUI({pxPerS}) drifts toward t=0).
export function zoomToPlan(
  oldPxPerS: number,
  nextRaw: number,
  scrollLeft: number,
  clientWidth: number,
  playheadS: number,
): ZoomPlan | null {
  const next = clampPxPerS(nextRaw)
  if (next === oldPxPerS) return null
  const viewStartS = scrollLeft / oldPxPerS
  const viewEndS = (scrollLeft + clientWidth) / oldPxPerS
  const anchorS =
    playheadS >= viewStartS && playheadS <= viewEndS ? playheadS : (viewStartS + viewEndS) / 2
  const anchorPx = anchorS * oldPxPerS - scrollLeft
  return { pxPerS: next, scrollLeft: Math.max(0, anchorS * next - anchorPx) }
}

/** The zoom that fits the whole sequence in the lanes, with 40px of air. */
export const zoomFitPxPerS = (clientWidth: number, durationS: number): number =>
  clampPxPerS((clientWidth - 40) / durationS)

/**
 * Where auto-follow should put scrollLeft for the playhead at `px`, or null to
 * leave the view alone.
 *
 * Playing: page forward when the playhead runs off the right edge, and
 * re-centre only when it is fully off-screen (e.g. after Home). Do NOT
 * tug back when the user has scrolled ahead of the playhead.
 *
 * Paused: this used to be switched off entirely, so Home, End, the
 * previous and next cut keys and a click on a word in the Words tab
 * moved the picture while the timeline stayed where it was, with the
 * playhead somewhere off screen. A jump that lands out of view now
 * brings the view to it; a jump inside the view moves nothing.
 */
export function followScrollLeft(px: number, scrollLeft: number, clientWidth: number, playing: boolean): number | null {
  const left = scrollLeft
  const right = left + clientWidth
  const offScreen = px < left || px > right
  const shouldFollow = playing ? px > right - 40 || px < left - clientWidth : offScreen
  if (!shouldFollow) return null
  return Math.max(0, px - (playing ? 80 : clientWidth / 2))
}

/** The frame under a pointer `offsetX` pixels into the content, never before zero. */
export const frameAtOffset = (offsetX: number, pxPerS: number, fps: number): number =>
  quantizeToFrame(Math.max(0, offsetX / pxPerS), fps)
