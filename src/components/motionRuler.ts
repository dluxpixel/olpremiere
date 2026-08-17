// Pure ruler maths for the Motion Rail, kept out of MotionRail.tsx so the one
// x-axis every lane reads is unit-testable without the React/DOM stack - the
// same split monitorSizing.ts makes for the program monitor.
//
// A VIEW is the whole state of that axis: a zoom (pixels per second) and the
// LOCAL clip time sitting at the left edge. Ruler, lanes, curve editor and the
// playhead all map time to pixels through these functions and nothing else, so
// they can never disagree about where a moment is.

import { quantizeToFrame } from '../engine/timecode'
import type { AnimChannel } from '../engine/types'

/** Zoom floor: below this a 20-second clip is a smear and nothing is grabbable. */
export const MIN_RAIL_PX_PER_S = 8
/** Zoom ceiling: at 30fps that is 66px per frame, a thumb's width for a 5f punch. */
export const MAX_RAIL_PX_PER_S = 2000
/** Fallback zoom before the rail has been measured (or on a zero-length clip). */
export const DEFAULT_RAIL_PX_PER_S = 100
/** One wheel notch, matching the timeline's own zoom feel. */
export const RAIL_ZOOM_STEP = 1.2

/** Tick spacing floor: closer than this and the ticks read as a filled bar. */
const MIN_TICK_PX = 6
/** Timecode labels need this much room or they collide ("00:00:01:12" is wide). */
const MIN_LABEL_PX = 64
/** Hard cap so a wide view can never ask the DOM for thousands of ticks. */
const MAX_RAIL_TICKS = 400

/** The shared x-axis: how far it is zoomed, and what time is at its left edge. */
export interface RailView {
  pxPerS: number
  /** LOCAL clip time at x = 0. */
  startS: number
}

/** One drawn tick. `major` ones are taller and carry the timecode. */
export interface RailTick {
  t: number
  px: number
  major: boolean
}

export const clampPxPerS = (v: number): number =>
  !Number.isFinite(v) ? DEFAULT_RAIL_PX_PER_S : Math.min(MAX_RAIL_PX_PER_S, Math.max(MIN_RAIL_PX_PER_S, v))

/**
 * Keep the view over the clip: never before its head, and never scrolled past
 * the point where its tail sits at the right edge. When the whole clip fits,
 * the only legal start is 0, which is what makes double-click-to-fit stick.
 */
export function clampStart(startS: number, durS: number, pxPerS: number, viewW: number): number {
  if (!Number.isFinite(startS)) return 0
  const spanS = pxPerS > 0 && viewW > 0 ? viewW / pxPerS : Math.max(0, durS)
  const maxStart = Math.max(0, Math.max(0, durS) - spanS)
  return Math.min(Math.max(startS, 0), maxStart)
}

/** Fit the whole clip in `viewW`. What the rail opens on and what a double-click restores. */
export function fitView(durS: number, viewW: number): RailView {
  if (!(durS > 0) || !(viewW > 0)) return { pxPerS: DEFAULT_RAIL_PX_PER_S, startS: 0 }
  return { pxPerS: clampPxPerS(viewW / durS), startS: 0 }
}

/**
 * Zoom by `factor` about the pointer: the time under the cursor stays under the
 * cursor. Zooming from the left edge instead would slide the punch he is aiming
 * at out of the window every notch.
 */
export function zoomAt(
  view: RailView,
  factor: number,
  pointerPx: number,
  durS: number,
  viewW: number,
): RailView {
  const pxPerS = clampPxPerS(view.pxPerS * factor)
  if (pxPerS === view.pxPerS || !(view.pxPerS > 0)) return view
  const tAt = view.startS + pointerPx / view.pxPerS
  return { pxPerS, startS: clampStart(tAt - pointerPx / pxPerS, durS, pxPerS, viewW) }
}

/** Pan the view by a pixel delta (a drag on the ruler moves the CONTENT with the pointer). */
export function panBy(view: RailView, dxPx: number, durS: number, viewW: number): RailView {
  if (!(view.pxPerS > 0)) return view
  const startS = clampStart(view.startS - dxPx / view.pxPerS, durS, view.pxPerS, viewW)
  return startS === view.startS ? view : { pxPerS: view.pxPerS, startS }
}

