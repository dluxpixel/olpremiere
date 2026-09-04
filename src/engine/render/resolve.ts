// The pure resolver: (Sequence, t) → RenderFrame. The single source of truth
// both the live preview and the export worker composite from. Its output IS
// their identity, so this file has NO GL, NO DOM, NO store, only engine types.
//
// Transforms live in sequence-NATIVE px; the renderer scales the raster so a
// 1920×1080 preview and a 1920×1080 export match proportionally.

import { contentBox, type ContentBox } from '../contentFrame'
import { resolveChannel } from '../effects/channels'
import { isNeutral, resolveEffect } from '../effects/registry'
import { clipDurationS, clipEndS } from '../timeline'
import { DEFAULT_SHUTTER_ANGLE, shutterSeconds } from './motionBlur'
import type { Clip, Sequence, Track, Transition } from '../types'
import {
  TRANSITION_KINDS,
  type RenderFrame,
  type RenderLayer,
  type RenderOp,
  type ResolvedEffect,
  type TransitionKind,
} from './types'

// Adjacency tolerance for "A's out edge touches B's in edge". Coarser than the
// timeline EPS because these times survive px→time round-trips (matches ADJ_EPS
// in timeline.ts).
const ADJ_EPS = 1e-6

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

const coerceKind = (type: string): TransitionKind =>
  (TRANSITION_KINDS as string[]).includes(type) ? (type as TransitionKind) : 'crossDissolve'

/**
 * Build a fully-resolved layer for `clip` at sequence time `t`. `sourceTimeS`
 * maps sequence time to source-media time (respecting |speed|); a still's
 * TextureSource ignores it. `isImage` is ALWAYS false here: resolve has no
 * MediaAsset, so the caller's TextureSource keys on assetId and handles stills.
 * `t` may lie past the clip's own [startS, endS) (a transition samples A past
 * its out point); the caller clamps to the source handles.
 */
function layerFor(clip: Clip, t: number, fps: number, shutterS = 0): RenderLayer {
  const localT = t - clip.startS
  const rate = Math.abs(clip.speed || 1)
  // Reverse (speed < 0): walk the source backward from outS as time advances.
  // A freeze holds one source second for the clip's whole length, and it wins
  // over both directions: frozen and reversed is still frozen.
  const sourceTimeS =
    clip.freezeAtS ?? (clip.speed < 0 ? clip.outS - localT * rate : clip.inS + localT * rate)
  // The clip's effect stack, sampled at this instant. A disabled or unknown
  // effect resolves to null; a neutral one is dropped because every GLSL body is
  // the identity at its defaults, so an ungraded clip compiles one program.
  const effects: ResolvedEffect[] = []
  for (const inst of clip.effects) {
    if (isNeutral(inst)) continue
    const resolved = resolveEffect(inst, localT)
    if (resolved) effects.push(resolved)
  }
  const transformAt = (at: number): RenderLayer['transform'] => ({
    x: resolveChannel(clip, 'posX', at),
    y: resolveChannel(clip, 'posY', at),
    scale: resolveChannel(clip, 'scale', at),
    rotationDeg: resolveChannel(clip, 'rotation', at),
    anchorX: resolveChannel(clip, 'anchorX', at),
    anchorY: resolveChannel(clip, 'anchorY', at),
    cropT: resolveChannel(clip, 'cropT', at),
    cropR: resolveChannel(clip, 'cropR', at),
    cropB: resolveChannel(clip, 'cropB', at),
    cropL: resolveChannel(clip, 'cropL', at),
  })
  // Where this same picture sits one shutter later. The renderer turns the
  // difference into the motion blur, because only it knows how many pixels a
  // scale change is worth. Skipped entirely for a clip with no keyframes: an
  // unanimated layer cannot move, so the second sample would be the first.
  // → engine/render/motionBlur.ts
  const animated = shutterS > 0 && clip.keyframes !== undefined && Object.keys(clip.keyframes).length > 0
  return {
    clipId: clip.id,
    assetId: clip.assetId,
    sourceTimeS,
    isImage: false,
    title: clip.title,
    speed: clip.speed,
    frameSeed: Math.round(t * fps),
    transform: transformAt(localT),
    ...(animated ? { transformAtShutter: transformAt(localT + shutterS) } : {}),
    opacity: clamp(resolveChannel(clip, 'opacity', localT), 0, 1),
    // ⛔ THE ONE DECISION, AND IT IS IN THE PURE RESOLVER ON PURPOSE. An
    // inverted-backdrop title is not a colour, it is a compositing operation, so
    // it resolves to the dest-sampling `invert` mode and overrides whatever blend
    // the clip carries. Decided HERE means the preview and the export worker
    // receive the identical RenderFrame and there is no second place that could
    // disagree. Nothing writes clip.blendMode, so the Inspector's blend dropdown
    // still shows exactly what he set.
    blendMode: clip.title?.invertBackdrop ? 'invert' : (clip.blendMode ?? 'normal'),
    mask: clip.mask,
    effects,
  }
}

