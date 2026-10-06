// How long the export has left, from how fast it is going NOW.
//
// ⛔ IT USED TO DIVIDE BY THE TIME SINCE HE PRESSED EXPORT. That clock includes the media check, the
// sound mix, the Windows save dialog he types a name into, and the seconds ffmpeg needs before it
// reports its first frame. Ten seconds naming the file plus three of sound plus five of ffmpeg made
// the first estimate on a 1350 frame Short about 100 minutes, and every later one too high (export
// audit, 2026-10-06). So the rate comes from the last few seconds of frames only. Pure.

export interface ProgressSample {
  /** performance.now() when ffmpeg (or the worker) reported it. */
  t: number
  frames: number
}

/** Seconds of recent progress the rate is read from. */
export const RATE_WINDOW_S = 10

/**
 * Add a progress point. Points older than three windows go, and a count that went DOWN (the browser
 * export's software retry starts again at 0) starts the record over.
 */
export function addSample(samples: ProgressSample[], next: ProgressSample): ProgressSample[] {
  const last = samples[samples.length - 1]
  if (last && next.frames < last.frames) return [next]
  return [...samples.filter((s) => next.t - s.t <= RATE_WINDOW_S * 3000), next]
}

/** Seconds left at the recent rate, or NaN while that rate is not known yet. */
export function timeLeftS(samples: ProgressSample[], framesTotal: number): number {
  // ffmpeg says frame=0 until its first frame is out, which is not a rate.
  const moving = samples.filter((s) => s.frames > 0)
  if (moving.length < 2) return NaN
  const last = moving[moving.length - 1]
  const first = moving.find((s) => last.t - s.t <= RATE_WINDOW_S * 1000) ?? last
  const spanS = (last.t - first.t) / 1000
  if (spanS < 1 || last.frames <= first.frames) return NaN
  const fps = (last.frames - first.frames) / spanS
  return Math.max(0, (framesTotal - last.frames) / fps)
}

/** The time left in plain words: "About 2 min left". Empty while it is not known. */
export function timeLeftWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 10) return 'Almost done'
  if (seconds < 60) return `About ${Math.max(10, Math.round(seconds / 10) * 10)} seconds left`
  return `About ${Math.round(seconds / 60)} min left`
}
