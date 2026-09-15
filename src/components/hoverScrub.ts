// Hover scrub on a media thumbnail: slide the pointer across the picture and
// see the frame under it, the way Premiere's icon view and Resolve's media pool
// do. Borrowed on 2026-09-15 from the community research (vault
// projects/ol-premiere/ol-premiere-what-editors-love-in-premiere-and-vegas.md):
// switchers name it as the thing that lets them find a moment without loading
// a clip anywhere. Pure geometry here; the card owns the <video>.

/**
 * The source time under the pointer. `xPx` is measured from the picture's left
 * edge across `widthPx`. Clamped to the clip and quantized to a frame, and it
 * never lands on the very end, because a seek to the exact end of a file shows
 * black rather than the last frame.
 */
export function scrubTimeAt(xPx: number, widthPx: number, durationS: number, fps: number): number {
  if (!(widthPx > 0) || !(durationS > 0)) return 0
  const frame = 1 / (fps > 0 ? fps : 30)
  const frac = Math.min(1, Math.max(0, xPx / widthPx))
  const last = Math.max(0, durationS - frame)
  return Math.min(last, Math.round((frac * durationS) / frame) * frame)
}

/** A seek is worth asking for only when the target moved by a frame or more. */
export function movedAFrame(fromS: number, toS: number, fps: number): boolean {
  const frame = 1 / (fps > 0 ? fps : 30)
  return Math.abs(toS - fromS) >= frame / 2
}
