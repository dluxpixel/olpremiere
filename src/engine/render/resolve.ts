// The pure resolver: (Sequence, t) → RenderFrame. The single source of truth
// both the live preview and the export worker composite from — its output IS
// their identity, so this file has NO GL, NO DOM, NO store, only engine types.
//
// Transforms live in sequence-NATIVE px; the renderer scales the raster so a
// 1920×1080 preview and a 1920×1080 export match proportionally.

import { resolveChannel } from '../effects/channels'
import { isNeutral, resolveEffect } from '../effects/registry'
import { clipDurationS, clipEndS } from '../timeline'
import type { Clip, Sequence, Track } from '../types'
import {
  TRANSITION_KINDS,
  type RenderFrame,
  type RenderLayer,
  type RenderOp,
  type ResolvedEffect,
  type TransitionKind,
} from './types'

// Adjacency tolerance for "A's out edge touches B's in edge" — coarser than the
// timeline EPS because these times survive px→time round-trips (matches ADJ_EPS
// in timeline.ts).
const ADJ_EPS = 1e-6

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

const coerceKind = (type: string): TransitionKind =>
  (TRANSITION_KINDS as string[]).includes(type) ? (type as TransitionKind) : 'crossDissolve'

/**
 * Build a fully-resolved layer for `clip` at sequence time `t`. `sourceTimeS`
 * maps sequence time to source-media time (respecting |speed|); a still's
 * TextureSource ignores it. `isImage` is ALWAYS false here — resolve has no
 * MediaAsset, so the caller's TextureSource keys on assetId and handles stills.
 * `t` may lie past the clip's own [startS, endS) (a transition samples A past
 * its out point); the caller clamps to the source handles.
 */
function layerFor(clip: Clip, t: number): RenderLayer {
  const localT = t - clip.startS
  const rate = Math.abs(clip.speed || 1)
  // Reverse (speed < 0): walk the source backward from outS as time advances.
  const sourceTimeS = clip.speed < 0 ? clip.outS - localT * rate : clip.inS + localT * rate
  // The clip's effect stack, sampled at this instant. A disabled or unknown
  // effect resolves to null; a neutral one is dropped because every GLSL body is
  // the identity at its defaults, so an ungraded clip compiles one program.
  const effects: ResolvedEffect[] = []
  for (const inst of clip.effects) {
    if (isNeutral(inst)) continue
    const resolved = resolveEffect(inst, localT)
    if (resolved) effects.push(resolved)
  }
  return {
    clipId: clip.id,
    assetId: clip.assetId,
    sourceTimeS,
    isImage: false,
    title: clip.title,
    transform: {
      x: resolveChannel(clip, 'posX', localT),
      y: resolveChannel(clip, 'posY', localT),
      scale: resolveChannel(clip, 'scale', localT),
      rotationDeg: resolveChannel(clip, 'rotation', localT),
      anchorX: resolveChannel(clip, 'anchorX', localT),
      anchorY: resolveChannel(clip, 'anchorY', localT),
      cropT: resolveChannel(clip, 'cropT', localT),
      cropR: resolveChannel(clip, 'cropR', localT),
      cropB: resolveChannel(clip, 'cropB', localT),
      cropL: resolveChannel(clip, 'cropL', localT),
    },
    opacity: clamp(resolveChannel(clip, 'opacity', localT), 0, 1),
    effects,
  }
}

/**
 * The effective transition of the pair (A → B): B's incoming wins, else A's
 * outgoing. Only meaningful when A and B are time-adjacent on one track.
 */
const pairTransition = (a: Clip, b: Clip) => b.transitionIn ?? a.transitionOut

/** Are these two clips edge-to-edge in time (A.out === B.in within tolerance)? */
const timeAdjacent = (a: Clip, b: Clip): boolean => Math.abs(clipEndS(a) - b.startS) < ADJ_EPS

/**
 * Resolve one video track to at most one op at time `t`. Returns null when the
 * track shows nothing (no active clip, or the only candidate is fully inside a
 * transition it does not own).
 */
function resolveTrack(track: Track, t: number, fps: number): RenderOp | null {
  const clips = track.clips
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (!clip.enabled) continue

    const prev = clips[i - 1] as Clip | undefined
    const next = clips[i + 1] as Clip | undefined

    // --- Transition INTO this clip (this clip is B). Its window sits at the
    // head of B and takes over from B's plain layer for its duration. ---
    if (prev && prev.enabled && timeAdjacent(prev, clip)) {
      const tr = pairTransition(prev, clip)
      if (tr) {
        const maxD = Math.min(clipDurationS(prev), clipDurationS(clip))
        const d = clamp(tr.durationS, 1 / fps, maxD)
        if (t >= clip.startS && t < clip.startS + d) {
          return {
            type: 'transition',
            kind: coerceKind(tr.type),
            progress: (t - clip.startS) / d,
            // A sampled PAST its out point (t is beyond A's end).
            from: layerFor(prev, t),
            to: layerFor(clip, t),
          }
        }
      }
    }

    // --- This clip's own span. A two-clip transition window never overlaps a
    // clip's own [startS, endS) (the window lives at the NEXT clip's head), so
    // there is no double-draw. ---
    const endS = clipEndS(clip)
    if (t >= clip.startS && t < endS) {
      const layer = layerFor(clip, t)
      const dur = clipDurationS(clip)

      // Lone-edge fades: a transitionIn/Out with NO partner clip fades to/from
      // black by scaling opacity. A two-clip transition (handled above) beats
      // this, so only apply when the neighbor is absent or not adjacent.
      const hasPrevPartner = !!prev && prev.enabled && timeAdjacent(prev, clip)
      const hasNextPartner = !!next && next.enabled && timeAdjacent(clip, next)

      if (clip.transitionIn && !hasPrevPartner) {
        const d = clamp(clip.transitionIn.durationS, 1 / fps, dur)
        if (t < clip.startS + d) layer.opacity = clamp(layer.opacity * ((t - clip.startS) / d), 0, 1)
      }
      if (clip.transitionOut && !hasNextPartner) {
        const d = clamp(clip.transitionOut.durationS, 1 / fps, dur)
        if (t >= endS - d) layer.opacity = clamp(layer.opacity * ((endS - t) / d), 0, 1)
      }

      return { type: 'layer', layer }
    }
  }
  return null
}

/**
 * Resolve the whole sequence at time `t` into an ordered draw list. Ops are
 * bottom→top: a lower video track (earlier in seq.tracks) appears earlier in
 * the array. Audio tracks and muted video tracks contribute nothing visual.
 */
export function resolveFrame(seq: Sequence, t: number): RenderFrame {
  const ops: RenderOp[] = []
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    const op = resolveTrack(track, t, seq.fps)
    if (op) ops.push(op)
  }
  return { width: seq.width, height: seq.height, ops }
}
