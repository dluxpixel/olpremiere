// The TikTok text highlight, as pure geometry: every line of a title gets its own
// box hugging that line, and the boxes of neighbouring lines merge into ONE shape
// with rounded outer corners and rounded INNER (concave) corners where a wide line
// meets a narrow one. No canvas in here, so it is unit tested in node; titleRaster
// measures the lines, asks for the shapes and fills them.

import type { TitleLineBox } from '../types'

/**
 * The TikTok look's measurements, in em of the title's font size. Every TikTok
 * look and the Line highlight switch read these, so a later measurement changes
 * ONE place.
 *
 * PROVISIONAL, not yet measured against a TikTok recording.
 */
export const TIKTOK_LINE_BOX = { padXEm: 0.32, padYEm: 0.1, radiusEm: 0.3 } as const

/** A line highlight at the TikTok measurements, in the colour and opacity asked for. */
export const tiktokLineBox = (color: string, opacity: number): TitleLineBox => ({ color, opacity, ...TIKTOK_LINE_BOX })

/** One measured line of text, in raster px after alignment: its ink-free advance box and its line cell. */
export interface LineSpan {
  left: number
  right: number
  top: number
  bottom: number
}

/** A corner of the outline and how round it is drawn: the tangent arcs of arcTo, concave or convex alike. */
export interface LineBoxCorner {
  x: number
  y: number
  r: number
}

/** One closed outline, clockwise from the top right corner of its first line. */
export type LineBoxShape = LineBoxCorner[]

const EPS = 1e-6

interface Band {
  l: number
  r: number
  t: number
  b: number
}

/**
 * The outline of the union of the padded line rectangles.
 *
 * `lines` runs top to bottom; `null` is an EMPTY line (a blank line between
 * paragraphs), which splits the shape in two, as does a line that does not
 * overlap its neighbour sideways. Rules, per run of joined lines:
 *  - Vertically the bands meet at ONE shared edge, halfway between a line's
 *    padded bottom and the next line's padded top, so there is no gap and no seam
 *    whatever the line height.
 *  - A side that differs from its neighbour by LESS than twice the radius snaps to
 *    the wider line, so there is never a sliver of a step too short to hold two
 *    arcs. Repeated until none is left, so a staircase of near steps becomes one
 *    edge rather than a run of slivers.
 *  - Every corner, outer and inner, takes the radius, clamped to half of the
 *    shortest edge it sits on so two arcs on one edge can never overlap (half the
 *    step, half the line height).
 */
export function lineBoxShapes(
  lines: readonly (LineSpan | null)[],
  padXPx: number,
  padYPx: number,
  radiusPx: number,
): LineBoxShape[] {
  const radius = Math.max(0, Number.isFinite(radiusPx) ? radiusPx : 0)
  const runs: Band[][] = []
  let run: Band[] = []
  const flush = (): void => {
    if (run.length > 0) runs.push(run)
    run = []
  }
  for (const line of lines) {
    if (!line) {
      flush()
      continue
    }
    const band: Band = { l: line.left - padXPx, r: line.right + padXPx, t: line.top - padYPx, b: line.bottom + padYPx }
    if (![band.l, band.r, band.t, band.b].every(Number.isFinite) || !(band.r > band.l) || !(band.b > band.t)) {
      flush()
      continue
    }
    const prev = run[run.length - 1]
    if (prev && Math.min(prev.r, band.r) - Math.max(prev.l, band.l) <= 0) flush()
    run.push(band)
  }
  flush()
  return runs.map((bands) => outline(bands, radius))
}

/** Make neighbouring values that differ by less than `tol` (but not by nothing) equal, to the one `wider` picks. */
function snapSide(v: number[], wider: (a: number, b: number) => number, tol: number): void {
  for (let pass = 0; pass <= 2 * v.length; pass++) {
    let changed = false
    for (let i = 0; i < v.length - 1; i++) {
      const d = Math.abs(v[i]! - v[i + 1]!)
      if (d > EPS && d < tol) {
        const w = wider(v[i]!, v[i + 1]!)
        v[i] = w
        v[i + 1] = w
        changed = true
      }
    }
    if (!changed) break
  }
}

