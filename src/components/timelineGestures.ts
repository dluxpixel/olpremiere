import {
  clipDurationS,
  clipEndS,
  clipGroupIds,
  rateStretchGroup,
  rippleTrimGroup,
  rippleTrimSolo,
  rollEditTo,
  slideClip,
  slipClip,
  slipGroup,
  trimClipTo,
  trimGroup,
} from '../engine/timeline'
import { blockEdges, moveBlock, snapBlockDelta } from '../engine/blockMove'
import { formatTimecode } from '../engine/timecode'
import type { Clip, Id, MediaAsset, Sequence, Track } from '../engine/types'
import { fmtDelta } from './timelineGeometry'
import type { Drag } from './timelineDrag'

type Assets = Record<Id, MediaAsset>
type DragOf<K extends Drag['kind']> = Extract<Drag, { kind: K }>

const findClipIn = (seq: Sequence, id: Id): Clip | undefined =>
  seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === id)

// ---------------------------------------------------------------------------
// Intent, read at pointer-down

/**
 * Had the user singled this clip out BEFORE grabbing its edge? Selecting ONE
 * half of a linked A/V pair and trimming it means "trim just this clip", so
 * shortening the audio no longer shortens the video. With nothing selected -
 * or the whole pair selected - the edge still trims the pair together, which
 * IS the point of the link. Must be read before the grab's own select().
 */
export const soloTrimIntent = (seq: Sequence, selection: readonly Id[], clipId: Id): boolean =>
  selection.length > 0 &&
  selection.includes(clipId) &&
  !clipGroupIds(seq, clipId).every((g) => selection.includes(g))

/**
 * Trimming never touches linkId, so a solo-trimmed pair stays linked and keeps
 * moving together - only their lengths differ.
 *
 * ⛔ A PLAIN EDGE DRAG STOPS AT THE NEIGHBOUR. NO CROSSFADE, 2026-10-03.
 *
 * From 2026-09-15 a plain edge dragged INTO the next clip turned the overlap
 * into a crossfade, borrowed from Vegas. His words on 2026-10-03: *"please
 * remove the sony vegas feature that when you slide the clip through antother
 * clip it adds a transition"*. It also did damage nobody asked for: pulling a
 * head into the previous clip SHORTENED that clip, on the picture only, so a
 * linked pair fell out of sync, and pushing a tail wrote a dissolve onto the
 * neighbour he never grabbed and overwrote its audio fades. It is gone, the
 * whole file with it. An edge now stops at the cut like any trim, and a
 * crossfade is something he asks for on purpose, from the clip menu, the
 * Inspector or by dropping a transition on a clip.
 */
export const trimFnFor = (solo: boolean, ripple: boolean) => {
  if (ripple) return solo ? rippleTrimSolo : rippleTrimGroup
  return solo ? trimClipTo : trimGroup
}

/** The clips either side of `clipId` on its track: a slide's own origin edges. */
export function slideNeighborIds(track: Track, clipId: Id): Id[] {
  const idx = track.clips.findIndex((c) => c.id === clipId)
  return [track.clips[idx - 1]?.id, track.clips[idx + 1]?.id].filter((id): id is Id => !!id)
}

/** The cut a roll on this edge moves, or null with no neighbour to roll against. */
export function rollPair(track: Track, clipId: Id, edge: 'in' | 'out'): { leftId: Id; rightId: Id } | null {
  const idx = track.clips.findIndex((c) => c.id === clipId)
  const neighbor = edge === 'out' ? track.clips[idx + 1] : track.clips[idx - 1]
  if (!neighbor) return null
  return {
    leftId: edge === 'out' ? clipId : neighbor.id,
    rightId: edge === 'out' ? neighbor.id : clipId,
  }
}

// ---------------------------------------------------------------------------
// One pointermove of a drag: the preview sequence and the live readout

/** A drag frame: the preview to draw and the readout text (null = leave the tip as it is). */
export interface DragStep {
  next: Sequence
  tip: string | null
}

// Moves get the live readout too: new start timecode + signed delta.
export const moveTipText = (finalT: number, startS: number, fps: number): string =>
  `Move  ${formatTimecode(finalT, fps)}  ${fmtDelta(finalT - startS, fps)}`

/** A move frame: the preview, its readout, what the release will commit, and the snap line. */
export interface MoveStep extends DragStep {
  /** Exactly what dragCommit is handed on release, so the release lands the preview. */
  final: { trackId: Id; tS: number }
  /** Where the snap line goes, null when nothing caught or the catch is not where it landed. */
  indicatorT: number | null
}

/**
 * One pointermove of a clip drag, as one pure step.
 *
 * `aim` is where the pointer puts the grabbed clip (its start, frame quantized)
 * and the lane it points at. The whole block snaps as one (snapBlockDelta), the
 * snapped start goes into `final`, and the preview is `moveBlock` run on exactly
 * that `final`. dragCommit runs the same `moveBlock` on the same `final`, so the
 * preview he watches and the edit that lands cannot differ. The readout shows
 * where the grabbed clip actually LANDS, not where the pointer is, because a
 * block that cannot fit where he aims goes to the nearest spot it does fit.
 */
