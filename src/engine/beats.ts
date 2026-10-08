// Onset (beat/hit) detection for auto-punching: energy-flux peak picking over
// a mono PCM buffer. Deliberately simple: Shorts music beds and SFX hits have
// hard transients, and the output only seeds punch keyframes the editor can
// move. Pure: no WebAudio, no store.

export interface OnsetOptions {
  /** Two onsets closer than this merge into the first (seconds). */
  minGapS?: number
  /**
   * At most this many onsets (keyframe soup guard). When there are more, the
   * strongest are kept, spread across the whole buffer (see spreadStrongest).
   */
  maxOnsets?: number
  /** Peaks must exceed mean + k·std of the flux. */
  sensitivity?: number
}

const WINDOW_S = 0.02
const HOP_S = 0.01

/** One onset and how hard it hit (its energy flux). */
export interface Onset {
  t: number
  strength: number
}

/**
 * Times (seconds, relative to the buffer start) where the signal's energy
 * jumps (beats, hits, stingers). Steady tones and silence yield nothing.
 */
export function detectOnsets(
  mono: Float32Array,
  sampleRate: number,
  options: OnsetOptions = {},
): number[] {
  const all = detectAllOnsets(mono, sampleRate, options)
  const durS = sampleRate > 0 ? mono.length / sampleRate : 0
  return spreadStrongest(all, options.maxOnsets ?? 24, durS).map((o) => o.t)
}

/**
 * Keep at most `max` onsets, the strongest in each stretch of the clip.
 *
 * ⛔ THE CAP USED TO KEEP THE FIRST ONES IN TIME AND STOP. On steady music every
 * punch landed in the first quarter of the clip (16 punches, the last at 15 s
 * of a 60 s clip) and the rest of the Short got none, while the toast said it
 * had punched the beats. Now the clip is cut into `max` equal stretches and the
 * hardest hit in each is kept, so the punches cover the whole clip and land on
 * the loud beats; stretches with no hit hand their place to the next hardest.
 */
export function spreadStrongest(onsets: readonly Onset[], max: number, durS: number): Onset[] {
  if (onsets.length <= max) return [...onsets]
  if (max <= 0) return []
  const span = durS > 0 ? durS : (onsets[onsets.length - 1]?.t ?? 0) + 1e-6
  const best = new Map<number, Onset>()
  for (const o of onsets) {
    const bin = Math.min(max - 1, Math.floor((o.t / span) * max))
    const cur = best.get(bin)
    if (!cur || o.strength > cur.strength) best.set(bin, o)
  }
  const kept = new Set(best.values())
  const rest = onsets.filter((o) => !kept.has(o)).sort((a, b) => b.strength - a.strength)
  for (const o of rest) {
    if (kept.size >= max) break
    kept.add(o)
  }
  return [...kept].sort((a, b) => a.t - b.t)
}

/** Every onset that passes the threshold and the gap rule, in time order, with no cap. */
export function detectAllOnsets(mono: Float32Array, sampleRate: number, options: OnsetOptions = {}): Onset[] {
  const minGapS = options.minGapS ?? 0.35
  const k = options.sensitivity ?? 1.5
  const win = Math.max(8, Math.round(WINDOW_S * sampleRate))
  const hop = Math.max(4, Math.round(HOP_S * sampleRate))
  if (mono.length < win * 2 || sampleRate <= 0) return []

  const frames = Math.floor((mono.length - win) / hop) + 1
  const energy = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const off = f * hop
    for (let i = 0; i < win; i++) sum += mono[off + i] * mono[off + i]
    energy[f] = Math.sqrt(sum / win)
  }

  // Positive energy flux only, so releases don't retrigger punches.
  const flux = new Float64Array(frames)
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1])

  let mean = 0
  let maxEnergy = 0
  for (let f = 0; f < frames; f++) {
    mean += flux[f]
    if (energy[f] > maxEnergy) maxEnergy = energy[f]
  }
  mean /= frames
  let variance = 0
  for (let f = 0; f < frames; f++) variance += (flux[f] - mean) ** 2
  // The statistical gate alone lets a steady tone's tiny RMS ripple through
  // (all-small flux → tiny std). A real hit jumps by a meaningful fraction of
  // the loudest moment, so the absolute floor rides on peak energy.
  const threshold = Math.max(mean + k * Math.sqrt(variance / frames), 0.08 * maxEnergy)
  if (threshold <= 1e-9) return [] // silence

  const onsets: Onset[] = []
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] <= threshold) continue
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue // local peak only
    const t = f * HOP_S
    if (onsets.length > 0 && t - onsets[onsets.length - 1]!.t < minGapS) continue
    onsets.push({ t, strength: flux[f] })
  }
  return onsets
}