/** Ascending, no repeats: frame multiples first, then the human second steps. */
function stepLadder(frameS: number): number[] {
  const raw = [frameS, frameS * 2, frameS * 5, frameS * 10, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const out: number[] = []
  for (const s of raw) if (out.length === 0 || s > out[out.length - 1] + 1e-9) out.push(s)
  return out
}

/**
 * Seconds between ticks: the finest step on the ladder that still leaves the
 * ticks apart enough to read. Zoomed in that is one FRAME, which is the grid
 * every keyframe snaps to; zoomed out it climbs to whole seconds and beyond.
 */
export function tickStepS(pxPerS: number, fps: number): number {
  const frameS = 1 / Math.max(1, Math.round(fps) || 30)
  const ladder = stepLadder(frameS)
  for (const s of ladder) if (s * pxPerS >= MIN_TICK_PX) return s
  return ladder[ladder.length - 1]
}

/**
 * The ticks visible in `viewW` pixels, left to right. Only what is on screen is
 * returned, so the cost of the ruler is the width of the panel and not the
 * length of the clip.
 */
export function railTicks(view: RailView, viewW: number, durS: number, fps: number): RailTick[] {
  const out: RailTick[] = []
  if (!(view.pxPerS > 0) || !(viewW > 0) || !(durS > 0)) return out
  const step = tickStepS(view.pxPerS, fps)
  // Label every Nth tick, N chosen so labels can never overlap: the label rides
  // a tick rather than sitting on its own grid, so the number always names a line.
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_PX / (step * view.pxPerS)))
  const endS = Math.min(durS, view.startS + viewW / view.pxPerS)
  const first = Math.max(0, Math.ceil(view.startS / step - 1e-9))
  for (let i = first; out.length < MAX_RAIL_TICKS; i++) {
    const t = i * step
    if (t > endS + 1e-9) break
    out.push({ t, px: (t - view.startS) * view.pxPerS, major: i % labelEvery === 0 })
  }
  return out
}

/**
 * Snap a local time to the frame grid and hold it inside the clip. Keyframes
 * ALWAYS land on a frame boundary: a keyframe a third of a frame off renders on
 * the same frame anyway and only makes the timecode lie about where it is.
 */
export function railSnap(tS: number, fps: number, durS: number): number {
  const q = fps > 0 ? quantizeToFrame(tS, fps) : tS
  return Math.max(0, Math.min(q, Math.max(0, durS)))
}

/**
 * A DRAGGED diamond's landing: pulled to the nearest moment that matters, then
 * frame snapped and held inside the clip.
 *
 * ⛔ THE FRAME QUANTISE RUNS LAST AND THAT IS NOT A COMPROMISE. Every keyframe in
 * this app sits on a frame boundary, and `matchMove` compares those times exactly
 * to work out which move a clip is making, so a diamond pulled to a marker still
 * has to land on a frame or the shelf stops naming a move nobody edited.
 *
 * ⛔ AND IT IS SEPARATE FROM `railSnap` BECAUSE ONLY DRAGS GET THE PULL. `railSnap`
 * also commits the keyframe time he TYPES into the field under a selected diamond,
 * and a typed number that quietly lands somewhere else answers a question he did
 * not ask.
 *
 * `points` are LOCAL clip seconds and `withinS` is the pull radius, which the rail
 * works out from pixels because only the rail knows the zoom. An empty list, or a
 * radius of zero, is exactly `railSnap`.
 */
export function railDragSnap(
  tS: number,
  fps: number,
  durS: number,
  points: readonly number[],
  withinS: number,
): number {
  if (points.length === 0 || !(withinS > 0)) return railSnap(tS, fps, durS)
  let best = tS
  let bestDist = withinS
  for (const p of points) {
    const dist = Math.abs(p - tS)
    // Strict <, so the earliest point wins an exact tie: the same rule the
    // timeline's own snapTime follows, and a tie that flipped with list order
    // would make the same drag land in two places on two nights.
    if (dist < bestDist) {
      bestDist = dist
      best = p
    }
  }
  return railSnap(best, fps, durS)
}

/**
 * Closest two moments may be parked by a drag: ONE FRAME, not the engine's bare
 * arithmetic minimum. Two diamonds a fifth of a millisecond apart are one
 * diamond at every zoom, and the next drag grabs whichever the DOM lists first.
 */
export const railMinGapS = (fps: number): number => 1 / (fps > 0 ? fps : 30)

/**
 * Identity of one keyframe in a lane selection. 1e-4 of a second is the same
 * MOMENT_EPS the engine calls one moment, so a picked key and the keyframe it
 * came from always agree.
 */
export const keyframeKey = (channel: AnimChannel, t: number): string => `${channel}@${t.toFixed(4)}`
