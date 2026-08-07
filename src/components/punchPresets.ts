// The saved move chips and the headroom ceiling, kept out of PunchControl.tsx
// so both are unit-testable without the React tree the Motion block lives in.
// The same split motionRuler.ts makes for the rail and monitorSizing.ts for the
// program monitor.
//
// A saved chip used to be a bare number, because a zoom used to be one number.
// A move is three things now (how deep, how many frames to get there, on what
// curve), so a chip carries all three. The numbers already sitting in his
// browser under this key are still bare numbers, so they are READ FORWARD into
// the new shape rather than dropped: a preset he saved months ago keeps working
// and simply acquires the default rise and the default curve.

import { MOTION_CURVES, type MotionCurveName } from '../engine/motion'

/** Where the chips live. Unchanged from when they were bare numbers, on purpose. */
export const ZOOM_PRESETS_KEY = 'olpremiere:zoomPresets'

/** How many chips the row keeps. Past this the oldest drops off the front. */
export const MAX_ZOOM_PRESETS = 6

/** The rise a bare saved number is read forward with: the 200ms default, in frames. */
export const LEGACY_RISE_FRAMES = 5
/** The curve a bare saved number is read forward with: the default move curve. */
export const LEGACY_CURVE: MotionCurveName = 'snapIn'

/** Depth range, matching the custom-depth field. */
export const DEPTH_MIN = 1.01
export const DEPTH_MAX = 4
/** Rise range in whole frames. One frame is the shortest rise that is still a rise. */
export const RISE_MIN = 1
export const RISE_MAX = 60

/** One saved move: how deep, how long it takes to arrive, and on what curve. */
export interface ZoomPreset {
  scale: number
  riseFrames: number
  curve: MotionCurveName
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * One stored entry, in either shape. Anything unreadable returns null rather
 * than a preset built out of NaN, which would put a punch at an undefined depth
 * the moment he clicked the chip.
 */
function readPreset(raw: unknown): ZoomPreset | null {
  if (typeof raw === 'number') {
    // The legacy shape: the depth alone.
    if (!Number.isFinite(raw)) return null
    return { scale: clamp(raw, DEPTH_MIN, DEPTH_MAX), riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE }
  }
  if (!raw || typeof raw !== 'object') return null
  const { scale, riseFrames, curve } = raw as { scale?: unknown; riseFrames?: unknown; curve?: unknown }
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return null
  return {
    scale: clamp(scale, DEPTH_MIN, DEPTH_MAX),
    riseFrames:
      typeof riseFrames === 'number' && Number.isFinite(riseFrames)
        ? clamp(Math.round(riseFrames), RISE_MIN, RISE_MAX)
        : LEGACY_RISE_FRAMES,
    // Validated against the one curve table: a name from an older or newer build
    // falls back rather than reaching the builders as undefined.
    curve: typeof curve === 'string' && Object.hasOwn(MOTION_CURVES, curve) ? (curve as MotionCurveName) : LEGACY_CURVE,
  }
}

/** Parse the stored JSON. Corrupt storage reads as "no chips", never as a throw. */
export function parsePresets(raw: string | null): ZoomPreset[] {
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const out: ZoomPreset[] = []
    for (const entry of arr) {
      const p = readPreset(entry)
      if (p) out.push(p)
    }
    return out.slice(-MAX_ZOOM_PRESETS)
  } catch {
    return []
  }
}

/** Two chips are the same move when all three numbers match. */
export const samePreset = (a: ZoomPreset, b: ZoomPreset): boolean =>
  Math.abs(a.scale - b.scale) < 5e-3 && a.riseFrames === b.riseFrames && a.curve === b.curve

/** Read the chips. Private mode or a locked profile reads as none. */
export function loadPresets(): ZoomPreset[] {
  try {
    return parsePresets(typeof localStorage !== 'undefined' ? localStorage.getItem(ZOOM_PRESETS_KEY) : null)
  } catch {
    return []
  }
}

/** Write the chips back in the new shape. */
export function savePresets(list: ZoomPreset[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ZOOM_PRESETS_KEY, JSON.stringify(list))
  } catch {
    // Private mode / quota: the chips still work for the rest of this run.
  }
}

/**
 * How far this clip can be pushed before the punch is upscaling: the source's
 * own width over the sequence's. 4K into a 1080p sequence is 200 percent;
 * native 1080p is 100 percent, which means every punch on it is already soft.
 *
 * Null when there is no source width to divide by (a title, an audio clip), and
 * a number nobody can stand behind is worse than no number at all.
 */
export function headroomCeiling(assetWidth: number | undefined, seqWidth: number): number | null {
  if (typeof assetWidth !== 'number' || !Number.isFinite(assetWidth) || assetWidth <= 0) return null
  if (!Number.isFinite(seqWidth) || seqWidth <= 0) return null
  return assetWidth / seqWidth
}

/**
 * Past the ceiling the picture is being upscaled and starts to soften. Nothing
 * stops him punching a 1080p source to 170 percent today, and the softness only
 * turns up on export. This WARNS. It never blocks: an upscaled punch is a real
 * choice, and on a shot he needs it is the right one.
 */
export const overHeadroom = (depth: number, ceiling: number | null): boolean =>
  ceiling !== null && depth > ceiling + 5e-3
