// The math behind the gym filters (Strobe on the beat, RGB split, Cinematic bars).
//
// Pure: no GL, no DOM, no store. The resolver (render/resolve.ts) calls the strobe
// half to turn a beat list into one number per frame, and the registry and the
// Inspector call the bars half. Keeping it here is what lets a unit test pin the
// beat timing and the bar sizes without a browser, and what keeps the preview and
// the export from ever disagreeing: both are handed the SAME number by the SAME
// function.

/** A beat closer than this to the one before it is the same hit twice. */
export const MIN_BEAT_GAP_S = 0.2

/** The slack that lets a frame time like 0.49999999 land on the beat at 0.5. */
const BEAT_EPS_S = 1e-6

export interface StrobeSettings {
  /** Flash on every Nth beat. Rounded, at least 1. */
  everyN: number
  /** How long one flash takes to fade out, in milliseconds. */
  flashMs: number
  /** Beats per minute, used ONLY when no beats were found in the music. */
  bpm: number
  /** Seconds into the clip the first beat falls, for the BPM fallback. */
  firstBeatS: number
}

/** Index of the last entry at or before `t`, or -1. `arr` is sorted ascending. */
function lastAtOrBefore(arr: readonly number[], t: number): number {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/**
 * Seconds since the most recent beat that fires a flash, or null when none has
 * yet. `beats` are in SEQUENCE seconds; with none, the BPM grid is used instead,
 * counted from `firstBeatS` into the clip (`localT`).
 */
export function strobeAge(
  beats: readonly number[] | undefined,
  seqT: number,
  localT: number,
  s: StrobeSettings,
): number | null {
  const every = Math.max(1, Math.round(s.everyN))
  if (beats && beats.length > 0) {
    const i = lastAtOrBefore(beats, seqT + BEAT_EPS_S)
    if (i < 0) return null
    const j = i - (i % every)
    return Math.max(0, seqT - beats[j])
  }
  const bpm = Math.min(300, Math.max(30, s.bpm))
  const period = 60 / bpm
  const x = localT - s.firstBeatS
  if (x < -BEAT_EPS_S) return null
  const n = Math.floor((x + BEAT_EPS_S) / period)
  const j = n - (n % every)
  return Math.max(0, x - j * period)
}

/**
 * The flash at `age` seconds after its beat: 1 on the beat, falling to 0 over the
 * flash length (a squared ease-out, so it hits hard and clears fast).
 */
export function strobeEnvelope(age: number | null, flashMs: number): number {
  if (age === null) return 0
  const len = Math.max(0.01, flashMs / 1000)
  if (age >= len) return 0
  const k = 1 - age / len
  return k * k
}

/** The flash (0..1, before Strength) for one frame. */
export function strobeFlash(
  beats: readonly number[] | undefined,
  seqT: number,
  localT: number,
  s: StrobeSettings,
): number {
  return strobeEnvelope(strobeAge(beats, seqT, localT, s), s.flashMs)
}

/** One music clip's beats, as the beat cache holds them. */
export interface MusicBeats {
  startS: number
  inS: number
  outS: number
  speed: number
  /** Seconds from the clip's in point (what beatCache stores). */
  beats: readonly number[]
}

/**
 * Every music beat in SEQUENCE seconds, sorted, with hits closer than
 * MIN_BEAT_GAP_S merged. Time maps the way punchOnBeats maps it (start plus beat
 * over speed); a reversed clip walks its beats backward.
 */
export function beatGridFrom(clips: readonly MusicBeats[]): number[] {
  const all: number[] = []
  for (const c of clips) {
    const rate = Math.abs(c.speed) || 1
    const len = c.outS - c.inS
    for (const b of c.beats) {
      if (b < 0 || b > len) continue
      all.push(c.speed < 0 ? c.startS + (len - b) / rate : c.startS + b / rate)
    }
  }
  all.sort((a, b) => a - b)
  const out: number[] = []
  for (const t of all) if (out.length === 0 || t - out[out.length - 1] >= MIN_BEAT_GAP_S) out.push(t)
  return out
}

/** Offsets (in frame px, y down) the red and blue channels slide by: red +, blue -. */
export function rgbSplitOffsets(amountPx: number, angleDeg: number): { dx: number; dy: number } {
  const a = (angleDeg * Math.PI) / 180
  return { dx: amountPx * Math.cos(a), dy: amountPx * Math.sin(a) }
}

/**
 * How tall each black bar is, as a fraction of the frame height, so the picture
 * window left between them has the shape `ratio` (width over height) measured
 * against the frame's own width. 0 when the frame is already that wide or wider.
 * 2.39 on 1920x1080 is 0.128 (138 px a bar); on the tall 1080x1920 it is 0.382.
 */
export function barFractionForRatio(ratio: number, width: number, height: number): number {
  if (!(ratio > 0) || !(width > 0) || !(height > 0)) return 0
  const windowH = width / ratio
  return Math.min(0.5, Math.max(0, (1 - windowH / height) / 2))
}

/** The bars' size in frame pixels for a fraction of the frame height. */
export const barPixels = (fraction: number, height: number): number => Math.round(fraction * height)

/** The quick picks on Cinematic bars, widest first. */
export const BAR_RATIOS: readonly { label: string; ratio: number }[] = [
  { label: '2.39:1', ratio: 2.39 },
  { label: '2:1', ratio: 2 },
  { label: '1.85:1', ratio: 1.85 },
]
