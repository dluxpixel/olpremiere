// Onset (beat/hit) detection for auto-punching: energy-flux peak picking over
// a mono PCM buffer. Deliberately simple — Shorts music beds and SFX hits have
// hard transients, and the output only seeds punch keyframes the editor can
// move. Pure: no WebAudio, no store.

export interface OnsetOptions {
  /** Two onsets closer than this merge into the first (seconds). */
  minGapS?: number
  /** Stop after this many onsets (keyframe soup guard). */
  maxOnsets?: number
  /** Peaks must exceed mean + k·std of the flux. */
  sensitivity?: number
}

const WINDOW_S = 0.02
const HOP_S = 0.01

/**
 * Times (seconds, relative to the buffer start) where the signal's energy
 * jumps — beats, hits, stingers. Steady tones and silence yield nothing.
 */
export function detectOnsets(
  mono: Float32Array,
  sampleRate: number,
  options: OnsetOptions = {},
): number[] {
  const minGapS = options.minGapS ?? 0.35
  const maxOnsets = options.maxOnsets ?? 24
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

  // Positive energy flux only — releases don't retrigger punches.
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

  const onsets: number[] = []
  for (let f = 1; f < frames - 1 && onsets.length < maxOnsets; f++) {
    if (flux[f] <= threshold) continue
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue // local peak only
    const t = f * HOP_S
    if (onsets.length > 0 && t - onsets[onsets.length - 1] < minGapS) continue
    onsets.push(t)
  }
  return onsets
}