export function moveStep(
  seq: Sequence,
  drag: DragOf<'move'>,
  aim: { startS: number; trackId: Id },
  snap: { points: readonly number[]; thresholdS: number } | null,
): MoveStep {
  const grabbed = findClipIn(seq, drag.clipId)
  if (!grabbed) return { next: seq, tip: null, final: { trackId: aim.trackId, tS: aim.startS }, indicatorT: null }
  let deltaS = aim.startS - grabbed.startS
  let snappedT: number | null = null
  if (snap) {
    const s = snapBlockDelta(blockEdges(seq, drag.blockIds, drag.clipId), deltaS, snap.points, snap.thresholdS)
    deltaS = s.deltaS
    snappedT = s.indicatorT
  }
  const final = { trackId: aim.trackId, tS: grabbed.startS + deltaS }
  const next = moveBlock(seq, drag.blockIds, drag.clipId, final.trackId, final.tS)
  const landed = findClipIn(next, drag.clipId) ?? grabbed
  // The line is only true when the block landed on the delta it snapped to.
  const indicatorT = snappedT !== null && Math.abs(landed.startS - final.tS) < 1e-9 ? snappedT : null
  return { next, tip: moveTipText(landed.startS, grabbed.startS, seq.fps), final, indicatorT }
}

export function slipStep(seq: Sequence, assets: Assets, drag: DragOf<'slip'>, deltaS: number): DragStep {
  const next = (drag.solo ? slipClip : slipGroup)(seq, assets, drag.clipId, deltaS)
  const slipped = findClipIn(next, drag.clipId)
  const slipOrig = findClipIn(seq, drag.clipId)
  // Delta = the APPLIED source offset (slipClip clamps at the media ends),
  // so the readout never claims more slip than actually happened.
  const tip =
    slipped && slipOrig
      ? `Slip  in ${formatTimecode(slipped.inS, seq.fps)} · out ${formatTimecode(slipped.outS, seq.fps)}  ${fmtDelta(slipped.inS - slipOrig.inS, seq.fps)}`
      : null
  return { next, tip }
}

export function rollStep(seq: Sequence, assets: Assets, drag: DragOf<'roll'>, t: number): DragStep {
  const next = rollEditTo(seq, assets, drag.leftId, drag.rightId, t)
  const right = findClipIn(next, drag.rightId)
  const rightOrig = findClipIn(seq, drag.rightId)
  const tip =
    right && rightOrig
      ? `Roll  ${formatTimecode(right.startS, seq.fps)}  ${fmtDelta(right.startS - rightOrig.startS, seq.fps)}`
      : null
  return { next, tip }
}

export function slideStep(seq: Sequence, assets: Assets, drag: DragOf<'slide'>, t: number): DragStep {
  const next = slideClip(seq, assets, drag.clipId, t)
  const slid = findClipIn(next, drag.clipId)
  const slidOrig = findClipIn(seq, drag.clipId)
  const tip =
    slid && slidOrig
      ? `Slide  ${formatTimecode(slid.startS, seq.fps)}  ${fmtDelta(slid.startS - slidOrig.startS, seq.fps)}`
      : null
  return { next, tip }
}

export function stretchStep(seq: Sequence, drag: DragOf<'stretch'>, t: number): DragStep {
  const next = rateStretchGroup(seq, drag.clipId, drag.edge, t)
  const stretched = findClipIn(next, drag.clipId)
  const tip = stretched
    ? `Speed ${Math.round(Math.abs(stretched.speed) * 100)}%  ·  ${formatTimecode(clipDurationS(stretched), seq.fps)}`
    : null
  return { next, tip }
}

export function trimStep(seq: Sequence, assets: Assets, drag: DragOf<'trim'>, t: number): DragStep {
  const next = trimFnFor(drag.solo, drag.ripple)(seq, assets, drag.clipId, drag.edge, t)
  const trimmed = findClipIn(next, drag.clipId)
  const orig = findClipIn(seq, drag.clipId)
  if (trimmed && orig) {
    const edgeT = drag.edge === 'in' ? trimmed.startS : clipEndS(trimmed)
    const origT = drag.edge === 'in' ? orig.startS : clipEndS(orig)
    // Ripple-in keeps startS fixed; show the source-window edge instead.
    const shownT = drag.ripple && drag.edge === 'in' ? trimmed.inS : edgeT
    const delta = drag.ripple && drag.edge === 'in' ? trimmed.inS - orig.inS : edgeT - origT
    return { next, tip: `${drag.ripple ? 'Ripple  ' : ''}${formatTimecode(shownT, seq.fps)}  ${fmtDelta(delta, seq.fps)}` }
  }
  return { next, tip: null }
}

// ---------------------------------------------------------------------------
// Release: the one undoable edit a finished drag commits

/** The undo label and the edit a released drag commits, or null for a drag that commits nothing. */
export function dragCommit(
  drag: Drag,
  final: { trackId: Id; tS: number },
  assets: Assets,
): { label: string; apply: (sq: Sequence) => Sequence } | null {
  const { trackId, tS } = final
  switch (drag.kind) {
    case 'move':
      // The same moveBlock, on the same `final`, that moveStep previewed.
      return {
        label: drag.blockIds.length > 1 ? 'Move clips' : 'Move clip',
        apply: (sq) => moveBlock(sq, drag.blockIds, drag.clipId, trackId, tS),
      }
    case 'trim':
      return {
        label: drag.ripple ? 'Ripple trim' : 'Trim clip',
        apply: (sq) => trimFnFor(drag.solo, drag.ripple)(sq, assets, drag.clipId, drag.edge, tS),
      }
    case 'stretch':
      return { label: 'Rate stretch', apply: (sq) => rateStretchGroup(sq, drag.clipId, drag.edge, tS) }
    case 'slip':
      return { label: 'Slip clip', apply: (sq) => (drag.solo ? slipClip : slipGroup)(sq, assets, drag.clipId, tS) }
    case 'roll':
      return { label: 'Roll edit', apply: (sq) => rollEditTo(sq, assets, drag.leftId, drag.rightId, tS) }
    case 'slide':
      return { label: 'Slide clip', apply: (sq) => slideClip(sq, assets, drag.clipId, tS) }
    default:
      return null
  }
}
