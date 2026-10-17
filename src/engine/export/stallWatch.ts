// AN EXPORT THAT STOPS MOVING ENDS, IT NEVER HANGS (2026-10-17).
//
// Why this exists: on 2026-10-15 an export of "How to get a back" started at 16:01 and never ended.
// The usage log holds no outcome for it (not done, not cancelled, not failed), the app was alive
// for four more hours, and an ffmpeg had been seen sitting on 1.5 GB with nothing to do. Nothing in
// the export could notice: ffmpeg's stdin is a pipe, main waits for it to drain, the page waits for
// main, the render worker waits for the page, and every one of those waits has no end. A frame that
// stops being taken by ffmpeg, a read back from the graphics card that never returns, or a decoder
// that never answers left the dialog on a percentage for good, with a live ffmpeg holding the file.
//
// This is the one place that notices. Any sign of life (a frame from the worker, a frame taken by
// ffmpeg, ffmpeg's own progress line) calls poke(). If none comes for the limit, onStall runs once
// and the export is ended with a plain message, the way any other failure ends it.
//
// THE LIMITS ARE GENEROUS ON PURPOSE. A wrongly stopped export is worse than a slow one:
//   - while frames are flowing, 2 minutes with nothing at all. Even his slow export that day made a
//     frame about every second, so this is a hang, never a busy machine.
//   - before the first frame (the worker is opening every file) and after the last one (ffmpeg is
//     finishing the file), 5 times that, because those steps have no frame to show for themselves.
//   - a tick that arrives much later than it should (the laptop slept, the page was frozen) does
//     not count against the export: nothing was measuring.
//   - a stall must be seen on two ticks in a row with no sign of life in between, so a page that
//     was busy and has its queued messages still to deliver never fails an export that is fine.
//
// Pure: the clock and the timer are passed in, so the tests run in no time at all.

/** The message he sees. Plain words that start with a capital and say nothing machine, so
 *  plainExportError (plainError.ts) shows it exactly as it is. Nothing is left behind: main's
 *  cancel deletes the half written file. */
export const STALLED_MESSAGE = 'The export stopped making progress, so it was ended and nothing was saved. Try again.'

/** No sign of life for this long while frames are flowing counts as a stall. */
const RUN_MS = 120_000
/** The same, before the first frame and after the last one. */
const SLOW_FACTOR = 5
/** How often the watch looks. */
const TICK_MS = 5_000
/** A tick later than this found nothing to compare with (asleep, frozen): start the count again. */
const FROZEN_MS = 90_000

let runMs = RUN_MS

/**
 * The limit while frames are flowing, in milliseconds. A seam for the desktop end to end check
 * (e2e/export-shapes.spec.ts), which cannot wait two minutes for a frozen ffmpeg. It is not a
 * setting: nothing in the app calls it, and null puts the real limit back.
 */
export function setStallLimitMs(ms: number | null): void {
  runMs = ms !== null && Number.isFinite(ms) && ms > 0 ? ms : RUN_MS
}

/** The limits in force: while frames flow, around them (first and last), and how often to look. */
export function stallLimits(): { runMs: number; slowMs: number; tickMs: number } {
  return { runMs, slowMs: runMs * SLOW_FACTOR, tickMs: Math.min(TICK_MS, Math.max(100, Math.floor(runMs / 4))) }
}

export interface StallWatch {
  /** A sign of life: frames still move. */
  poke(): void
  /** One look. The timer calls it; the tests call it with a clock they move by hand. */
  check(): void
  /** Stop looking for good. Safe to call more than once. */
  stop(): void
}

export interface StallWatchOptions {
  /** The limit right now, asked at every look so it can change with the phase of the export. */
  limitMs: () => number
  /** Called at most once, with how long it has been quiet. */
  onStall: (quietMs: number) => void
  /** How often to look. */
  tickMs?: number
  /** A look later than this after the last one is not counted (the machine was asleep or frozen). */
  frozenMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

export function startStallWatch(opts: StallWatchOptions): StallWatch {
  const now = opts.now ?? Date.now
  const frozenMs = opts.frozenMs ?? FROZEN_MS
  let lastPoke = now()
  let lastLook = lastPoke
  let suspect = false
  let stopped = false
  const timer: { id?: unknown } = {}

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer.id !== undefined) (opts.clearTimer ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>)))(timer.id)
  }
  const poke = (): void => {
    if (stopped) return
    lastPoke = now()
    suspect = false
  }
  const check = (): void => {
    if (stopped) return
    const t = now()
    const since = t - lastLook
    lastLook = t
    if (since > frozenMs) {
      lastPoke = t
      suspect = false
      return
    }
    const quiet = t - lastPoke
    if (quiet <= opts.limitMs()) {
      suspect = false
      return
    }
    // First sighting: wait one more look, so anything queued behind a busy page is delivered first.
    if (!suspect) {
      suspect = true
      return
    }
    stop()
    opts.onStall(quiet)
  }

  const tickMs = opts.tickMs ?? TICK_MS
  timer.id = (opts.setTimer ?? ((fn, ms) => setInterval(fn, ms)))(check, tickMs)
  return { poke, check, stop }
}
