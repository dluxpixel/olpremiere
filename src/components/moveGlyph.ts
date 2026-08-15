// WHAT A TILE DRAWS, worked out from the move itself.
//
// The shelf shipped in v0.1.55 with ten tiles that all drew the SAME picture: a
// frame with a pale bar in it. The little animation that told them apart only
// ran while the pointer was over the grid, so at rest, which is how the shelf
// spends almost all of its life and ALL of it for anyone who has asked their
// system for less motion, Shake and Drift right were one tile with different
// words underneath. The design that won said a tile "should show what it does
// rather than describing it", and a picture that only shows it while you hover
// is not that.
//
// So a tile is a CHART of the move, complete standing still, in two panes:
//
//   THE STAGE says WHERE. The rectangle of picture that is actually on screen:
//   where the move starts (dashed), its deepest point when that is somewhere
//   neither end is, and where it ends (solid), plus the route the middle of the
//   picture travels with an arrow on the longest leg of it.
//
//   THE TAPE says WHEN. How deep the move is across its own length, with a tick
//   on every moment it has. The same two things the ribbon under the tiles draws
//   for the clip he has selected, in miniature.
//
// EVERY NUMBER IN HERE COMES OUT OF moveSamples AND moveBeatTimes, which are the
// renderer's own evalChannel over the keyframes buildMove writes. There is no
// second table of what a move looks like, so a tile cannot drift away from what
// the move does: change a beat in moves.ts and the tile changes with it. That is
// the whole reason this file takes MoveDef and not a list of pictures.
//
// THE AXES ARE SHARED BY ALL TEN TILES, and both are read off the moves:
//
//   depth measures against the depth he has chosen, so a beat at d = 0.35 draws
//   at 0.35 of the range and a beat at d = 1 fills it;
//   travel measures against the furthest any of the ten moves shifts the
//   picture, so the widest journey on the shelf spans the tile and everything
//   else is drawn in proportion to it.
//
// A TILE IS NOT A SCALE MODEL, on purpose. At 120 percent the true difference
// between the frame and the picture on screen is about three pixels on a 38
// pixel tile, which is nothing to look at, and every tile would be the same grey
// box again. A shared axis is what a chart does. The magnitude is not lost: it
// is on the readout under the tiles, in percent, where a number belongs.
//
// The consequence, which is deliberate: dragging How big leaves every rectangle
// exactly the size it was and only lengthens the journeys, because a deeper zoom
// really does carry the picture further for the same aim. So the ten stay
// comparable with each other at every depth, and the thing that moves while he
// drags is the number.

import { moveBeatTimes, moveSamples, type MoveDef, type MoveId, type MoveSample } from '../engine/moves'

/** A box a tile draws into, in px. */
export interface Box {
  w: number
  h: number
}

/** A rectangle inside one of those boxes, in px. */
export interface GlyphRect {
  x: number
  y: number
  w: number
  h: number
}

/** Which moment of the move a rectangle is. */
export type MarkKind = 'from' | 'peak' | 'to'

export interface GlyphMark {
  kind: MarkKind
  rect: GlyphRect
}

/** One tick on the tape: a moment of the move, standing on the curve. */
export interface GlyphBeat {
  x: number
  y1: number
  y2: number
}

/** Everything one tile draws, ready to hand straight to SVG attributes. */
export interface MoveGlyph {
  id: MoveId
  /**
   * One to three rectangles, in paint order. `to` is always last and every move
   * has one. A rectangle that lands on top of another is drawn once: two boxes a
   * pixel apart are one box to the eye and only make the tile muddier.
   */
  marks: GlyphMark[]
  /** The route the middle of the picture travels. Empty when it stays put. */
  route: string
  /** The arrowhead on the longest leg of that route. Empty when there is no route. */
  head: string
  /** That leg as a vector, so which way a move goes can be asserted rather than eyeballed. */
  travel: { x: number; y: number } | null
  /** How deep the move is across its own length, closed under the curve, in tape units. */
  tape: string
  /** The top edge of that shape on its own, so the fill can carry a crisp line. */
  tapeLine: string
  /** Every moment of the move, standing on that line. */
  beats: GlyphBeat[]
  /** True when the move changes nothing at all. Only None. */
  still: boolean
}

/**
 * The axes the whole shelf was drawn on. Handed back so the hover loop can put a
 * live frame on EXACTLY the axes the still picture used, rather than working
 * them out a second time and drifting by a pixel.
 */
export interface GlyphAxes {
  depth: number
  /** The furthest any of the ten moves shifts the picture, in frame shares. */
  reach: number
  stage: Box
}

