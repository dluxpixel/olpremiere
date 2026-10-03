// Time formatting + frame math shared by the transport, ruler, and inspector.
//
// ⛔ HE READS TIME LIKE A STOPWATCH, 2026-10-03. His words, looking at a drag
// readout that said "00:00:03:29" and then "00:00:04:00": *"It says 3:29, and then
// it goes to 4:00. Of course, that's how milliseconds don't work."* The last group
// was FRAMES, which is how broadcast timecode counts, and nothing on screen said
// so. Asked, he picked seconds with hundredths: "0:03.97" then "0:04.00".
//
// Only the WORDS changed. Every time is still snapped to its frame before it is
// printed, so a cut, a trim and the playhead all land on whole frames exactly as
// before, and two neighbouring frames can never print the same thing: up to
// 100 fps a frame is longer than a hundredth, and above that the clock shows
// thousandths instead.

const pad = (n: number): string => String(n).padStart(2, '0')

/** Places after the point that still give every frame its own reading. */
export const clockDecimals = (fps: number): number => (fps > 100 ? 3 : 2)

/**
 * Seconds as a clock: "m:ss.cc" under an hour, "h:mm:ss.cc" above it. Rounds to
 * the last place shown, in whole units, so 59.999 reads "1:00.00" and never
 * "0:59.100". `decimals` 0 drops the fraction ("1:05"). Negative clamps to zero.
 */
export function formatClock(seconds: number, decimals = 2): string {
  const scale = 10 ** decimals
  const units = Math.max(0, Math.round(seconds * scale))
  const whole = Math.floor(units / scale)
  const fraction = decimals > 0 ? `.${String(units % scale).padStart(decimals, '0')}` : ''
  const ss = whole % 60
  const mm = Math.floor(whole / 60) % 60
  const hh = Math.floor(whole / 3600)
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}${fraction}` : `${mm}:${pad(ss)}${fraction}`
}

/** A sequence time as he reads it: snapped to its frame, then "m:ss.cc". */
export function formatTimecode(tS: number, fps: number): string {
  const rate = fps > 0 ? fps : 30
  const frames = Math.max(0, Math.round(tS * rate))
  return formatClock(frames / rate, clockDecimals(rate))
}

/**
 * A signed change in time for the live drag readouts: "+0.43s", "-12.50s", and
 * "+1:05.20" once it passes a minute. Snapped to whole frames like every other
 * time, so the number is the distance the edit really moved. ASCII sign only.
 */
export function formatTimecodeDelta(deltaS: number, fps: number): string {
  const rate = fps > 0 ? fps : 30
  const sign = deltaS < 0 ? '-' : '+'
  const shown = Math.round(Math.abs(deltaS) * rate) / rate
  const decimals = clockDecimals(rate)
  const scale = 10 ** decimals
  const units = Math.round(shown * scale)
  if (units >= 60 * scale) return `${sign}${formatClock(shown, decimals)}`
  return `${sign}${Math.floor(units / scale)}.${String(units % scale).padStart(decimals, '0')}s`
}

/** A length of time, unsigned: "0.17s", "12.50s", "1:05.20". */
export const formatDuration = (spanS: number, fps: number): string => formatTimecodeDelta(Math.abs(spanS), fps).slice(1)

/**
 * Typed time → seconds, or null. Takes what the fields now show and what they
 * used to show, because his hands may still type either:
 *
 *   "3.97", "3,97", "3.97s"        plain seconds (a comma too: Czech keyboards)
 *   "0:03.97", "1:05"              m:ss, fraction optional
 *   "1:02:03.50"                   h:mm:ss
 *   "00:00:03:29"                  the old HH:MM:SS:FF, last group in FRAMES
 *
 * Two and three groups read as a clock now. They used to be the SS:FF and
 * MM:SS:FF shorthands, but "1:15" in a field that shows "1:15.00" can only mean a
 * minute and fifteen seconds. The full four group timecode is unambiguous, so it
 * keeps meaning exactly what it did. Callers snap the answer to a frame.
 */
export function parseTimecode(text: string, fps: number): number | null {
  const trimmed = text.trim().replace(/s$/i, '').trim()
  if (trimmed === '') return null
  const parts = trimmed.split(':').map((p) => p.trim())
  if (parts.length > 4) return null
  if (parts.length === 4) {
    if (parts.some((p) => !/^\d+$/.test(p))) return null
    const [hh, mm, ss, ff] = parts.map(Number) as [number, number, number, number]
    return hh * 3600 + mm * 60 + ss + ff / Math.max(1, Math.round(fps))
  }
  const last = parts[parts.length - 1]!
  const lead = parts.slice(0, -1)
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(last) || lead.some((p) => !/^\d+$/.test(p))) return null
  const seconds = Number(last.replace(',', '.'))
  const [hh, mm] = lead.length === 2 ? lead.map(Number) : [0, Number(lead[0] ?? 0)]
  return (hh ?? 0) * 3600 + (mm ?? 0) * 60 + seconds
}

export const timeToFrame = (tS: number, fps: number): number => Math.round(tS * fps)
export const frameToTime = (frame: number, fps: number): number => frame / fps
/** Quantize a time to the sequence frame grid. */
export const quantizeToFrame = (tS: number, fps: number): number => Math.round(tS * fps) / fps