/**
 * The "there is no clip here" side of a lone-edge transition: the same layer at
 * zero opacity, which the renderer draws into a fully transparent side FBO.
 * Copying the layer (rather than inventing an empty one) keeps the frame seed
 * and geometry the shaders read.
 *
 * It does NOT keep what makes a picture. A spread copy carried `assetId`,
 * `title` and the whole effect chain, so every frame of every lone-edge
 * transition decoded a video frame (or rasterized a full-frame caption canvas,
 * the expensive one) and ran the effect stack, to composite it at opacity 0
 * into a transparent buffer. The renderer's texture source returns null for a
 * layer with no asset and no title, and `renderSideToFbo` then early-returns
 * after the clear, which is the same transparent result for none of the work.
 */
const emptySide = (layer: RenderLayer): RenderLayer => ({
  ...layer,
  opacity: 0,
  assetId: '',
  title: undefined,
  effects: [],
})

/**
 * Kinds that must NOT run their solid form on a LONE edge, and fall through to
 * the opacity ramp instead.
 *
 * Dip to Black is the only one. The dip shader weights its solid by the sides'
 * coverage (`max(from.a, to.a)`), so with one side absent that weight collapses
 * to the clip's OWN alpha and the "dip" becomes an opaque black rectangle the
 * exact shape of the clip. On a PIP that paints a black box over the video
 * below, and a full-frame solid is not the answer either, because wiping the
 * lower tracks was itself a bug, fixed on 2026-07-25.
 *
 * Ramping the clip's own opacity is right on both tracks at once: the composite
 * background is black, so on V1 it is the same picture the dip always produced,
 * while on an upper track the overlay simply leaves (which is what a dip to
 * black means when there is nothing of your own to dip to).
 *
 * Dip to WHITE keeps its solid, because fading opacity there would reveal black,
 * which is not white. The asymmetry belongs to the colour, not to the rule.
 */
const LONE_EDGE_PREFERS_RAMP: ReadonlySet<TransitionKind> = new Set<TransitionKind>(['dipToBlack'])

/**
 * The effective transition of the pair (A → B): B's incoming wins, else A's
 * outgoing. Only meaningful when A and B are time-adjacent on one track.
 */
const pairTransition = (a: Clip, b: Clip) => b.transitionIn ?? a.transitionOut

/** Are these two clips edge-to-edge in time (A.out === B.in within tolerance)? */
const timeAdjacent = (a: Clip, b: Clip): boolean => Math.abs(clipEndS(a) - b.startS) < ADJ_EPS

/**
 * THE pair transition rule: is there a two-clip transition at B's head, and how
 * long does it really run? Null when there is not one.
 *
 * ⛔ THIS IS THE ONLY COPY. `preview.ts` used to carry a second one, written by
 * hand, with a comment asking whoever changed one to remember the other. They
 * happened to still agree when they were compared on 2026-08-12, which is luck,
 * not a property. The same shape one room over (a count of captionable clips
 * keeping its own copy of the door's rule) shipped a wrong number to him for
 * weeks: see the caption count fix of the same day. A promise in a comment is
 * not a promise.
 *
 * Adjustment clips NEVER form pair transitions: they have no texture, so a side
 * built from one is fully transparent, the partner would dissolve against
 * nothing and the grade would cut out. Their edges fall back to the lone-edge
 * fade, which correctly ramps the adjustment op's opacity.
 */
