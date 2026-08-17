// Motion blur DERIVED from his keyframes, rather than an effect he has to add.
//
// His ask, 2026-08-17: *"how do these good YouTubers make the extremely good
// edits?"* Researched the same day, and the answer is one sentence that appears
// everywhere: an animation with no motion blur looks computer generated, because a
// real camera smears whatever moves while its shutter is open. After Effects has
// ONE switch for it, it samples the animated properties over time, and the film
// standard is a 180 degree shutter.
//
// ⛔ WHY DERIVED AND NOT AUTHORED. He performs a move by hand and saves it as his
// own tile. A blur he adds afterwards is a second job he will forget, and it would
// need re-tuning every time the move is stretched onto a different clip. Taken from
// the motion, it is simply correct for the built in ten, for every move he records
// tomorrow, and for a keyframe he drags by two pixels.
//
// The measurement is the QUAD, not the channels. `computeQuad` already turns scale,
// position, rotation, crop, fit and anchor into four corners in sequence pixels, so
// comparing the quad now against the quad one shutter later catches every one of
// them at once and cannot drift out of step with what is actually drawn.

/** Four corners in sequence pixels, TL TR BR BL, straight from `computeQuad`. */
export type Quad = readonly (readonly [number, number])[]

export interface DerivedBlur {
  /** Direction the picture travelled, degrees, 0 = to the right. */
  angleDeg: number
  /** How far it travelled during the shutter, in sequence pixels. */
  translatePx: number
  /** How much its radius GREW during the shutter, in sequence pixels. Negative when pulling back. */
  radialPx: number
}

/**
 * Under this much movement there is no blur at all.
 *
 * ⛔ NOT a performance tweak, though it is also that. A slow push and a locked off
 * shot must stay razor sharp: smearing a still picture by a third of a pixel is
 * how "cinematic" becomes "soft", and he would feel it as the app being blurry
 * rather than as a move being fast. One and a half pixels is under a frame of
 * travel on anything he would call a move.
 */
export const BLUR_FLOOR_PX = 1.5

/** The quad's centre in sequence pixels. Exported: the renderer needs it for the smear origin. */
export const quadCentre = (q: Quad): [number, number] => {
  let x = 0
  let y = 0
  for (const [cx, cy] of q) {
    x += cx
    y += cy
  }
  return [x / q.length, y / q.length]
}

/**
 * Mean distance from the quad's own centre: its size, independent of where it sits.
 *
 * Exported so the renderer can turn a radius CHANGE in pixels into a fraction of the
 * radius, which is what makes a punch smear identically on a 1080 and a 4K sequence.
 */
export const quadRadius = (q: Quad, centre: [number, number] = quadCentre(q)): number => {
  let r = 0
  for (const [x, y] of q) r += Math.hypot(x - centre[0], y - centre[1])
  return r / q.length
}

/**
 * The smear between two quads, or null when neither term clears the floor.
 *
 * Decomposed into exactly the two smears the renderer can draw:
 *   - the centre MOVING is a directional blur along that direction
 *   - the radius GROWING is a radial blur out of the centre, which is what a punch
 *     in actually does to a picture
 *
 * ⚠️ ROTATION IS NOT COVERED, and that is stated rather than hidden. A pure spin
 * moves no centre and changes no radius, so this returns null for it. The true
 * smear there is angular and the renderer has no angular blur; a spin fast enough
 * to need one is not in any of the eleven moves. If one is ever added, the residual
 * after removing translation and scale is where the rotation term lives.
 */
export function deriveMotionBlur(a: Quad, b: Quad): DerivedBlur | null {
  if (a.length !== 4 || b.length !== 4) return null
  const ca = quadCentre(a)
  const cb = quadCentre(b)
  const dx = cb[0] - ca[0]
  const dy = cb[1] - ca[1]
  const translatePx = Math.hypot(dx, dy)
  const radialPx = quadRadius(b, cb) - quadRadius(a, ca)

  if (translatePx < BLUR_FLOOR_PX && Math.abs(radialPx) < BLUR_FLOOR_PX) return null
  return {
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    translatePx: translatePx < BLUR_FLOOR_PX ? 0 : translatePx,
    radialPx: Math.abs(radialPx) < BLUR_FLOOR_PX ? 0 : radialPx,
  }
}

/**
 * Seconds the shutter stays open for one frame at a given angle.
 *
 * 180 degrees is half a frame, which is the film standard and the After Effects
 * default. 0 means the feature is off.
 */
export const shutterSeconds = (shutterAngleDeg: number, fps: number): number =>
  fps > 0 ? Math.max(0, shutterAngleDeg) / 360 / fps : 0

/**
 * ON by default, at the film standard.
 *
 * ⛔ AND THAT CHANGES HOW HIS EXISTING PROJECTS RENDER, which is stated plainly
 * rather than buried: every project on his disk that carries a move will now smear
 * where it used to be sharp. That is the point, it is what he asked for on
 * 2026-08-17, and it is one number away from off. Defaulting it to off would mean
 * the feature exists and his edits still look computer generated.
 */
export const DEFAULT_SHUTTER_ANGLE = 180

/**
 * The scrub field's range. 0 is off and 360 is a shutter open for the whole frame,
 * which is as wide as a shutter physically goes.
 *
 * The step is 15 rather than 1 because nobody can see a degree of shutter, and the
 * numbers editors actually talk about are 90, 180 and 360.
 */
export const SHUTTER_ANGLE = { min: 0, max: 360, step: 15, sens: 1 } as const