function outline(bands: readonly Band[], radius: number): LineBoxShape {
  const n = bands.length
  // The shared edge between line i and i + 1, and so each line's top and bottom.
  const edge = bands.slice(0, -1).map((b, i) => (b.b + bands[i + 1]!.t) / 2)
  const top = (i: number): number => (i === 0 ? bands[0]!.t : edge[i - 1]!)
  const bottom = (i: number): number => (i === n - 1 ? bands[n - 1]!.b : edge[i]!)

  const L = bands.map((b) => b.l)
  const R = bands.map((b) => b.r)
  snapSide(L, Math.min, 2 * radius)
  snapSide(R, Math.max, 2 * radius)
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= EPS

  // Down the right side, then up the left: a corner where the edge changes sides.
  const pts: { x: number; y: number }[] = [{ x: R[0]!, y: top(0) }]
  for (let i = 0; i < n - 1; i++) {
    if (!same(R[i]!, R[i + 1]!)) pts.push({ x: R[i]!, y: edge[i]! }, { x: R[i + 1]!, y: edge[i]! })
  }
  pts.push({ x: R[n - 1]!, y: bottom(n - 1) }, { x: L[n - 1]!, y: bottom(n - 1) })
  for (let i = n - 2; i >= 0; i--) {
    if (!same(L[i]!, L[i + 1]!)) pts.push({ x: L[i + 1]!, y: edge[i]! }, { x: L[i]!, y: edge[i]! })
  }
  pts.push({ x: L[0]!, y: top(0) })

  return pts.map((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length]!
    const next = pts[(i + 1) % pts.length]!
    const room = Math.min(Math.hypot(p.x - prev.x, p.y - prev.y), Math.hypot(p.x - next.x, p.y - next.y)) / 2
    return { x: p.x, y: p.y, r: Math.min(radius, room) }
  })
}

/** Just the path calls the outline needs, so a test can pass a recorder and the raster passes its 2D context. */
export interface LineBoxPath {
  moveTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void
  closePath(): void
}

/**
 * Add each shape to the path as its own closed sub path: start halfway along the
 * last edge, then one arcTo per corner, which rounds a concave corner as readily
 * as a convex one. The caller fills.
 */
export function traceLineBox(path: LineBoxPath, shapes: readonly LineBoxShape[]): void {
  for (const shape of shapes) {
    if (shape.length < 3) continue
    const last = shape[shape.length - 1]!
    path.moveTo((last.x + shape[0]!.x) / 2, (last.y + shape[0]!.y) / 2)
    shape.forEach((c, i) => {
      const next = shape[(i + 1) % shape.length]!
      path.arcTo(c.x, c.y, next.x, next.y, c.r)
    })
    path.closePath()
  }
}

// ---------------------------------------------------------------------------
// Text colour that reads on the box, the way TikTok flips it.

/** Relative luminance (0 to 1) of a CSS colour, or null when it is not a form read here (#rgb, #rrggbb, rgb(), rgba()). */
function luminanceOf(color: string): number | null {
  const c = color.trim().toLowerCase()
  let rgb: [number, number, number] | null = null
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/.exec(c)
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  } else {
    const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(c)
    if (fn) rgb = [Number(fn[1]), Number(fn[2]), Number(fn[3])]
  }
  if (!rgb || rgb.some((v) => !Number.isFinite(v))) return null
  const lin = rgb.map((v) => {
    const s = Math.min(255, Math.max(0, v)) / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
}

/**
 * Where a box counts as light: above this relative luminance it gets black text.
 * PROVISIONAL, like the box sizes: white and yellow are light, red and blue are
 * not, which is how TikTok flips them.
 */
const LIGHT_BOX_LUMINANCE = 0.4

/** Black text on a light box, white text on a dark one, picked by relative luminance. A colour it cannot read counts as dark. */
export function contrastTextColor(boxColor: string): '#000000' | '#ffffff' {
  const l = luminanceOf(boxColor)
  return l !== null && l > LIGHT_BOX_LUMINANCE ? '#000000' : '#ffffff'
}
