// Filmstrip planning: which source frames a video clip shows across its
// timeline width. Pure math: the DOM capture lives in state/filmstrips.ts.
// Tile counts snap to buckets so zooming doesn't regenerate on every pixel,
// and keys quantize the trim so a live trim-drag doesn't thrash the cache.

/** One strip tile is ~this wide on screen; height follows the lane. */
export const TILE_W = 64
/** Zoom buckets: regenerate only when the needed tile count crosses one. */
const BUCKETS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]

export interface FilmstripPlan {
  /** Tiles in the strip (bucketed). */
  n: number
  /** Source times to capture, in order of display (reversed clips reverse). */
  timesS: number[]
  /** Cache key: same key ⇒ the cached strip is reusable. */
  key: string
}

const q = (x: number): number => Math.round(x * 2) / 2 // 0.5s trim quantization

/**
 * Plan the strip for a clip drawn `widthPx` wide showing source [inS, outS).
 * Negative speed reverses tile order (the clip plays backwards, so should its
 * thumbnails). Returns null for degenerate spans.
 */
export function filmstripPlan(
  assetId: string,
  widthPx: number,
  inS: number,
  outS: number,
  speed: number,
): FilmstripPlan | null {
  const span = outS - inS
  if (!(span > 0) || !(widthPx > 0)) return null
  const want = Math.max(1, Math.round(widthPx / TILE_W))
  const n = BUCKETS.find((b) => b >= want) ?? BUCKETS[BUCKETS.length - 1]
  const qi = q(inS)
  const qo = Math.max(q(outS), qi + 0.1)
  const timesS: number[] = []
  for (let i = 0; i < n; i++) {
    // Tile centers, so 1 tile shows the middle of the clip, not frame 0.
    timesS.push(qi + ((i + 0.5) / n) * (qo - qi))
  }
  if (speed < 0) timesS.reverse()
  return { n, timesS, key: `${assetId}|${n}|${qi.toFixed(1)}|${qo.toFixed(1)}|${speed < 0 ? 'r' : 'f'}` }
}
