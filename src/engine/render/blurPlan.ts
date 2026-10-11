// How wide a blur is drawn: pure, no GL.
//
// The blur shader (BLUR_FS in glRenderer.ts) takes at most MAX_BLUR_TAP_RADIUS taps
// each side of a pixel, which is a hard limit on ONE pass. A look's halation and
// bloom are written as a fraction of the frame's short side, so on a 4K frame
// (short side 2160) Golden Hour's bloom wants 76 px and one pass can only give 64:
// the glow came out about 15% smaller there than on a 1080 frame, and the same look
// no longer looked the same at the two sizes.
//
// A gaussian blur is the sum of its parts: two passes of sigma s give sigma s times
// root two, N passes give s times root N. So a radius past the limit is drawn as N
// passes of radius / root N, each inside the limit, and the glow is the same size
// against the frame at any raster. At or below the limit the plan is ONE pass at the
// radius asked for, exactly what the renderer drew before, so no existing frame
// changes by a byte.

/** The widest a single pass reaches, in taps each side. Matches BLUR_FS. */
export const MAX_BLUR_TAP_RADIUS = 64

/** Past this many passes the radius stops growing (a 16K frame's widest bloom is still inside it). */
export const MAX_BLUR_PASSES = 16

export interface BlurPlan {
  /** How many horizontal-then-vertical rounds to draw. */
  passes: number
  /** The radius each round is drawn with, in px (never above MAX_BLUR_TAP_RADIUS). */
  radiusPx: number
}

/** The passes that draw a blur of `radiusPx`. */
export function blurPlan(radiusPx: number): BlurPlan {
  const r = Number.isFinite(radiusPx) ? Math.max(radiusPx, 0) : 0
  if (r <= MAX_BLUR_TAP_RADIUS) return { passes: 1, radiusPx: r }
  const passes = Math.min(MAX_BLUR_PASSES, Math.ceil((r / MAX_BLUR_TAP_RADIUS) ** 2))
  return { passes, radiusPx: Math.min(r / Math.sqrt(passes), MAX_BLUR_TAP_RADIUS) }
}

/**
 * The variance, in px squared, of the kernel BLUR_FS draws for one pass of radius
 * `r`: sigma = r / 2, taps 0 to floor(r), each weighted exp(-i^2 / 2 sigma^2). It is
 * the shader's own sum, so a test can say how wide a plan really blurs.
 */
export function passVariance(r: number): number {
  if (r < 0.5) return 0
  const sigma = r * 0.5
  const taps = Math.min(Math.floor(r), MAX_BLUR_TAP_RADIUS)
  let weights = 1
  let moment = 0
  for (let i = 1; i <= taps; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    weights += 2 * w
    moment += 2 * w * i * i
  }
  return moment / weights
}

/** The standard deviation, in px, of the whole plan: passes add in variance. */
export function effectiveSigma(plan: BlurPlan): number {
  return Math.sqrt(plan.passes * passVariance(plan.radiusPx))
}
