// Pure maths and naming for ONE keyframe lane, kept out of KeyframeTrack.tsx
// so a diamond's colour, the segment a click lands in and the time a drag
// carries it to are unit-testable without the React/DOM stack - the same split
// motionRuler.ts makes for the rail those diamonds sit on.

import { MOMENT_EPS } from '../engine/keyframes'
import type { AnimChannel, Keyframe } from '../engine/types'

// Human channel names - "scale" reads as Zoom, the thing Jettism editors touch most.
const FRIENDLY: Partial<Record<AnimChannel, string>> = {
  scale: 'Zoom',
  posX: 'Position X',
  posY: 'Position Y',
  rotation: 'Rotation',
  opacity: 'Opacity',
  anchorX: 'Anchor X',
  anchorY: 'Anchor Y',
  cropT: 'Crop Top',
  cropR: 'Crop Right',
  cropB: 'Crop Bottom',
  cropL: 'Crop Left',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  exposure: 'Exposure',
  blur: 'Blur',
  lift: 'Lift',
  gamma: 'Gamma',
  gain: 'Gain',
  temperature: 'Temperature',
  tint: 'Tint',
  volume: 'Volume (dB)',
}

export const friendly = (ch: AnimChannel): string => FRIENDLY[ch] ?? ch

// Palette tokens, not loose hexes: ember for a zoom-in, the video family's
// slate blue for a zoom-out. Both sit cleanly on the warm near-black ground.
export const ZOOM_IN = 'var(--color-ember)'
export const ZOOM_OUT = 'var(--color-clip-video-bd)'

/** How far a press must travel before it counts as a drag and not a click. */
export const DRAG_SLOP_PX = 3
/** Half a diamond plus a little: how far off the rail one may sit and still draw. */
export const CULL_PAD_PX = 12

/** Where a drag has carried a diamond, before the frame snap. */
export const dragTargetT = (origT: number, dxPx: number, pxPerS: number): number =>
  pxPerS > 0 ? origT + dxPx / pxPerS : origT

/**
 * The segment a point on the rail falls in, named by the keyframe it LEAVES.
 * -1 before the first diamond and after the last, because there is no move
 * there to shape.
 */
export function segmentIndexAt(kfs: readonly Keyframe[], t: number): number {
  if (kfs.length < 2 || t < kfs[0].t - MOMENT_EPS) return -1
  for (let i = 0; i < kfs.length - 1; i++) if (t <= kfs[i + 1].t + MOMENT_EPS) return i
  return -1
}

/**
 * Colour a diamond: selected → accent; on the Zoom lane, amber if it zooms IN
 * from the previous keyframe, blue if it zooms OUT; otherwise a neutral dot.
 */
export function diamondColor(
  ch: AnimChannel,
  kfs: readonly Keyframe[],
  i: number,
  isSel: boolean,
): string {
  if (isSel) return 'var(--color-accent)'
  if (ch === 'scale' && i > 0) {
    const d = kfs[i].value - kfs[i - 1].value
    if (d > 1e-4) return ZOOM_IN
    if (d < -1e-4) return ZOOM_OUT
  }
  return 'var(--color-text-secondary)'
}
