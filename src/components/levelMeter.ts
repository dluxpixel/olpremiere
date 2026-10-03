// The recording studio's input meter, as numbers: the scale, the zones and the
// ballistics. RecordingStudio draws it; this decides what it shows.
//
// ⛔ MIC-3, 2026-09-30. The old bar was `peak^0.6 * 118` percent: full at -2.4
// dBFS, always green, no scale, no hold, no clip light. His mic gain is the only
// thing between his voice and full scale (the capture is raw, auto gain off on
// purpose), and 5 of his 65 takes touched it with the bar looking the same as a
// good take. So it reads in dBFS now, like every meter he will have seen:
// -60 to 0, marks at -18, -12, -6 and 0, green under -12, amber to -3, red above.

/** The bottom of the scale. Quieter than this is just "on". */
export const METER_FLOOR_DB = -60
/** Where the marks go. -18 to -12 is where a voice take wants to peak. */
export const METER_TICKS_DB = [-18, -12, -6, 0] as const
/** Amber from here: getting hot. */
export const METER_AMBER_DB = -12
/** Red from here: too hot, the clip light is a breath away. */
export const METER_RED_DB = -3
/** How long the peak line holds before it lets go. */
export const PEAK_HOLD_MS = 1500
/** How fast the bar falls back after a peak, so it can be read at all. */
export const METER_FALL_DB_PER_S = 20

/** Linear amplitude to dBFS. Silence is -Infinity. */
export const ampToDb = (amp: number): number => (amp > 0 ? 20 * Math.log10(amp) : -Infinity)

/** dBFS to a 0..1 position on the -60..0 scale. */
export function dbToFrac(db: number): number {
  if (!(db > METER_FLOOR_DB)) return 0
  return Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)
}

/**
 * The zones, as the fill the bar reveals: green, amber, red, with hard edges at
 * -12 and -3 so the colour under the bar's tip IS the zone it is in. The app's
 * own signal colours, the same three the master meter uses.
 */
export function meterGradient(): string {
  const amber = `${dbToFrac(METER_AMBER_DB) * 100}%`
  const red = `${dbToFrac(METER_RED_DB) * 100}%`
  return (
    'linear-gradient(to right, ' +
    `var(--color-success) 0%, var(--color-success) ${amber}, ` +
    `var(--color-warning) ${amber}, var(--color-warning) ${red}, ` +
    `var(--color-danger) ${red}, var(--color-danger) 100%)`
  )
}

export interface MeterState {
  /** Where the bar's tip is, dBFS. */
  barDb: number
  /** Where the peak line is, dBFS. */
  holdDb: number
  /** When the peak line last rose. */
  holdAtMs: number
  /** When this state was computed. */
  atMs: number
}

export const METER_IDLE: MeterState = { barDb: -Infinity, holdDb: -Infinity, holdAtMs: 0, atMs: 0 }

/**
 * One frame of the meter. `peak` is the input's peak since the last frame
 * (linear), so a transient between frames is in it. The bar jumps up to a peak
 * at once and falls back at 20 dB a second; the line holds the highest peak for
 * 1.5 s and then drops to wherever the bar is.
 */
export function stepMeter(prev: MeterState, peak: number, nowMs: number): MeterState {
  const db = ampToDb(peak)
  const dt = Math.max(0, (nowMs - prev.atMs) / 1000)
  const fallen = prev.barDb - METER_FALL_DB_PER_S * dt
  const barDb = Math.max(db, fallen < METER_FLOOR_DB ? -Infinity : fallen)
  if (db >= prev.holdDb) return { barDb, holdDb: db, holdAtMs: nowMs, atMs: nowMs }
  if (nowMs - prev.holdAtMs > PEAK_HOLD_MS) return { barDb, holdDb: barDb, holdAtMs: nowMs, atMs: nowMs }
  return { barDb, holdDb: prev.holdDb, holdAtMs: prev.holdAtMs, atMs: nowMs }
}
