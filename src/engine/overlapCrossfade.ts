// Drag a clip's edge INTO its neighbour and the overlap becomes a crossfade.
//
// The Vegas gesture. Of everything editors say they love about that timeline,
// this is the line that comes up most, and it is also the thing Premiere users
// ask for most often in Adobe's own forum: no transition to fish out of a panel,
// no separate object to place. The overlap IS the crossfade, and its length is
// however far the edge went. Research note, 2026-09-15:
// vault projects/ol-premiere/ol-premiere-what-editors-love-in-premiere-and-vegas.md
//
// It maps onto the pair transition the engine already plays, so the data model
// does not change and clips never overlap. A pair transition is stored on one
// clip, runs for its duration at the incoming clip's head, and keeps sampling
// the outgoing clip PAST its out point through the window (render/resolve.ts).
// So the two directions come out like this:
//
//   A's tail dragged into B:  nothing moves. The pair gets the overshoot as
//     its length. A already has the frames past its out point, which is
//     exactly what the renderer shows through the window.
//   B's head dragged into A:  roll the cut left to where the edge went, then
//     the pair gets the rolled distance as its length. A now ends where B
//     begins, A's real frames past that point play through the window, and B's
//     earlier frames fade in over them. Frame for frame what Vegas shows.
//
// A pair that already has a transition keeps its kind and takes the new
// length, wherever the field lives; one that has none gets a cross dissolve on
// the incoming clip. On an audio track the same overlap sets the two fade
// handles instead, which is what this app already calls an audio crossfade
// (clipEdits.crossfadeWithNeighbour).
//
// Pure. The plain trim runs first and this only ever ADDS to it, so a drag
// that stops short of the neighbour is exactly the trim it always was, and a
// drag that comes back out of the neighbour leaves whatever was there before.

import { transitionDurationSpec, type TransitionKind } from './render/types'
import { findClip, rollEditTo, trimClipTo, trimGroup } from './timeline'
import { clipDurationS, clipEndS, type Clip, type Id, type MediaAsset, type Sequence } from './types'

const EPS = 1e-6
/** Under this much overlap it is a wobble of the hand, not a crossfade. */
const CROSSFADE_MIN_S = transitionDurationSpec('crossDissolve').min

interface Planned {
  seq: Sequence
  /** Seconds of crossfade the drag produced, 0 when it was a plain trim. */
  crossfadeS: number
}

/** The transition the pair plays, and which clip carries it. Mirrors resolve.ts. */
function pairKind(outgoing: Clip, incoming: Clip): TransitionKind {
  const type = incoming.transitionIn?.type ?? outgoing.transitionOut?.type
  return (type as TransitionKind | undefined) ?? 'crossDissolve'
}

/** A pair that can never play a transition (resolve.ts pairTransitionAt) gets no crossfade. */
const canPair = (a: Clip, b: Clip): boolean => a.enabled && b.enabled && !a.adjustment && !b.adjustment

function withCrossfade(seq: Sequence, trackIndex: number, outgoingId: Id, incomingId: Id, d: number): Sequence {
  const track = seq.tracks[trackIndex]
  const outgoing = track.clips.find((c) => c.id === outgoingId)
  const incoming = track.clips.find((c) => c.id === incomingId)
  if (!outgoing || !incoming) return seq
  const clips = track.clips.map((c) => {
    if (track.kind === 'audio') {
      if (c.id === outgoingId) return { ...c, fadeOutS: d }
      if (c.id === incomingId) return { ...c, fadeInS: d }
      return c
    }
    // Keep the field where it already lives: B.transitionIn wins in the
    // renderer, so it is updated when present; otherwise A.transitionOut; and
    // a bare pair gets a dissolve on the incoming clip.
    if (c.id === incomingId && (c.transitionIn || !outgoing.transitionOut)) {
      return { ...c, transitionIn: { type: pairKind(outgoing, incoming), durationS: d } }
    }
    if (c.id === outgoingId && !incoming.transitionIn && c.transitionOut) {
      return { ...c, transitionOut: { type: c.transitionOut.type, durationS: d } }
    }
    return c
  })
  return { ...seq, tracks: seq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips } : t)) }
}

/** Longest crossfade the pair can honestly play, per the renderer's own clamps. */
function clampPair(d: number, outgoing: Clip, incoming: Clip, kind: 'video' | 'audio'): number {
  let max = Math.min(clipDurationS(outgoing), clipDurationS(incoming))
  if (kind !== 'audio') max = Math.min(max, transitionDurationSpec(pairKind(outgoing, incoming)).max)
  return Math.min(d, max)
}

function plan(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
  solo: boolean,
): Planned {
  const base = (solo ? trimClipTo : trimGroup)(seq, assets, clipId, edge, tS)
  const none = { seq: base, crossfadeS: 0 }
  // The ORIGINAL positions decide whether the edge went past the neighbour.
  const found = findClip(seq, clipId)
  if (!found) return none
  const { track, clip, trackIndex, clipIndex } = found
  const sp = Math.abs(clip.speed || 1)
  const asset = assets[clip.assetId] as MediaAsset | undefined
  const boundless = !asset || asset.kind === 'image'

  if (edge === 'out') {
    const next = track.clips[clipIndex + 1] as Clip | undefined
    if (!next || tS <= next.startS + EPS || !canPair(clip, next)) return none
    // The base trim parked A's tail on B's head. How much further could A
    // really have gone: as far as the drag, within A's own media.
    let reach = tS
    if (!boundless) reach = Math.min(reach, clip.startS + (asset.durationS - clip.inS) / sp)
    const trimmed = findClip(base, clipId)?.clip
    if (!trimmed || Math.abs(clipEndS(trimmed) - next.startS) > 1e-4) return none
    const d = clampPair(reach - next.startS, trimmed, next, track.kind)
    if (d < CROSSFADE_MIN_S) return none
    return { seq: withCrossfade(base, trackIndex, clip.id, next.id, d), crossfadeS: d }
  }

  const prev = track.clips[clipIndex - 1] as Clip | undefined
  if (!prev || tS >= clipEndS(prev) - EPS || !canPair(prev, clip)) return none
  // The base trim parked B's head on A's tail (or on B's own first frame, in
  // which case there is nothing to overlap with). Roll the cut left to where
  // the drag went: A gives up its tail, B's earlier frames come in.
  const parked = findClip(base, clipId)?.clip
  if (!parked || Math.abs(parked.startS - clipEndS(prev)) > 1e-4) return none
  const rolled = rollEditTo(base, assets, prev.id, clip.id, tS)
  const newPrev = findClip(rolled, prev.id)?.clip
  const newClip = findClip(rolled, clip.id)?.clip
  if (!newPrev || !newClip) return none
  const d = clampPair(clipEndS(prev) - newClip.startS, newPrev, newClip, track.kind)
  if (d < CROSSFADE_MIN_S) return none
  return { seq: withCrossfade(rolled, trackIndex, prev.id, clip.id, d), crossfadeS: d }
}

/**
 * The plain edge drag: a trim, and when the edge goes into the neighbour on the
 * same track, a crossfade the length of the overlap. `solo` trims one half of a
 * linked pair alone, exactly as trimClipTo does for trimGroup.
 */
export function trimIntoNeighbour(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
  solo = false,
): Sequence {
  return plan(seq, assets, clipId, edge, tS, solo).seq
}

/** Seconds of crossfade the same drag would make, for the readout under the pointer. 0 for a plain trim. */
export function overlapCrossfadeS(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
  solo = false,
): number {
  return plan(seq, assets, clipId, edge, tS, solo).crossfadeS
}
