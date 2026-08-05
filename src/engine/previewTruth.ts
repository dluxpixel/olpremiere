// What the preview ACTUALLY put on screen, measured rather than assumed.
//
// THE LIE THIS FILE EXISTS TO KILL
//
// The playing path draws a pooled <video> element and steers it toward the
// playhead by comparing `el.currentTime` against the wanted source time.
// `el.currentTime` is the element's playback POSITION. It is not the timestamp
// of the frame the compositor actually sampled: the element runs its own decode
// and presentation pipeline, so the picture on screen lags its own clock by an
// amount nothing in this app controls or can see. Steering a servo on it means
// correcting against a number that is not the picture, which is why the drift
// felt random: sometimes the two agreed and sometimes they did not.
//
// `requestVideoFrameCallback` reports the truth. Its `mediaTime` is the
// presentation timestamp of the frame that was just composited, and its
// `presentedFrames` counter is how many frames the element has actually shown.
// Both are facts about the picture, not about the element's intent.
//
// Everything here is passive. Attaching a probe changes no playback behaviour;
// it only records what happened, so a before/after measurement compares the
// same instrument against itself.

/** One element's live frame identity, refreshed on every presented frame. */
export interface FrameProbe {
  /** Presentation timestamp of the frame currently on screen, in source seconds. */
  mediaTime: number
  /** Total frames this element has presented (browser counter, monotonic). */
  presentedFrames: number
  /** performance.now() when that frame was reported. */
  at: number
  /** False until the first frame has been presented; mediaTime is meaningless before it. */
  live: boolean
  /** Stops the self-rescheduling callback. */
  stop: () => void
}

interface RvfcMetadata {
  mediaTime: number
  presentedFrames: number
}
type RvfcHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: RvfcMetadata) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/** True when this engine reports real frame identity. Chromium and Safari do; Firefox does not. */
export const hasFrameIdentity = (): boolean =>
  typeof HTMLVideoElement !== 'undefined' &&
  typeof (HTMLVideoElement.prototype as RvfcHost).requestVideoFrameCallback === 'function'

/**
 * Start reporting which frame this element is actually showing.
 *
 * Self-rescheduling: rVFC fires once per PRESENTED frame, so re-arming inside
 * the callback tracks the element for as long as it is drawing and costs
 * nothing while it is paused (a paused element presents no frames, so the
 * callback simply does not fire).
 *
 * Where rVFC does not exist the probe stays `live: false` forever and every
 * caller falls back to the old `currentTime` behaviour, byte for byte.
 */
export function attachFrameProbe(el: HTMLVideoElement): FrameProbe {
  const host = el as RvfcHost
  const probe: FrameProbe = {
    mediaTime: 0,
    presentedFrames: 0,
    at: 0,
    live: false,
    stop: () => {},
  }
  if (typeof host.requestVideoFrameCallback !== 'function') return probe

  let handle: number | null = null
  let stopped = false
  const tick = (_now: number, meta: RvfcMetadata): void => {
    if (stopped) return
    probe.mediaTime = meta.mediaTime
    probe.presentedFrames = meta.presentedFrames
    probe.at = performance.now()
    probe.live = true
    handle = host.requestVideoFrameCallback?.(tick) ?? null
  }
  handle = host.requestVideoFrameCallback(tick)
  probe.stop = () => {
    stopped = true
    if (handle !== null) host.cancelVideoFrameCallback?.(handle)
    handle = null
    probe.live = false
  }
  return probe
}

// ---------------------------------------------------------------------------
// Rolling health, shared by the on-screen indicator and the measurement harness
//
// One mechanism, two readers. The badge that tells him the preview is dropping
// frames and the harness that proves a change helped read the SAME numbers, so
// the thing he sees can never disagree with the thing that was measured.

/** Samples kept for the rolling window. 600 at 60fps is the last ten seconds. */
const WINDOW = 600

interface Sample {
  /** performance.now() at the draw. */
  at: number
  /** How far the SERVED picture was from the wanted frame, in seconds. Signed: >0 = ahead. */
  errS: number
  /** True when the served picture was the exact wanted frame. */
  exact: boolean
}

const samples: Sample[] = []

export interface PreviewHealth {
  /** Samples in the window. Zero means nothing has played yet. */
  count: number
  /** Median absolute picture-vs-playhead error, in milliseconds. */
  medianErrMs: number
  /** 95th percentile absolute error, in milliseconds. The number that gets felt. */
  p95ErrMs: number
  /** Worst absolute error in the window, in milliseconds. */
  worstErrMs: number
  /** Signed mean error: >0 means the picture consistently runs ahead of the playhead. */
  biasMs: number
  /** Share of drawn frames that were NOT the frame asked for, as a ratio 0..1. */
  wrongRatio: number
  /** Seconds of wall clock the window covers. */
  spanS: number
}

const EMPTY: PreviewHealth = {
  count: 0,
  medianErrMs: 0,
  p95ErrMs: 0,
  worstErrMs: 0,
  biasMs: 0,
  wrongRatio: 0,
  spanS: 0,
}

/**
 * Record what the preview ACTUALLY PUT ON SCREEN for one drawn video layer.
 *
 * It must be called with the error of the source that was really used, not of
 * the pooled element: once the exact decoded frame can be served in the
 * element's place, the element's own error stops describing the picture. An
 * earlier version of this file recorded the element unconditionally and
 * reported a change that fixed the picture as a change that made it three times
 * worse, which is precisely the kind of green-but-dead number this file exists
 * to prevent.
 */
export function recordServedFrame(errS: number, exact: boolean): void {
  samples.push({ at: performance.now(), errS: exact ? 0 : errS, exact })
  if (samples.length > WINDOW) samples.splice(0, samples.length - WINDOW)
}

/** Forget the window. Called on play/pause: stale samples describe a different run. */
export function resetPreviewHealth(): void {
  samples.length = 0
}

/** Rolling health over the last `withinMs` of wall clock. Never throws, never allocates much. */
export function previewHealth(withinMs = 2000): PreviewHealth {
  if (samples.length === 0) return EMPTY
  const cutoff = performance.now() - withinMs
  const win = samples.filter((s) => s.at >= cutoff)
  if (win.length === 0) return EMPTY
  const errs = win.map((s) => Math.abs(s.errS) * 1000).sort((a, b) => a - b)
  const pick = (q: number): number => errs[Math.min(errs.length - 1, Math.floor(errs.length * q))] ?? 0
  let wrong = 0
  let bias = 0
  for (const s of win) {
    if (!s.exact) wrong++
    bias += s.errS
  }
  return {
    count: win.length,
    medianErrMs: Math.round(pick(0.5)),
    p95ErrMs: Math.round(pick(0.95)),
    worstErrMs: Math.round(errs[errs.length - 1] ?? 0),
    biasMs: Math.round((bias / win.length) * 1000),
    wrongRatio: wrong / win.length,
    spanS: Math.round((win[win.length - 1]!.at - win[0]!.at)) / 1000,
  }
}

// The measurement harness (_verify/preview-truth.mjs) reads the SAME numbers the
// on-screen indicator does, so the thing he sees can never disagree with the
// thing that was measured. Read-only: there is no setter here, and nothing in
// the app reads it back.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __previewHealth?: (withinMs?: number) => PreviewHealth }).__previewHealth =
    previewHealth
}
