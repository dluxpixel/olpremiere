import { formatTimecode } from '../engine/timecode'

export const RULER_H = 28
export const HEADERS_W = 178
export const SNAP_PX = 8
/** Pointer travel below this is a click (move playhead), not a clip drag. */
export const CLICK_SLOP_PX = 4

/**
 * Signed gesture delta for the live drag readout: compact timecode plus total
 * frames, e.g. "+00:00:12 / +14f". ASCII sign only. The hours group is dropped
 * (deltas that long do not happen in hand edits) so the tip stays glanceable.
 */
export const fmtDelta = (deltaS: number, fps: number): string => {
  const fpsInt = Math.max(1, Math.round(fps))
  const frames = Math.round(Math.abs(deltaS) * fpsInt)
  const sign = deltaS < 0 ? '-' : '+'
  const tc = formatTimecode(Math.abs(deltaS), fps)
  const shown = tc.startsWith('00:') ? tc.slice(3) : tc
  return `${sign}${shown} / ${sign}${frames}f`
}
// The add-track button row lives at the bottom of the HEADERS column. The lanes
// column carries a spacer of the SAME height so both columns scroll to the same
// depth - otherwise, with many tracks, the buttons sit below the lanes' scroll
// range and become unreachable.
export const ADD_TRACK_ROW_H = 46

// ---------------------------------------------------------------------------
// Ruler

const MAJOR_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

export function tickSpecFor(pxPerS: number): { majorStepS: number; minorStepS: number } {
  const majorStepS = MAJOR_STEPS_S.find((s) => s * pxPerS >= 70) ?? 600
  return { majorStepS, minorStepS: majorStepS / 5 }
}

export function rulerLabel(tS: number, fps: number, majorStepS: number): string {
  if (majorStepS < 1) return formatTimecode(tS, fps).slice(3)
  const total = Math.round(tS)
  const ss = total % 60
  const mm = Math.floor(total / 60) % 60
  const hh = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}
