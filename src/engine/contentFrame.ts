// The picture frame INSIDE the export frame.
//
// His ask, 2026-09-04, off a reel: "if I want a short, like 9:16, I can choose
// so it's inside that 9:16. Let's say, for example, 1:1."
//
// The export stays whatever the platform wants (9:16 for a short), and the
// footage is laid out inside a smaller box of a different shape centred in it,
// with the bands above and below left to black or to the blurred backdrop. It is
// one of the most common looks on reels and it is not something you can fake by
// changing the sequence size, because then the FILE is square and the platform
// pillarboxes it itself, badly.
//
// ⛔ THIS FILE IS PURE AND IT IS THE ONLY PLACE THE BOX IS COMPUTED. The
// resolver stamps the answer onto each layer, so the preview and the export
// worker are handed the identical numbers and cannot drift.

/** A rectangle in sequence pixels, top-left origin. */
export interface ContentBox {
  x: number
  y: number
  w: number
  h: number
}

/** The ratios worth a menu entry. `null` is "fill the frame", the default. */
export const CONTENT_ASPECTS: readonly { key: string; label: string; aspect: number | null }[] = [
  { key: 'full', label: 'Fill the frame', aspect: null },
  { key: '1:1', label: '1:1 Square', aspect: 1 },
  { key: '4:5', label: '4:5 Portrait', aspect: 4 / 5 },
  { key: '16:9', label: '16:9 Wide', aspect: 16 / 9 },
  { key: '2.39:1', label: '2.39:1 Cinemascope', aspect: 2.39 },
  { key: '4:3', label: '4:3 Classic', aspect: 4 / 3 },
  { key: '9:16', label: '9:16 Tall', aspect: 9 / 16 },
]

/**
 * Two ratios are the same shape when they agree to about a pixel on a 4K edge.
 *
 * Loose on purpose. 1.7777 and 16/9 are the same intent typed two ways, and a
 * content box that differs from the frame by a quarter of a pixel is a pure cost
 * with nothing to show for it.
 */
const SAME_SHAPE_EPS = 1e-4

/** Parse "16:9", "16/9", "2.39:1" or a plain "1.5" into a ratio. null if it is not one. */
export function parseAspect(text: string): number | null {
  const s = text.trim()
  if (s === '') return null
  const pair = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i.exec(s)
  if (pair) {
    const w = Number(pair[1])
    const h = Number(pair[2])
    if (!(w > 0) || !(h > 0)) return null
    return w / h
  }
  const plain = Number(s)
  return Number.isFinite(plain) && plain > 0 ? plain : null
}

/** "16:9" for the common ones, otherwise the ratio to two decimals. */
export function aspectLabel(aspect: number): string {
  const hit = CONTENT_ASPECTS.find((a) => a.aspect !== null && Math.abs(a.aspect - aspect) < SAME_SHAPE_EPS)
  if (hit) return hit.label
  return `${aspect.toFixed(2)}:1`
}

/**
 * The largest box of `aspect` centred in a `frameW` x `frameH` frame.
 *
 * Returns null when there is no inner frame to speak of: no aspect set, a
 * nonsense one, or one that is the frame's own shape already. Null means "draw
 * exactly as this app has always drawn", which is what keeps every existing
 * project pixel-identical.
 */
export function contentBox(frameW: number, frameH: number, aspect: number | undefined): ContentBox | null {
  if (aspect === undefined || !Number.isFinite(aspect) || aspect <= 0) return null
  if (!(frameW > 0) || !(frameH > 0)) return null
  const frameAspect = frameW / frameH
  if (Math.abs(frameAspect - aspect) < SAME_SHAPE_EPS) return null

  // Wider than the frame: the width is what runs out first, so pin the width.
  const wide = aspect > frameAspect
  const w = wide ? frameW : frameH * aspect
  const h = wide ? frameW / aspect : frameH
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h }
}
