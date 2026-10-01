// Which source frame belongs to a moment in time. ONE rule, shared by the
// paused preview (frameCache.ts) and the export (exportWorker.ts), so the two
// cannot pick different frames: preview == export is a promise this app makes.
//
// Pure on purpose, with no DOM and no mediabunny, so the export worker can
// import it and the tests can run it.

/** The frame rate assumed for a source whose own rate could not be read. */
export const FALLBACK_FPS = 30

/**
 * The frame slot `tS` falls in at the asset's fps (fallback 30): the NEAREST
 * frame, not the last one that started.
 *
 * ⛔ IT WAS THE LAST ONE THAT STARTED (a floor), and that put the picture
 * behind the sound on every cut whose in point is off the frame grid, which is
 * most of his: GYM's iPhone cuts start at 17.46497 s, 35.23163 s, 68.961 s.
 * Measured on the phone's real frame times: the picture averaged 24.1 ms late
 * on his seven GYM cuts (17 to 28 ms each, up to 33 ms), and always late, never
 * early. The nearest frame is never more than half a frame either way: 7.0 ms
 * on the same cuts.
 *
 * Slots are centred on the frames, so a frame whose time is a tick off the
 * grid (his iPhone clips have a handful, 1.67 ms each) still lands in its own
 * slot. Under the floor, an early one fell into the slot before it.
 *
 * The epsilon (a millionth of a frame) settles an exact half way the same way
 * every time, towards the earlier frame.
 */
export function frameIndexAt(tS: number, fps: number | undefined): number {
  const f = fps && fps > 0 ? fps : FALLBACK_FPS
  return Math.max(0, Math.floor(tS * f + 0.5 - 1e-6))
}

/**
 * Has a sequential reader got far enough? True while the frame starting at
 * `frameS` is at or before the frame `frameIndexAt` picks for `sourceT`. The
 * export's pull-down advances while this holds and shows the last frame it
 * reached, so it lands on exactly the frame the preview's cache files under
 * the same slot.
 */
export function frameReached(frameS: number, sourceT: number, fps: number | undefined): boolean {
  return frameIndexAt(frameS, fps) <= frameIndexAt(sourceT, fps)
}
