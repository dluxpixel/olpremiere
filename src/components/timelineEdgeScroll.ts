// --- edge auto-scroll during drags ---------------------------------------
// Speed ramps 4→20 px/frame with proximity to the container edge. The rAF
// loop marks its scrollLeft writes as programmatic (playback-follow must not
// suspend) and re-runs the drag math from the last pointer position.
export const EDGE_ZONE_PX = 32

/** The box an edge speed is measured against, as getBoundingClientRect() gives it. */
export interface EdgeRect {
  left: number
  right: number
  top: number
  bottom: number
}

export function edgeSpeedX(r: EdgeRect, clientX: number): number {
  const leftGap = clientX - r.left
  const rightGap = r.right - clientX
  if (leftGap < EDGE_ZONE_PX) return -(4 + (16 * (EDGE_ZONE_PX - Math.max(0, leftGap))) / EDGE_ZONE_PX)
  if (rightGap < EDGE_ZONE_PX) return 4 + (16 * (EDGE_ZONE_PX - Math.max(0, rightGap))) / EDGE_ZONE_PX
  return 0
}

/**
 * The same rule DOWN the lanes, so a drag that runs off the top or bottom
 * brings the other tracks into view.
 *
 * His words, 2026-08-12: "when I'm making a right-click drag up on the preview
 * down there, the clips also go up so I can see what I'm selecting when I have
 * a lot of V1s and audio lines." Edge scrolling existed and was **sideways
 * only**, so on a tall stack he was drawing a box around tracks he could not
 * see. Slower than the horizontal speed on purpose: lanes are tall, so the same
 * pixels-per-frame flies past far more content.
 */
export function edgeSpeedY(r: EdgeRect, clientY: number): number {
  const topGap = clientY - r.top
  const botGap = r.bottom - clientY
  if (topGap < EDGE_ZONE_PX) return -(2 + (8 * (EDGE_ZONE_PX - Math.max(0, topGap))) / EDGE_ZONE_PX)
  if (botGap < EDGE_ZONE_PX) return 2 + (8 * (EDGE_ZONE_PX - Math.max(0, botGap))) / EDGE_ZONE_PX
  return 0
}
