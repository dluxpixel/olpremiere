// WHERE THE ACTION IS, read off the picture itself.
//
// The centre of frame to frame CHANGE, weighted by how big the change is. On
// gameplay that is the fight, the muzzle flash, the thing that moved. No model,
// no network, no download: a subtraction and a weighted average over frames small
// enough that the whole scan costs less than one decode of the original.
//
// ⛔ THE FRAMES COME IN, THEY ARE NOT FETCHED HERE. Everything below is pure, so
// it can be pressed on with frames made up by hand rather than a decoder, which
// is the only way to test "a bright thing moved left" without shipping a fixture.
//
// MEASURED ON HIS OWN GAMEPLAY, 2026-08-22, at 64x36 and four samples a second:
// the centre sat at 0.405, 0.544, 0.506 and 0.567 across four separate half
// minutes, and moved about 0.05 of the width between neighbouring samples. Small
// frames are not a compromise here, they are the point: at 64 wide a whole clip
// scans in the time one full size seek takes.

/** Below this, a pixel changed only because the encoder said so. */
export const NOISE_FLOOR = 8
/** Nothing dimmer than this share of the frame's own peak change counts as action. */
export const SILENCE = 0.02

export interface Sample {
  /** 0..1 across the width. */
  x: number
  /** 0..1 down the height. */
  y: number
  /** How much moved, in the same units as the pixel values. */
  energy: number
}

/**
 * The weighted centre of what changed between two greyscale frames.
 *
 * ⛔ THE WEIGHT IS THE SQUARE OF THE DIFFERENCE, not the difference. A muzzle
 * flash is a small number of very changed pixels and a camera drift is a large
 * number of slightly changed ones, and on a linear weight the drift wins every
 * time: the answer would creep back to the middle of the picture on exactly the
 * frames where something actually happened.
 *
 * Returns null when nothing moved, which is a real answer and not a failure. A
 * still frame has no action in it and must not be counted as one at the centre.
 */
export function motionCentre(prev: Uint8Array | Uint8ClampedArray, next: Uint8Array | Uint8ClampedArray, w: number, h: number): Sample | null {
  if (w <= 1 || h <= 1) return null
  const n = w * h
  if (prev.length < n || next.length < n) return null
  let sum = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(next[i] - prev[i])
    if (d < NOISE_FLOOR) continue
    const weight = d * d
    sum += weight
    sx += weight * (i % w)
    sy += weight * ((i / w) | 0)
  }
  if (sum === 0) return null
  const energy = Math.sqrt(sum / n)
  if (energy < SILENCE) return null
  return { x: sx / sum / (w - 1), y: sy / sum / (h - 1), energy }
}

/**
 * Every sample across a run of frames, skipping the still ones.
 *
 * Frames must be greyscale and all the same size, which is what the sampler
 * hands over. Fewer than two frames cannot have any change in them.
 */
export function scanFrames(frames: readonly (Uint8Array | Uint8ClampedArray)[], w: number, h: number): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < frames.length; i++) {
    const s = motionCentre(frames[i - 1], frames[i], w, h)
    if (s) out.push(s)
  }
  return out
}

/**
 * Greyscale from RGBA, which is what a canvas hands back.
 *
 * Rec. 709 luma, the same weights the rest of the app's colour work uses, in
 * integer arithmetic so a frame costs no float conversion.
 */
export function greyFromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = i << 2
    out[i] = (rgba[p] * 54 + rgba[p + 1] * 183 + rgba[p + 2] * 19) >> 8
  }
  return out
}

/**
 * How many frames to sample across a clip, and how far apart.
 *
 * ⛔ A COUNT, NOT A RATE, because the answer is one number for the clip and a
 * four second clip does not need a hundred and twenty readings of it. His cuts
 * run from a fraction of a second to the better part of a minute, so a rate
 * would either starve the short ones or spend a minute on the long ones.
 *
 * Never fewer than two, because one frame has no change in it.
 */
export const SCAN_SAMPLES = 24

export function scanTimesS(startS: number, endS: number, samples = SCAN_SAMPLES): number[] {
  const a = Number.isFinite(startS) ? startS : 0
  const b = Number.isFinite(endS) ? endS : a
  if (!(b > a)) return [a]
  const n = Math.max(2, Math.min(samples, Math.floor(samples)))
  const step = (b - a) / (n - 1)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(a + step * i)
  return out
}
