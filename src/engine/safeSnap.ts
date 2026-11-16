// The safe area for TikTok text mode, and the pull that keeps a title inside it while it is
// dragged. Pure geometry in SEQUENCE px, no DOM, so it is unit tested in node; the gizmo
// (components/MonitorTransformOverlay.tsx) feeds it and the guides overlay
// (components/AppGuidesOverlay.tsx) tints what it reports.
//
// The safe area is the frame minus where the app covers the picture (engine/appGuides.ts has
// the insets and says they are estimates). On a frame the guides do not apply to, it is the
// whole frame.
//
// ⛔ A PULL, NEVER A WALL. Every call starts from the move the pointer asked for, not from the
// last answer, so there is nothing to be stuck to: past the snap distance the move is exactly
// what was asked. A title can always be dragged into a guide on purpose (Alt turns even the
// pull off, in the gizmo).

import { appGuideRegions, type AppGuideApp, type GuideRegion } from './appGuides'
import type { SnapBox } from './snapTransform'

/** A rectangle in sequence px. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The frame minus the app's top band, bottom band and right column; the whole frame when the guides do not apply. */
export function safeRect(w: number, h: number, app: AppGuideApp): Rect {
  const regions = appGuideRegions(w, h, app)
  if (!regions) return { x: 0, y: 0, w, h }
  const top = regions.find((r) => r.key === 'top')?.h ?? 0
  const bottom = regions.find((r) => r.key === 'bottom')?.h ?? 0
  const right = regions.find((r) => r.key === 'right')?.w ?? 0
  return { x: 0, y: top, w: w - right, h: h - top - bottom }
}

/** Less than this much of the box inside a region is not an overlap: an edge resting on the line is clear of it. */
const TOUCH_EPS = 1e-3

/** Which guide regions the box reaches into, in the regions' own order. Empty where there are no guides. */
export function guideRegionsHit(box: SnapBox, regions: readonly GuideRegion[] | null): GuideRegion['key'][] {
  if (!regions) return []
  return regions
    .filter(
      (r) =>
        Math.min(box.maxX, r.x + r.w) - Math.max(box.minX, r.x) > TOUCH_EPS &&
        Math.min(box.maxY, r.y + r.h) - Math.max(box.minY, r.y) > TOUCH_EPS,
    )
    .map((r) => r.key)
}

export interface SafeSnapResult {
  /** The move to make, in sequence px: the proposed one, pulled onto a safe line where one was near. */
  dx: number
  dy: number
  /** Where to draw the line it is held on, in sequence px along each axis, or null for an axis that is free. */
  guideX: number | null
  guideY: number | null
  /** The guide regions the box overlaps once it has moved that far. */
  overlaps: GuideRegion['key'][]
}

/**
 * The line, among `lines`, that `at` is nearest, within `dist`; the pull needed to land on it.
 * Ties go to the earlier line, so the centre line wins over an edge.
 */
function pull(at: number[], lines: number[], dist: number): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null
  for (let i = 0; i < at.length; i++) {
    const delta = lines[i]! - at[i]!
    if (Math.abs(delta) <= dist && (best === null || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line: lines[i]! }
  }
  return best
}

/**
 * Pull a box that is being moved onto the safe area's lines: an edge of the box that comes within
 * `snapDist` of a safe edge sticks to it, and the box's centre sticks to the safe area's centre
 * lines. `box` is where the box is BEFORE the move, `dx`/`dy` the move the pointer asked for, and
 * `regions` (the app's guides, null where they do not apply) says what the box overlaps after it.
 */
export function safeSnap(
  box: SnapBox,
  dx: number,
  dy: number,
  safe: Rect,
  snapDist: number,
  regions: readonly GuideRegion[] | null = null,
): SafeSnapResult {
  const dist = Number.isFinite(snapDist) && snapDist > 0 ? snapDist : 0
  const axis = (min: number, max: number, move: number, from: number, size: number) => {
    const a = min + move
    const b = max + move
    const hit = dist > 0 ? pull([(a + b) / 2, a, b], [from + size / 2, from, from + size], dist) : null
    return { move: hit ? move + hit.delta : move, guide: hit ? hit.line : null }
  }
  const x = axis(box.minX, box.maxX, dx, safe.x, safe.w)
  const y = axis(box.minY, box.maxY, dy, safe.y, safe.h)
  const moved: SnapBox = { minX: box.minX + x.move, maxX: box.maxX + x.move, minY: box.minY + y.move, maxY: box.maxY + y.move }
  return { dx: x.move, dy: y.move, guideX: x.guide, guideY: y.guide, overlaps: guideRegionsHit(moved, regions) }
}
