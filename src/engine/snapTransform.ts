// Snapping for a move in the program monitor.
//
// His words, 2026-08-12: "Make it so it fits to the corner when I'm moving the
// video. Also, when I'm moving multiple texts using right-click and drag text,
// make it so it has these auto points too."
//
// The monitor already snapped to the frame CENTRE and to nothing else, so a clip
// could be nudged to a corner by eye and never actually land on it. Corners are
// the placement that has to be exact, because a picture-in-picture or a caption
// sitting one pixel off the edge shows a seam.

/** A clip's on-screen bounding box in SEQUENCE pixels (not screen pixels). */
export interface SnapBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface SnapResult {
  x: number
  y: number
  /**
   * Where to draw the guide, in SEQUENCE pixels along each axis, or null when
   * that axis is not snapped. The caller scales it to the screen.
   */
  guideX: number | null
  guideY: number | null
}

/** The nearest candidate within `tol`, or null. Ties go to the earlier one. */
function nearest(v: number, candidates: { at: number; guide: number }[], tol: number): { at: number; guide: number } | null {
  let best: { at: number; guide: number } | null = null
  let bestD = tol
  for (const c of candidates) {
    const d = Math.abs(v - c.at)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/**
 * Snap a move so the clip lands flush with the frame.
 *
 * `x`/`y` are the transform's offsets from frame centre, the same units the
 * gizmo drags in. `startBox` is where the clip's box sat when the drag began,
 * and `startX`/`startY` are the offsets it sat at, which is what lets a box
 * measured once at drag start follow the pointer: **a move is a translation, so
 * the box's size never changes and only its origin does.** Measuring it once
 * also stops the snap feeding back into itself, which is what happens if the box
 * is re-read from an already-snapped position on the next pointer event.
 *
 * Each axis snaps independently, so a corner is not a special case: it is the
 * left edge and the top edge both catching at once. That is also why "fits to
 * the corner" and "fits to an edge" need no separate code.
 */
export function snapTransformMove(
  x: number,
  y: number,
  startX: number,
  startY: number,
  startBox: SnapBox,
  frameW: number,
  frameH: number,
  tol: number,
): SnapResult {
  // How far x must travel from its start for the named edge to land on target.
  const dxFor = (boxEdge: number, target: number) => startX + (target - boxEdge)
  const dyFor = (boxEdge: number, target: number) => startY + (target - boxEdge)
  const boxCx = (startBox.minX + startBox.maxX) / 2
  const boxCy = (startBox.minY + startBox.maxY) / 2

  const sx = nearest(
    x,
    [
      // Centre first so it wins a tie against an edge, which is the older
      // behaviour and the one his muscle memory already has.
      { at: dxFor(boxCx, frameW / 2), guide: frameW / 2 },
      { at: dxFor(startBox.minX, 0), guide: 0 },
      { at: dxFor(startBox.maxX, frameW), guide: frameW },
    ],
    tol,
  )
  const sy = nearest(
    y,
    [
      { at: dyFor(boxCy, frameH / 2), guide: frameH / 2 },
      { at: dyFor(startBox.minY, 0), guide: 0 },
      { at: dyFor(startBox.maxY, frameH), guide: frameH },
    ],
    tol,
  )

  return {
    x: sx ? sx.at : x,
    y: sy ? sy.at : y,
    guideX: sx ? sx.guide : null,
    guideY: sy ? sy.guide : null,
  }
}

/** The clip box in sequence pixels, from the quad the gizmo already computes. */
export function boxFromQuad(corners: [number, number][]): SnapBox {
  const xs = corners.map(([cx]) => cx)
  const ys = corners.map(([, cy]) => cy)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