export interface ShelfGlyphs {
  axes: GlyphAxes
  glyphs: MoveGlyph[]
  /** The instants each move was drawn from, so the hover loop reads the same table. */
  tables: Map<MoveId, MoveSample[]>
}

/** How many instants a tile is drawn from. moveSamples' own default. */
const STEPS = 48

/** The smallest the drawn picture gets, as a share of the frame. */
const INNER_MIN = 0.54
/** The sliver of frame that stays showing around the drawn picture at its furthest reach. */
const EDGE = 0.03
/**
 * The margin between the tile's own edge and the widest rectangle the move
 * draws, in px. Half of it is the stroke, which would otherwise sit half under
 * the tile's border; the rest is clear ground, so a move that begins on the full
 * frame reads as its own line rather than as a thicker border.
 */
const INSET = 1.75
/**
 * How far off centre a drawn picture may sit, as a share of the frame. Derived
 * from the two above rather than tuned by hand, so the deepest rectangle at the
 * furthest reach still leaves EDGE of frame around it and no combination of
 * numbers in moves.ts can draw a tile that overflows its own box.
 */
const PAN_MAX = (1 - INNER_MIN) / 2 - EDGE

/** Under this share of the stage a travel is a wobble, and gets no route and no arrow. */
const TRAVEL_MIN = 0.08
/** Two rectangles this close, in px, are one rectangle to the eye and are drawn once. */
const SAME_PX = 1.25
/** The arrowhead, in px. */
const HEAD = 4
/** A route point this close to the last one kept, in px, adds nothing to the shape. */
const THIN_PX = 0.35
/** The same, for the tape, where only the height carries meaning. */
const TAPE_TOL = 0.2
/** The tape's time axis: percent of the move's own length, so the strip can be any width. */
const TAPE_W = 100

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Two decimals is under a tenth of a pixel here, and keeps the path strings short. */
const n = (v: number): string => String(Math.round(v * 100) / 100)

/**
 * The rectangle of picture actually on screen at one instant, in frame shares.
 *
 * The renderer scales the layer about its middle and then shifts it, so what
 * survives is `1 / scale` across, centred where the shift left it. This is the
 * inverse of the transform the monitor applies, which is why a tile drawn from
 * it shows what he would SEE rather than what the layer is doing.
 */
function viewport(s: MoveSample): { cx: number; cy: number; size: number } {
  const size = 1 / (s.scale > 1e-6 ? s.scale : 1)
  return { cx: 0.5 - s.dx * size, cy: 0.5 - s.dy * size, size }
}

/**
 * How deep the move is here, against the depth he chose. 0 is the clip's own
 * framing, 1 is all the way.
 *
 * Rounded to a millionth for the same reason moveBeatTimes rounds its times.
 * The share is depth-free in exact arithmetic (a scale of `1 + d(D-1)` divided
 * back by `D-1` is d, whatever D is), but the division leaves noise in the last
 * bit or two, and a beat at d = 0.35 draws at y = 6.925 on an 11 unit tape,
 * which is exactly halfway between two of the two-decimal steps `n` rounds to.
 * A wobble of 1e-15 there became a visibly different path string at one depth
 * and not another. A millionth of the depth range is a hundred thousandth of a
 * pixel, so nothing that can be seen is lost by settling it here.
 */
const depthAt = (s: MoveSample, depth: number): number =>
  depth <= 1 ? 0 : clamp(Math.round(((s.scale - 1) / (depth - 1)) * 1e6) / 1e6, 0, 1)

/** The furthest any move on the shelf shifts the picture: the travel axis every tile is drawn against. */
function panReach(tables: readonly (readonly MoveSample[])[]): number {
  let far = 0
  for (const table of tables) {
    for (const s of table) {
      const v = viewport(s)
      far = Math.max(far, Math.abs(v.cx - 0.5), Math.abs(v.cy - 0.5))
    }
  }
  return far
}