export function pairTransitionAt(a: Clip, b: Clip, fps: number): { tr: Transition; d: number } | null {
  if (!a.enabled || !b.enabled || a.adjustment || b.adjustment) return null
  if (!timeAdjacent(a, b)) return null
  const tr = pairTransition(a, b)
  if (!tr) return null
  const maxD = Math.min(clipDurationS(a), clipDurationS(b))
  return { tr, d: clamp(tr.durationS, 1 / fps, maxD) }
}

/**
 * Index of the LAST clip with startS <= t, or -1 when t precedes every clip.
 * track.clips is sorted by startS and never overlaps (types.ts invariant,
 * maintained by every timeline edit op and asserted in timeline.test.ts), so
 * this clip is the ONLY one whose span or transition window can contain t.
 * That turns the per-frame track scan from O(clips) into O(log clips). On a
 * word-caption timeline (one title clip per word) resolveFrame runs 60×/s in
 * preview and once per export frame, so this is the difference between
 * hundreds of comparisons per frame and ~10.
 */
function activeIndex(clips: readonly Clip[], t: number): number {
  let lo = 0
  let hi = clips.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (clips[mid].startS <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * Resolve one video track to at most one op at time `t`. Returns null when the
 * track shows nothing (no active clip, or the only candidate is fully inside a
 * transition it does not own).
 */
function resolveTrack(track: Track, t: number, fps: number, shutterS = 0): RenderOp | null {
  const clips = track.clips
  const i = activeIndex(clips, t)
  if (i >= 0) {
    const clip = clips[i]
    if (!clip.enabled) return null

    const prev = clips[i - 1] as Clip | undefined
    const next = clips[i + 1] as Clip | undefined

    // --- Transition INTO this clip (this clip is B). Its window sits at the
    // head of B and takes over from B's plain layer for its duration.
    // Adjustment clips NEVER form pair transitions: they have no texture, so a
    // side built from one is fully transparent: the partner would dissolve
    // against nothing and the grade would cut out. Their edges fall back to
    // the lone-edge fade, which correctly ramps the adjustment op's opacity. ---
    if (prev) {
      const pair = pairTransitionAt(prev, clip, fps)
      if (pair && t >= clip.startS && t < clip.startS + pair.d) {
        return {
          type: 'transition',
          kind: coerceKind(pair.tr.type),
          progress: (t - clip.startS) / pair.d,
          // A sampled PAST its out point (t is beyond A's end).
          from: layerFor(prev, t, fps, shutterS),
          to: layerFor(clip, t, fps, shutterS),
        }
      }
    }

    // --- This clip's own span. A two-clip transition window never overlaps a
    // clip's own [startS, endS) (the window lives at the NEXT clip's head), so
    // there is no double-draw. ---
    const endS = clipEndS(clip)
    if (t >= clip.startS && t < endS) {
      const layer = layerFor(clip, t, fps, shutterS)
      const dur = clipDurationS(clip)

      // A transitionIn/Out with NO partner clip still runs its REAL form: the
      // absent side is a fully transparent copy of this layer, so a wipe wipes
      // in over nothing, a slide slides in from off-frame, a dip dips through
      // its colour, and a cross dissolve resolves to exactly the opacity ramp
      // this used to hard-code for every kind. That fallback was the reason
      // applying "Glitch" to the head of the FIRST clip of a Short (the most
      // common place a Shorts editor wants a hit) silently produced a fade
      // from black while the Inspector went on saying "Glitch".
      // Adjustment clips keep the ramp: they have no texture, so a side built
      // from one is transparent and the grade would simply cut out.
      // A two-clip transition (handled above) beats this, so only apply when
      // the neighbor is absent or not adjacent.
      const hasPrevPartner = !!prev && prev.enabled && !prev.adjustment && !clip.adjustment && timeAdjacent(prev, clip)
      const hasNextPartner = !!next && next.enabled && !next.adjustment && !clip.adjustment && timeAdjacent(clip, next)

      if (clip.transitionIn && !hasPrevPartner) {
        const d = clamp(clip.transitionIn.durationS, 1 / fps, dur)
        if (t < clip.startS + d) {
          // whiteFlash is white → footage even with NO neighbor (an intro hit,
          // e.g. the first clip on the timeline), so it emits the transition op
          // instead of the lone-edge fade-from-black opacity ramp. The shader
          // ignores `from`, so the clip's own layer stands in for both sides.
          // Adjustment clips keep the ramp (they have no texture to flash to).
          if (clip.transitionIn.type === 'whiteFlash' && !clip.adjustment) {
            return {
              type: 'transition',
              kind: 'whiteFlash',
              progress: (t - clip.startS) / d,
              from: layer,
              to: layer,
            }
          }
          // ...but only when this instant belongs to the IN edge ALONE. Every
          // window clamps to the clip's own length independently, so on a short
          // clip the in edge can overlap the out edge or the fade-out handle,
          // and one op per track means returning here would silence them for
          // that whole span, popping the picture mid-clip. Inside an overlap
          // both edges fall through to the opacity ramps below, which compose
          // smoothly instead.
          const outD =
            clip.transitionOut && !hasNextPartner ? clamp(clip.transitionOut.durationS, 1 / fps, dur) : 0
          const outEdgeStartsAt = Math.min(
            outD > 0 ? endS - outD : Infinity,
            clip.fadeOutS > 0 ? endS - clip.fadeOutS : Infinity,
          )
          if (
            !clip.adjustment &&
            t < outEdgeStartsAt &&
            !LONE_EDGE_PREFERS_RAMP.has(coerceKind(clip.transitionIn.type))
          ) {
            return {
              type: 'transition',
              kind: coerceKind(clip.transitionIn.type),
              progress: (t - clip.startS) / d,
              from: emptySide(layer),
              to: layer,
            }
          }
          layer.opacity = clamp(layer.opacity * ((t - clip.startS) / d), 0, 1)
        }
      }
      if (clip.transitionOut && !hasNextPartner) {
        const d = clamp(clip.transitionOut.durationS, 1 / fps, dur)
        if (t >= endS - d) {
          // The outro mirror of the intro case above: footage → full white as
          // the video ends, instead of the fade-to-black ramp. INVERTED
          // progress feeds the same shader curve: alpha=(1-progress)² becomes
          // pOut², so the white accelerates in and lands at 1 exactly at the
          // end. Between two clips this branch never runs (the pair window at
          // B's head owns the cut, where the flash lands as a white hit).
          if (clip.transitionOut.type === 'whiteFlash' && !clip.adjustment) {
            return {
              type: 'transition',
              kind: 'whiteFlash',
              progress: 1 - (t - (endS - d)) / d,
              from: layer,
              to: layer,
            }
          }
          if (!clip.adjustment && !LONE_EDGE_PREFERS_RAMP.has(coerceKind(clip.transitionOut.type))) {
            return {
              type: 'transition',
              kind: coerceKind(clip.transitionOut.type),
              progress: (t - (endS - d)) / d,
              from: layer,
              to: emptySide(layer),
            }
          }
          layer.opacity = clamp(layer.opacity * ((endS - t) / d), 0, 1)
        }
      }

      // Clip fade handles fade OPACITY too (the visual analogue of the audio
      // gain fade), so a picture/video/title fades in and out. Same fadeInS/
      // fadeOutS fields, one shared renderer → preview == export.
      // Skip the edge whose lone-edge transition (above) ALREADY scaled opacity,
      // or the two would multiply and the picture would fade quadratically.
      if (clip.fadeInS > 0 && !(clip.transitionIn && !hasPrevPartner) && t < clip.startS + clip.fadeInS) {
        layer.opacity = clamp(layer.opacity * ((t - clip.startS) / clip.fadeInS), 0, 1)
      }
      if (clip.fadeOutS > 0 && !(clip.transitionOut && !hasNextPartner) && t >= endS - clip.fadeOutS) {
        layer.opacity = clamp(layer.opacity * ((endS - t) / clip.fadeOutS), 0, 1)
      }

      // An adjustment clip converts to an adjustment op AFTER the fade math, so
      // fading an adjustment layer fades its grade in/out (opacity scales it).
      if (clip.adjustment) {
        return {
          type: 'adjustment',
          effects: layer.effects,
          opacity: layer.opacity,
          mask: layer.mask,
          frameSeed: layer.frameSeed,
        }
      }

      return { type: 'layer', layer }
    }
  }
  return null
}

/** Test-only export: proves activeIndex agrees with a linear scan. */
export const _activeIndexForTest = activeIndex

/**
 * Resolve the whole sequence at time `t` into an ordered draw list. Ops are
 * bottom→top: a lower video track (earlier in seq.tracks) appears earlier in
 * the array. Audio tracks and muted video tracks contribute nothing visual.
 */
/**
 * Lay one layer out inside the inner content box instead of the whole frame.
 *
 * ⛔ PICTURE LAYERS ONLY, NEVER TITLES. A title is rasterized at the sequence
 * size and drawn as a full-frame quad, so squeezing that quad into the box
 * would scale the type down rather than lay it out inside. Leaving titles on
 * the full frame is also the more useful answer: it is what lets him put a
 * caption in the band above or below the square, which is half of why anyone
 * uses this look.
 */
function inFrame(layer: RenderLayer, box: ContentBox): RenderLayer {
  if (layer.title !== undefined) return layer
  return {
    ...layer,
    transform: { ...layer.transform, frame: box },
    // The motion-blur sample is the same picture half a frame later, so it is
    // laid out in the same box or the smear pulls out of it.
    ...(layer.transformAtShutter
      ? { transformAtShutter: { ...layer.transformAtShutter, frame: box } }
      : {}),
  }
}

export function resolveFrame(seq: Sequence, t: number): RenderFrame {
  const ops: RenderOp[] = []
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    const op = resolveTrack(track, t, seq.fps, shutterSeconds(seq.shutterAngle ?? DEFAULT_SHUTTER_ANGLE, seq.fps))
    if (op) ops.push(op)
  }
  // The inner content box, if this sequence has one. Computed ONCE here and
  // stamped onto each picture layer, so nothing downstream has to know the
  // sequence exists.
  const box = contentBox(seq.width, seq.height, seq.contentAspect)
  const framed = box
    ? ops.map((op) =>
        op.type === 'layer'
          ? { ...op, layer: inFrame(op.layer, box) }
          : op.type === 'transition'
            ? { ...op, from: inFrame(op.from, box), to: inFrame(op.to, box) }
            : op,
      )
    : ops

  // ⛔ THE BACKDROP IS BUILT FROM THE UNFRAMED OPS AND UNSHIFTED AFTERWARDS.
  // It is the thing that FILLS the bands the content box creates, so it has to
  // stay full-frame. Reading it off `ops` rather than `framed` is what makes
  // that structural instead of remembered.
  const backdrop = seq.blurBackground ? blurBackdropOp(ops, seq.blurBackdropZoom ?? BACKDROP_ZOOM) : null
  if (backdrop) framed.unshift(backdrop)
  return { width: seq.width, height: seq.height, ops: framed }
}

/** Blur radius for the backdrop, in sequence px. The renderer caps at 64. */
export const BLUR_BACKDROP_PX = 64

/**
 * How far past cover-fit the backdrop is grown, before the blur.
 *
 * ⛔ COVER ALONE PUTS THE HUD IN THE BAND. A 16:9 frame cover-fitted into a 9:16
 * short spans the full height, so the BOTTOM of the source lands in the bottom
 * band, and on Minecraft footage the bottom of the source is the hotbar and the
 * hearts. Blurred at 48 they stayed obviously a hotbar: ten little boxes and a
 * row of red, smeared but readable, which is exactly what his own shorts showed
 * and what the reference channel's never do.
 *
 * 1.4 keeps the middle ~71% of the source height, so everything below about the
 * bottom 14% is cropped away before the blur ever runs. The HUD sits inside the
 * bottom 12% of a Minecraft frame, so it is gone rather than smeared, and the
 * band is the SCENE out of focus, which is the look being matched.
 *
 * It also raises the magnification of what is left, which softens the band on
 * its own, and that is why the two numbers were chosen together.
 */
export const BACKDROP_ZOOM = 1.4

/** The band's own envelope. 1 is plain cover-fit, which is where the HUD creeps in. */
export const BLUR_BACKDROP_ZOOM = { min: 1, max: 3, step: 0.05, sens: 0.01 } as const

/**
 * The blurred fill that sits behind everything, built from the picture already
 * being drawn. Returns null when there is nothing to blur.
 *
 * ⛔ IT COMES FROM THE BOTTOM-MOST LAYER, NOT FROM EVERY LAYER. Giving each clip
 * its own backdrop would stack them, and an overlay on V2 would hide the
 * gameplay on V1 behind that overlay's own blur. One backdrop, from the picture
 * underneath everything, is also what the look actually is. **Mine, not his:**
 * he asked for the effect, not for which layer feeds it.
 *
 * ⛔ IT IGNORES THE CLIP'S TRANSFORM, AND THAT IS THE WHOLE FEATURE. Position,
 * scale and rotation are dropped so the backdrop stays still and full-frame
 * while the clip in front of it moves. That is exactly what he asked for: a
 * keyframed zoom out reveals more blur instead of more black. Carrying the
 * transform through would shrink the backdrop in step and put the bars right
 * back.
 *
 * The CROP is dropped with them, so a cropped clip still blurs its whole frame
 * rather than a blurred sliver stretched over the screen.
 */
function blurBackdropOp(ops: readonly RenderOp[], zoom: number): RenderOp | null {
  const bottom = ops[0]
  const source =
    bottom?.type === 'layer' ? bottom.layer : bottom?.type === 'transition' ? bottom.to : null
  // Nothing with a picture in it: a title has no frame worth blurring, and an
  // empty side of a lone-edge transition has no asset at all.
  if (!source || !source.assetId || source.title !== undefined) return null
  return {
    type: 'layer',
    layer: {
      ...source,
      // ⛔ THE REAL CLIP'S ID, NEVER A MADE-UP ONE. This carried
      // `${clipId}:blur-backdrop` for one version and the export came out with
      // the black bars still on it: `exportWorker.ts:413` finds a layer's video
      // by looking its clipId up in a map of the sequence's clips, so a
      // synthetic id found nothing, drew nothing, and left the frame empty
      // exactly where the blur was supposed to be. The preview reaches its
      // picture another way, which is why it looked right on his screen and
      // wrong in the file. Sharing the id is safe: textures are cached by
      // source and the texture map is keyed by the layer object, not by id.
      clipId: source.clipId,
      transform: {
        ...source.transform,
        x: 0,
        y: 0,
        // Past cover on purpose, so the HUD never reaches the band. His number
        // now, per sequence, defaulting to BACKDROP_ZOOM.
        scale: zoom,
        rotationDeg: 0,
        cropT: 0,
        cropR: 0,
        cropB: 0,
        cropL: 0,
        fit: 'cover',
        // ⛔ NEVER THE INNER CONTENT BOX. The transform is spread from the
        // source layer, so if that layer were ever framed this would inherit
        // the box and the backdrop would stop filling the very bands it
        // exists to fill. resolveFrame already feeds this the unframed ops;
        // this line means a reordering there cannot break it silently.
        frame: undefined,
      },
      opacity: 1,
      blendMode: 'normal',
      mask: undefined,
      // Its own stack, not the clip's: a green screen or a colour grade on the
      // gameplay has no business deciding what the wallpaper behind it looks
      // like, and a chroma key would punch a hole straight through it.
      effects: [{ type: 'gaussianBlur', params: { blur: BLUR_BACKDROP_PX } }],
    },
  }
}
