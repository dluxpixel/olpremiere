import { formatClock, formatTimecodeDelta } from '../engine/timecode'

export const RULER_H = 28
export const HEADERS_W = 178
/** The header column on a phone: the track's name and nothing else. */
export const PHONE_HEADERS_W = 44
export const SNAP_PX = 8
/** Pointer travel below this is a click (move playhead), not a clip drag. */
export const CLICK_SLOP_PX = 4

/**
 * Signed gesture delta for the live drag readout: seconds with hundredths, e.g.
 * "+0.43s". It used to read "+00:00:13 / +13f", frames twice over, and he read
 * the frame group as hundredths (2026-10-03). formatTimecodeDelta has the rule.
 */
export const fmtDelta = (deltaS: number, fps: number): string => formatTimecodeDelta(deltaS, fps)
// The add-track button row lives at the bottom of the HEADERS column. The lanes
// column carries a spacer of the SAME height so both columns scroll to the same
// depth - otherwise, with many tracks, the buttons sit below the lanes' scroll
// range and become unreachable.
export const ADD_TRACK_ROW_H = 46

// ---------------------------------------------------------------------------
// Ruler

/**
 * ⛔ EVERY STEP IS A ROUND NUMBER OF SECONDS, NEVER A COUNT OF FRAMES, 2026-10-03.
 *
 * Zoomed all the way in, the old 0.1 s step printed the frame group: at 30 fps
 * that read "00:06:24", "00:06:27", "00:07:00", which looks like a clock that
 * skips, and is exactly what he sent a screenshot of. The labels are his
 * stopwatch now ("0:06.20", "0:06.30"), each step is a time a person would pick,
 * and the label is the tick's own time, not its nearest frame, so a step finer
 * than a frame can never print one reading twice.
 *
 * Each step carries how many parts its minor ticks cut it into, so the minors
 * land on round times too (a quarter second in fifths is 0.05 s, not 0.04).
 */
const MAJOR_STEPS: readonly (readonly [stepS: number, parts: number])[] = [
  [0.01, 5],
  [0.02, 4],
  [0.05, 5],
  [0.1, 5],
  [0.25, 5],
  [0.5, 5],
  [1, 4],
  [2, 4],
  [5, 5],
  [10, 5],
  [15, 3],
  [30, 6],
  [60, 4],
  [120, 4],
  [300, 5],
  [600, 5],
  [1800, 6],
  [3600, 4],
]

/** Closest a pair of labels may sit before "0:06.30" runs into "0:06.40". */
const MIN_MAJOR_PX = 70

export function tickSpecFor(pxPerS: number): { majorStepS: number; minorStepS: number; minorParts: number } {
  const [majorStepS, minorParts] = MAJOR_STEPS.find(([s]) => s * pxPerS >= MIN_MAJOR_PX) ?? MAJOR_STEPS[MAJOR_STEPS.length - 1]!
  return { majorStepS, minorStepS: majorStepS / minorParts, minorParts }
}

/** "0:06.30" between whole seconds, "0:06" on them; "1:02:05" past an hour. */
export function rulerLabel(tS: number, majorStepS: number): string {
  return formatClock(tS, majorStepS < 1 ? 2 : 0)
}
