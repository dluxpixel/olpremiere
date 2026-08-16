// Zoom INSIDE the picture, without the picture growing.
//
// His ask, 2026-08-16: *"zooms only inside of the picture... the blur down there
// literally doesn't change... it doesn't change the blur size."*
//
// Scaling a clip grows its rectangle, so on a 9:16 short a zoom eats into the
// blurred bands and the framing changes. What he wants is the footage magnified
// while its rectangle stays exactly where it is.
//
// ⛔ THAT IS A SYMMETRIC CROP, AND THE RENDERER ALREADY DOES IT. `computeQuad`
// fits the CROPPED source into the frame, so cropping an equal fraction off
// every edge shrinks the source and the contain-fit grows it straight back to
// the same rectangle. The picture does not move, the content magnifies, and the
// backdrop never notices because `blurBackdropOp` drops the crop entirely.
//
// So this file is only the arithmetic between one number he understands and the
// four the renderer wants.

/** The zoom field's own envelope. 1 is untouched; 4 is a hard magnification. */
export const INNER_ZOOM = { min: 1, max: 4, step: 0.01, sens: 0.005 } as const

/** Equal fractions off every edge preserve the aspect, so the box cannot skew. */
export function cropForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 1) return 0
  const z = Math.min(zoom, INNER_ZOOM.max)
  // Keep 1/z of each axis, centred: half the loss comes off each side.
  return (1 - 1 / z) / 2
}

/**
 * Read the zoom back out of a pair of opposite crops.
 *
 * Uses the pair rather than all four because the two axes agree by construction
 * whenever the zoom wrote them. Hand-cropped asymmetric clips are the case this
 * cannot describe, and it says 1 for them rather than inventing a number.
 */
export function zoomFromCrop(cropA: number, cropB: number): number {
  const kept = 1 - (cropA + cropB)
  if (kept <= 0) return INNER_ZOOM.max
  const z = 1 / kept
  if (!Number.isFinite(z)) return 1
  return Math.min(Math.max(z, INNER_ZOOM.min), INNER_ZOOM.max)
}

/** True when the four crops are the symmetric shape this zoom writes. */
export function isSymmetricCrop(t: number, r: number, b: number, l: number): boolean {
  const eps = 1e-6
  return Math.abs(t - b) < eps && Math.abs(r - l) < eps && Math.abs(t - r) < eps
}
