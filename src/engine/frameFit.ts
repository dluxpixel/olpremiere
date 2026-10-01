// Fit, Fill or Stretch: how a picture of another shape takes the frame.
//
// His ask, 2026-09-29: *"make it so when i for example paste in a 4:3clip it
// stretches to 16:9 when i select to"*.
//
// ⛔ FIT AND FILL ARE NOT STORED, AND THAT IS WHY EVERY OLD PROJECT OPENS
// UNCHANGED. They have always been the clip's SCALE: 1 is the renderer's fit
// (the whole picture inside the frame, bars where the shapes disagree), and the
// fill ratio is the fill every new clip already lands with (fitNewClipToFrame
// and the format switch, timeline.ts). STRETCH is the one framing no single
// scale can reach, so it is the only new state: `transform.fit = 'stretch'`,
// which `computeQuad` reads to lay the picture onto the box's own four corners.
//
// Picking one sets the clip's RESTING size to that framing, which is what the
// three names promise. Position, rotation, anchor and crop are left exactly as
// he set them, and a zoom keyframed on the scale keeps its shape, measured from
// the new rest: the same "rebase from the lowest keyframe" rule the format
// switch already uses for a punch in, so a punch on a filled clip is still the
// same punch on the stretched one.
//
// Pure: no store, no DOM. The two doors (the Inspector row and the clip menu,
// one clip or a whole selection) are in state/clipEdits.ts and state/bulkEdits.ts.

import { applyAppearanceToClip } from './anim/appearance'
import { contentBox } from './contentFrame'
import type { Clip, MediaAsset, Sequence } from './types'

export type FrameFit = 'fit' | 'fill' | 'stretch'

/** The three choices, in the order he reads them, with the words he is shown. */
export const FRAME_FITS: readonly { fit: FrameFit; label: string; hint: string }[] = [
  { fit: 'fit', label: 'Fit inside', hint: 'The whole picture shows, with bars where its shape and the frame differ' },
  { fit: 'fill', label: 'Fill and crop', hint: 'Fills the frame and cuts off what does not fit' },
  { fit: 'stretch', label: 'Stretch to fill', hint: "Fills the frame exactly: nothing is cut off, the picture takes the frame's shape" },
]

/** Everything the arithmetic needs, read once from the sequence and the clip's media. */
export interface FrameFitDims {
  /** The picture's own size. 0 when it is not known yet. */
  srcW: number
  srcH: number
  /** The box the clip is laid out in: the inner content box when there is one, else the frame. */
  boxW: number
  boxH: number
  /** The sequence itself, which an entrance animation is compiled against. */
  seqW: number
  seqH: number
}

/**
 * The sizes for one clip. The box is the one the resolver stamps on the layer
 * (`contentBox`, the same pure function), so "fill" here fills the exact
 * rectangle the renderer will lay the picture out in.
 */
export function frameFitDims(
  seq: Pick<Sequence, 'width' | 'height' | 'contentAspect'>,
  asset: Pick<MediaAsset, 'width' | 'height'> | undefined,
): FrameFitDims {
  const box = contentBox(seq.width, seq.height, seq.contentAspect)
  return {
    srcW: asset?.width ?? 0,
    srcH: asset?.height ?? 0,
    boxW: box ? box.w : seq.width,
    boxH: box ? box.h : seq.height,
    seqW: seq.width,
    seqH: seq.height,
  }
}

/**
 * The scale that turns the fit into a fill: cover over contain, the exact
 * number fitNewClipToFrame gives a new clip. 1 when the shapes agree, and 1 when
 * the size is not known, so an unknown picture is never blown up by a guess.
 */
export function fillScale(d: Pick<FrameFitDims, 'srcW' | 'srcH' | 'boxW' | 'boxH'>): number {
  if (!(d.srcW > 0 && d.srcH > 0 && d.boxW > 0 && d.boxH > 0)) return 1
  const contain = Math.min(d.boxW / d.srcW, d.boxH / d.srcH)
  return Math.max(d.boxW / d.srcW, d.boxH / d.srcH) / contain
}

/** Only a picture takes a frame fit. A title is drawn at the frame's own size, and an adjustment layer has no picture. */
export const takesFrameFit = (clip: Clip): boolean => clip.title === undefined && clip.adjustment !== true

// Same tolerance refitClipToFill uses to recognise its own work.
const SAME = 1e-6

/**
 * Where the clip's size comes to rest: its static scale, or the lowest keyframe
 * of a zoom (the baseline refitClipToFill reads). An entrance animation's
 * keyframes are compiled FROM the static scale, so for those the static scale
 * is the rest and the keyframes are rebuilt rather than rescaled.
 */
function restingScale(clip: Clip): number {
  const kfs = clip.keyframes?.scale
  if (!clip.appearance && kfs && kfs.length > 0) return Math.min(...kfs.map((k) => k.value))
  return clip.transform.scale
}

/**
 * Which of the three the clip shows right now, or null for a size he set by
 * hand that is none of them (the Inspector says "Custom size").
 *
 * When the picture is already the frame's shape, fit and fill are the same
 * picture; it answers fill, which is what a new clip is said to land as.
 */
export function frameFitOf(clip: Clip, d: FrameFitDims): FrameFit | null {
  if (!takesFrameFit(clip)) return null
  if (clip.transform.fit === 'stretch') return 'stretch'
  const rest = restingScale(clip)
  if (Math.abs(rest - fillScale(d)) < SAME) return 'fill'
  if (Math.abs(rest - 1) < SAME) return 'fit'
  return null
}

/**
 * The clip with `fit` picked. Returns the SAME clip when it already shows that
 * framing at that size, so picking it twice costs no undo step.
 *
 * ⛔ THE STRETCH KEY IS REMOVED, NEVER SET TO UNDEFINED, when he goes back to
 * fit or fill. A clip taken to stretch and back is then the very object shape
 * it started as, and a project file never carries a key that means nothing.
 */
export function withFrameFit(clip: Clip, fit: FrameFit, d: FrameFitDims): Clip {
  if (!takesFrameFit(clip)) return clip
  const target = fit === 'fill' ? fillScale(d) : 1
  const rest = restingScale(clip)
  // Nothing would change: the same stretch or none, at the same resting size.
  // On a picture that is already the frame's shape fit and fill are one picture,
  // so moving between them is a no op too rather than an empty undo step.
  if ((clip.transform.fit === 'stretch') === (fit === 'stretch') && Math.abs(rest - target) < SAME) return clip

  const transform: Clip['transform'] = { ...clip.transform, scale: target }
  if (fit === 'stretch') transform.fit = 'stretch'
  else delete transform.fit
  const next: Clip = { ...clip, transform }

  // An entrance or exit animation owns the scale keyframes and is compiled from
  // the base, so it is rebuilt on the new base, the same thing a drag in the
  // monitor does (setClipTransform).
  if (clip.appearance) return applyAppearanceToClip(next, clip.appearance, d.seqW, d.seqH)

  // A zoom keeps its shape: every keyframe moves by the same factor, so its
  // lowest one lands on the new rest. A zoom that passes through 0 has no rest
  // to measure from, and is left exactly as he drew it.
  const kfs = clip.keyframes?.scale
  if (kfs && kfs.length > 0 && rest > SAME) {
    const k = target / rest
    return { ...next, keyframes: { ...clip.keyframes, scale: kfs.map((kf) => ({ ...kf, value: kf.value * k })) } }
  }
  return next
}
