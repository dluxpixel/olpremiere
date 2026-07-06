// Pure transform math for the GL renderer's layer quad. No GL, no DOM — this is
// the testable core; glRenderer.ts is a thin wrapper that feeds these corners
// into a WebGL2 pipeline. All coordinates are SEQ-SPACE pixels: origin at the
// frame's top-left, +x right, +y DOWN (matching the 2D-canvas convention the
// preview replaced), so a positive rotationDeg turns clockwise on screen.

import type { ResolvedTransform } from './types'

/** Column-major 3x3 (a,b,c,d,e,f,g,h,i) acting on column vectors [x,y,1]. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

export const identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** m * n (apply n first, then m). Both column-major. */
export function multiply(m: Mat3, n: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = m
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = n
  return [
    a0 * b0 + a3 * b1 + a6 * b2,
    a1 * b0 + a4 * b1 + a7 * b2,
    a2 * b0 + a5 * b1 + a8 * b2,
    a0 * b3 + a3 * b4 + a6 * b5,
    a1 * b3 + a4 * b4 + a7 * b5,
    a2 * b3 + a5 * b4 + a8 * b5,
    a0 * b6 + a3 * b7 + a6 * b8,
    a1 * b6 + a4 * b7 + a7 * b8,
    a2 * b6 + a5 * b7 + a8 * b8,
  ]
}

export const translation = (tx: number, ty: number): Mat3 => [1, 0, 0, 0, 1, 0, tx, ty, 1]

export const scaling = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1]

export function rotation(rad: number): Mat3 {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  // +y is down, so a positive angle rotates clockwise on screen.
  return [c, s, 0, -s, c, 0, 0, 0, 1]
}

/** Apply a Mat3 to a point, dropping the (always 1) homogeneous w. */
export function apply(m: Mat3, x: number, y: number): [number, number] {
  return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]
}

/** Cropped source dimensions given crop fractions inset from each edge. */
export function croppedSize(
  texW: number,
  texH: number,
  cropT: number,
  cropR: number,
  cropB: number,
  cropL: number,
): { w: number; h: number } {
  const w = texW * Math.max(0, 1 - cropL - cropR)
  const h = texH * Math.max(0, 1 - cropT - cropB)
  return { w, h }
}

/**
 * Contain-fit scale for the cropped source into the frame (identical to the 2D
 * preview's `min(W/sw, H/sh)`), evaluated on the CROPPED dims so a crop changes
 * the fitted size. Returns 0 for degenerate (zero-area) sources.
 */
export function fitScale(frameW: number, frameH: number, croppedW: number, croppedH: number): number {
  if (croppedW <= 0 || croppedH <= 0) return 0
  return Math.min(frameW / croppedW, frameH / croppedH)
}

/**
 * Compose the full layer transform and return the four quad corners in seq-space
 * pixels, in the order [TL, TR, BR, BL] (matching UV order [0,0],[1,0],[1,1],[0,1]).
 *
 * Pipeline (right-to-left): start from the contain-fitted cropped rectangle
 * centered on the frame. Move the pivot to the anchor point, apply transform
 * scale then rotation about that pivot, then translate by (x, y). Identity
 * transform therefore yields the centered contain-fit unchanged.
 */
export function computeQuad(opts: {
  frameW: number
  frameH: number
  texW: number
  texH: number
  transform: ResolvedTransform
}): { corners: [number, number][] } {
  const { frameW, frameH, texW, texH, transform: tf } = opts
  const { w: cw, h: ch } = croppedSize(texW, texH, tf.cropT, tf.cropR, tf.cropB, tf.cropL)
  const fit = fitScale(frameW, frameH, cw, ch)
  // Fitted rectangle size in seq px (before the user scale).
  const rw = cw * fit
  const rh = ch * fit
  const cx = frameW / 2
  const cy = frameH / 2

  // Base rectangle corners, centered on the frame, TL,TR,BR,BL.
  const base: [number, number][] = [
    [cx - rw / 2, cy - rh / 2],
    [cx + rw / 2, cy - rh / 2],
    [cx + rw / 2, cy + rh / 2],
    [cx - rw / 2, cy + rh / 2],
  ]

  // Pivot: anchor 0..1 across the fitted rectangle (0.5,0.5 = its center).
  const px = cx + (tf.anchorX - 0.5) * rw
  const py = cy + (tf.anchorY - 0.5) * rh

  // M = T(x,y) * T(px,py) * R * S * T(-px,-py): scale+rotate about the pivot,
  // then offset by the position. Built as one Mat3 so tests can assert corners.
  const m = multiply(
    multiply(
      translation(tf.x + px, tf.y + py),
      multiply(rotation((tf.rotationDeg * Math.PI) / 180), scaling(tf.scale, tf.scale)),
    ),
    translation(-px, -py),
  )

  return { corners: base.map(([x, y]) => apply(m, x, y)) }
}

/**
 * UV rectangle to sample from the SOURCE texture given crop fractions: the
 * cropped region is [cropL, 1-cropR] x [cropT, 1-cropB]. Returned as
 * {u0,v0,u1,v1} with v0 at the TOP edge (v increases downward, matching a
 * texture uploaded top-row-first from a TexImageSource).
 */
export function cropUV(
  cropT: number,
  cropR: number,
  cropB: number,
  cropL: number,
): { u0: number; v0: number; u1: number; v1: number } {
  return { u0: cropL, v0: cropT, u1: 1 - cropR, v1: 1 - cropB }
}