/** One instant, placed in the stage. */
function placeSample(s: MoveSample, axes: GlyphAxes): GlyphRect {
  const { stage, depth, reach } = axes
  const bw = stage.w - INSET * 2
  const bh = stage.h - INSET * 2
  const f = 1 - (1 - INNER_MIN) * depthAt(s, depth)
  const w = f * bw
  const h = f * bh
  const v = viewport(s)
  const px = reach > 1e-9 ? clamp((v.cx - 0.5) / reach, -1, 1) : 0
  const py = reach > 1e-9 ? clamp((v.cy - 0.5) / reach, -1, 1) : 0
  // Held inside the frame whatever the table says. The shipped ten never reach
  // this clamp and a test says so, because a move only shifts the picture once
  // it has made it bigger, so the furthest reach always belongs to the smallest
  // rectangle. The clamp is here for the eleventh move, not for these ten.
  const cx = clamp(INSET + bw / 2 + px * PAN_MAX * bw, INSET + w / 2, INSET + bw - w / 2)
  const cy = clamp(INSET + bh / 2 + py * PAN_MAX * bh, INSET + h / 2, INSET + bh - h / 2)
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

const middle = (r: GlyphRect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

const sameRect = (a: GlyphRect, b: GlyphRect): boolean =>
  Math.abs(a.x - b.x) < SAME_PX &&
  Math.abs(a.y - b.y) < SAME_PX &&
  Math.abs(a.w - b.w) < SAME_PX &&
  Math.abs(a.h - b.h) < SAME_PX

/** The move `p` of the way through, read between the two instants either side of it. */
function sampleAt(table: readonly MoveSample[], p: number): MoveSample {
  if (table.length === 0) return { p: 0, scale: 1, dx: 0, dy: 0 }
  const q = clamp(p, 0, 1)
  const at = q * (table.length - 1)
  const i = Math.min(table.length - 1, Math.floor(at))
  const j = Math.min(table.length - 1, i + 1)
  const f = at - i
  const a = table[i]
  const b = table[j]
  return {
    p: q,
    scale: a.scale + (b.scale - a.scale) * f,
    dx: a.dx + (b.dx - a.dx) * f,
    dy: a.dy + (b.dy - a.dy) * f,
  }
}

/**
 * The points that add something to a shape, so a hold becomes one straight run
 * instead of forty. The lookahead is what keeps a corner square: the last point
 * of a flat run is kept even though it moved nothing, or the rise that follows
 * it would be drawn as one long diagonal from where the flat run began.
 */
function thin<T extends { x: number; y: number }>(points: readonly T[], moved: (a: T, b: T) => boolean): T[] {
  const out: T[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const kept = out[out.length - 1]
    const next = points[i + 1]
    if (
      i === 0 ||
      i === points.length - 1 ||
      !kept ||
      moved(kept, p) ||
      (next !== undefined && moved(p, next))
    ) {
      out.push(p)
    }
  }
  return out
}

const movedPx = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.abs(a.x - b.x) > THIN_PX || Math.abs(a.y - b.y) > THIN_PX

const movedTape = (a: { y: number }, b: { y: number }): boolean => Math.abs(a.y - b.y) > TAPE_TOL

const polyline = (points: readonly { x: number; y: number }[]): string =>
  points.length < 2 ? '' : `M${points.map((p) => `${n(p.x)},${n(p.y)}`).join('L')}`

/** A solid head at `to`, pointing the way it came from `from`. */
function arrowHead(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return ''
  const ux = dx / len
  const uy = dy / len
  const bx = to.x - ux * HEAD
  const by = to.y - uy * HEAD
  const nx = -uy * HEAD * 0.5
  const ny = ux * HEAD * 0.5
  return `M${n(to.x)},${n(to.y)}L${n(bx + nx)},${n(by + ny)}L${n(bx - nx)},${n(by - ny)}Z`
}

/** The timing pane: the depth curve, and a tick standing on it for every moment the move has. */
function tapeOf(
  table: readonly MoveSample[],
  timesS: readonly number[],
  durS: number,
  depth: number,
  tapeH: number,
): { fill: string; line: string; beats: GlyphBeat[] } {
  const top = 0.75
  const bottom = tapeH - 0.75
  const y = (d: number): number => bottom - d * (bottom - top)
  const points = table.map((s, i) => ({
    x: (i / Math.max(1, table.length - 1)) * TAPE_W,
    y: y(depthAt(s, depth)),
  }))
  const kept = thin(points, movedTape)
  const line = polyline(kept)
  const fill = line === '' ? '' : `${line}L${n(TAPE_W)},${n(tapeH)}L0,${n(tapeH)}Z`
  const beats: GlyphBeat[] = []
  for (const t of timesS) {
    const p = durS > 0 ? clamp(t / durS, 0, 1) : 0
    const at = y(depthAt(sampleAt(table, p), depth))
    beats.push({
      x: p * TAPE_W,
      y1: Math.max(0.5, at - 2.5),
      y2: Math.min(tapeH - 0.5, at + 2.5),
    })
  }
  return { fill, line, beats }
}

function glyphFor(
  def: MoveDef,
  table: readonly MoveSample[],
  axes: GlyphAxes,
  riseFrames: number,
  tapeH: number,
): MoveGlyph {
  const { depth, stage } = axes

  let deepest = 0
  for (let i = 1; i < table.length; i++) {
    if (table[i].scale > table[deepest].scale + 1e-9) deepest = i
  }
  const from = placeSample(table[0], axes)
  const to = placeSample(table[table.length - 1], axes)
  const peak = placeSample(table[deepest], axes)
  const marks: GlyphMark[] = []
  if (!sameRect(from, to)) marks.push({ kind: 'from', rect: from })
  if (!sameRect(peak, from) && !sameRect(peak, to)) marks.push({ kind: 'peak', rect: peak })
  marks.push({ kind: 'to', rect: to })

  // The arrow sits on the biggest single journey the move makes BETWEEN ITS OWN
  // MOMENTS, which is the leg a person would name if they described the move out
  // loud: "across to the right". Anything smaller than a tenth of the tile is a
  // wobble, not a journey, and an arrow on it would be noise.
  const { durS, timesS } = moveBeatTimes(def, depth, riseFrames)
  const beatMids = timesS.map((t) => middle(placeSample(sampleAt(table, durS > 0 ? t / durS : 0), axes)))
  let leg = 0
  let longest = -1
  for (let i = 1; i < beatMids.length; i++) {
    const len = Math.hypot(beatMids[i].x - beatMids[i - 1].x, beatMids[i].y - beatMids[i - 1].y)
    if (len > leg + 1e-9) {
      leg = len
      longest = i
    }
  }
  const travels = longest > 0 && leg >= TRAVEL_MIN * stage.w
  const tape = tapeOf(table, timesS, durS, depth, tapeH)

  return {
    id: def.id,
    marks,
    route: travels ? polyline(thin(table.map((s) => middle(placeSample(s, axes))), movedPx)) : '',
    head: travels ? arrowHead(beatMids[longest - 1], beatMids[longest]) : '',
    travel: travels
      ? { x: beatMids[longest].x - beatMids[longest - 1].x, y: beatMids[longest].y - beatMids[longest - 1].y }
      : null,
    tape: tape.fill,
    tapeLine: tape.line,
    beats: tape.beats,
    still: table.every(
      (s) => Math.abs(s.scale - 1) < 1e-9 && Math.abs(s.dx) < 1e-9 && Math.abs(s.dy) < 1e-9,
    ),
  }
}

/**
 * Every tile's picture, on axes the whole shelf shares.
 *
 * `moves` is passed in rather than read from the module so a test can hand this
 * a table with one number changed and watch the picture follow it. That is the
 * property the shelf lives or dies on.
 */
export function shelfGlyphs(
  moves: readonly MoveDef[],
  depth: number,
  riseFrames: number,
  stage: Box,
  tapeH: number,
): ShelfGlyphs {
  // ⛔ EACH TILE DRAWN AT THE DEPTH IT WILL ACTUALLY BE APPLIED AT. An out tile
  // takes the slider's magnitude the other way, so drawing it at the raw slider
  // value made Pull back and Push in the SAME PICTURE on the shelf: identical
  // beats, identical depth, nothing to tell them apart. The tile has to show what
  // the tile does. Same rule as `depthFor` in moveActions.
  const applied = (def: MoveDef): number => (def.out ? 1 / (depth || 1) : depth)
  const tables = moves.map((def) => moveSamples(def, applied(def), riseFrames, STEPS))
  // The axes span BOTH directions now, so a tile that shrinks and a tile that
  // grows are drawn to one scale and read as opposites rather than as twins.
  const axes: GlyphAxes = { depth: Math.max(depth, 1 / (depth || 1)), reach: panReach(tables), stage }
  return {
    axes,
    glyphs: moves.map((def, i) => glyphFor(def, tables[i], axes, riseFrames, tapeH)),
    tables: new Map(moves.map((def, i) => [def.id, tables[i]])),
  }
}

/**
 * One instant of a move on the shelf's own axes: the picture on screen, and
 * where the tape's playhead stands. The hover loop's whole job, kept in here
 * with the rest of the geometry so it can be tested without a browser.
 */
export function liveFrame(
  table: readonly MoveSample[],
  p: number,
  axes: GlyphAxes,
): { rect: GlyphRect; tapeX: number } {
  return { rect: placeSample(sampleAt(table, p), axes), tapeX: clamp(p, 0, 1) * TAPE_W }
}

/** The tape's own width in its own units, for the viewBox that draws it. */
export const TAPE_UNITS = TAPE_W
