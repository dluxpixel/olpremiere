// PUT THE ACTION IN THE FRAME, not the middle of the picture.
//
// A 16:9 recording in a 9:16 Short keeps a hair over half its width and throws
// the rest away, and today that window sits dead centre because nothing knows
// any better.
//
// ⛔ MEASURED ON HIS OWN GAMEPLAY, 2026-08-22. The brightness weighted centre of
// frame to frame motion, sampled four times a second over four separate half
// minutes of his 44 clip source, sat at **0.405, 0.544, 0.506 and 0.567** across
// the width. So the middle is wrong by up to a sixth of the picture, and it is
// wrong by a DIFFERENT amount in every stretch, which is exactly what one number
// per clip captures and a fixed centre cannot.
//
// ⛔ AND IT IS A STATIC WINDOW ON PURPOSE, NOT A TRACKER. The same measurement
// says the centre moves about 0.05 of the width every quarter second, with worst
// cases of 0.38 and 0.82. A window that followed that would be seasick, and the
// smoothing needed to tame it is a second feature with its own arguments. One
// number for the clip needs no smoothing at all and cannot ever wobble.
//
// The renderer needs nothing new: `computeQuad` already fits the CROPPED source
// into the frame, and crop is four animatable channels. This file is only the
// arithmetic between one number he understands and the four the renderer wants,
// the same job `innerZoom.ts` does for the zoom field.

/** The four crop fractions the renderer reads, as taken off each edge. */
export interface CropBox {
  t: number
  r: number
  b: number
  l: number
}

export const NO_CROP: CropBox = { t: 0, r: 0, b: 0, l: 0 }

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * Crop a source to the output's shape, with the kept window centred on `at`.
 *
 * `at` is 0..1 along whichever axis is being cropped: across the width when the
 * source is wider than the output, down the height when it is taller. 0.5 is
 * what the app does today, so passing it must return the same picture the centre
 * crop already gives, which is what the tests pin.
 *
 * ⛔ THE WINDOW IS CLAMPED INSIDE THE PICTURE, NEVER SHRUNK TO REACH `at`. Asking
 * to centre on the far left edge slides the window until it touches that edge and
 * stops. The alternative, letting it run off and filling with nothing, would put
 * a black bar inside his footage, which is worse than being slightly off.
 */
export function cropToAspect(srcW: number, srcH: number, outAspect: number, at = 0.5): CropBox {
  if (!ok(srcW) || !ok(srcH) || !ok(outAspect)) return { ...NO_CROP }
  const srcAspect = srcW / srcH
  const centre = Number.isFinite(at) ? clamp01(at) : 0.5
  // Within a whisker of the same shape: crop nothing rather than a rounding sliver.
  if (Math.abs(srcAspect - outAspect) < 1e-6) return { ...NO_CROP }

  if (srcAspect > outAspect) {
    // Wider than it should be: take it off the sides.
    const keep = outAspect / srcAspect
    const l = clamp01(Math.min(Math.max(centre - keep / 2, 0), 1 - keep))
    return { t: 0, b: 0, l, r: clamp01(1 - keep - l) }
  }
  // Taller than it should be: take it off the top and bottom.
  const keep = srcAspect / outAspect
  const t = clamp01(Math.min(Math.max(centre - keep / 2, 0), 1 - keep))
  return { l: 0, r: 0, t, b: clamp01(1 - keep - t) }
}

/**
 * How far the kept window can travel, as a fraction of the source.
 *
 * Zero means the source is already the output's shape and centring on the action
 * can do nothing at all, which is worth SAYING rather than silently doing
 * nothing: on a 9:16 clip in a 9:16 Short there is no choice to make.
 */
export function framingRange(srcW: number, srcH: number, outAspect: number): number {
  if (!ok(srcW) || !ok(srcH) || !ok(outAspect)) return 0
  const srcAspect = srcW / srcH
  const keep = srcAspect > outAspect ? outAspect / srcAspect : srcAspect / outAspect
  return clamp01(1 - keep)
}

/**
 * One centre for a whole clip from a run of per sample centres.
 *
 * ⛔ THE MEDIAN, NOT THE MEAN, AND THAT IS THE WHOLE POINT. His measured worst
 * case single jump was 0.82 of the width: one muzzle flash at the far edge drags
 * a mean across the picture, and the framing of the entire clip is then decided
 * by one frame. A median cannot be moved by an outlier at all.
 *
 * Samples with no motion in them are already dropped by the caller, so an empty
 * run means a still clip, and a still clip has no action to centre on: 0.5 is the
 * honest answer there, not a guess.
 */
export function centreOfAction(samples: readonly number[]): number {
  const good = samples.filter((v) => typeof v === 'number' && Number.isFinite(v)).map(clamp01)
  if (good.length === 0) return 0.5
  const sorted = [...good].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
