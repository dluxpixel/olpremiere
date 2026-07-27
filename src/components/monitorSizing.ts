// Pure sizing for the program-monitor canvas, kept out of Monitor.tsx so it is
// unit-testable without the React/DOM stack.

export interface CanvasBox {
  /** CSS box (CSS px, fractional when dpr is) spanning a WHOLE number of
   *  device pixels, because a fractional device-pixel extent makes the compositor
   *  resample the finished canvas (a faint uniform blur over the preview). */
  cssW: number
  cssH: number
  /** Canvas backing-store raster. At quality 1 it equals the device-pixel
   *  extent exactly, so canvas texels map 1:1 to screen pixels with no resample. */
  pxW: number
  pxH: number
}

/**
 * Fit an `aspect` (w/h) box inside parentW×parentH, then snap it to whole
 * device pixels. Floor, not round: the box must never overflow the panel.
 * Snapping each axis independently drifts aspect by under one device pixel.
 */
export function fitCanvasBox(
  parentW: number,
  parentH: number,
  aspect: number,
  dpr: number,
  quality: number,
): CanvasBox {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  let w = Math.max(0, parentW)
  let h = w / safeAspect
  if (h > parentH) {
    h = Math.max(0, parentH)
    w = h * safeAspect
  }
  const devW = Math.max(1, Math.floor(w * safeDpr))
  const devH = Math.max(1, Math.floor(h * safeDpr))
  return {
    cssW: devW / safeDpr,
    cssH: devH / safeDpr,
    pxW: Math.max(1, Math.round(devW * quality)),
    pxH: Math.max(1, Math.round(devH * quality)),
  }
}
