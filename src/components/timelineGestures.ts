import {
  clipDurationS,
  clipEndS,
  clipGroupIds,
  moveSelectionWith,
  rateStretchGroup,
  rippleTrimGroup,
  rippleTrimSolo,
  rollEditTo,
  slideClip,
  slipClip,
  slipGroup,
  snapTime,
} from '../engine/timeline'
import { formatTimecode } from '../engine/timecode'
import { overlapCrossfadeS, trimIntoNeighbour } from '../engine/overlapCrossfade'
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
 * MOVE is solo by default. His words, 2026-08-05, after a first attempt that
 * only went solo once he had selected the clip: "when I drag the video clip,
 * it automatically drags the audio clip. Can you make it so the audio and
 * video clips can be dragged separately?"
 *
 * Requiring a click before the drag was a fix that asked him to change how
 * he works, which is not a fix. Grabbing a clip and moving it in one motion
 * is the gesture, so that gesture has to mean "move this clip". Selecting
 * BOTH halves still moves them together, which is the deliberate way to say
 * "keep these in sync" and the only way it happens now.
 *
 * Read before the select() in the pointer-down, like soloSlip: after it, the
 * grabbed clip is always selected and the question answers itself.
 */
export const soloMoveIntent = (seq: Sequence, selection: readonly Id[], clipId: Id): boolean =>
  !clipGroupIds(seq, clipId).every((g) => selection.includes(g))

/**
 * Trimming never touches linkId, so a solo-trimmed pair stays linked and keeps
 * moving together - only their lengths differ.
 */
export const trimFnFor = (solo: boolean, ripple: boolean) => {
  if (ripple) return solo ? rippleTrimSolo : rippleTrimGroup
  // A plain edge drag may go INTO the neighbour: the overlap becomes a
  // crossfade, the Vegas gesture (engine/overlapCrossfade.ts). Short of the
  // neighbour it is trimClipTo / trimGroup exactly as before.
  return (sq: Sequence, a: Assets, id: Id, edge: 'in' | 'out', t: number) =>
    trimIntoNeighbour(sq, a, id, edge, t, solo)
}

// Multi-selection: carry every OTHER selected unlocked clip (deduped by
// link group - moveGroup moves partners) so the whole selection travels.
export function carriedOthers(
  seq: Sequence,
  selNow: readonly Id[],
  clipId: Id,
): { id: Id; startS0: number; solo: boolean }[] {
  const others: { id: Id; startS0: number; solo: boolean }[] = []
  if (selNow.includes(clipId) && selNow.length > 1) {
    const seen = new Set<Id>(clipGroupIds(seq, clipId))
    for (const tr of seq.tracks) {
      if (tr.locked) continue
      for (const c of tr.clips) {
        if (!selNow.includes(c.id) || seen.has(c.id)) continue
        const group = clipGroupIds(seq, c.id)
        for (const gid of group) seen.add(gid)
        // The SAME question soloMove asks of the grabbed clip, asked of every
        // clip travelling with it. Without it a multi-clip drag moved partners
        // he never selected, which is his linked-drag report of 2026-08-05 and
        // 2026-08-12. See the note in moveSelectionWith.
        others.push({ id: c.id, startS0: c.startS, solo: !group.every((g) => selNow.includes(g)) })
      }
    }
  }
  return others
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

/**
 * Snap the leading edge, then the trailing edge; keep the closer catch.
 * `indicatorT` is where the snap line goes, null when nothing caught.
 */
export function snapMoveStart(
  desiredRaw: number,
  durS: number,
  points: number[],
  thresholdS: number,
): { desired: number; indicatorT: number | null } {
  const s1 = snapTime(desiredRaw, points, thresholdS)
  const s2 = snapTime(desiredRaw + durS, points, thresholdS)
  if (s1.snapped && (!s2.snapped || Math.abs(s1.t - desiredRaw) <= Math.abs(s2.t - durS - desiredRaw))) {
    return { desired: s1.t, indicatorT: s1.t }
  }
  if (s2.snapped) return { desired: s2.t - durS, indicatorT: s2.t }
  return { desired: desiredRaw, indicatorT: null }
}

// Moves get the live readout too: new start timecode + signed delta.
export const moveTipText = (finalT: number, startS: number, fps: number): string =>
  `Move  ${formatTimecode(finalT, fps)}  ${fmtDelta(finalT - startS, fps)}`

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
  const crossfadeS = drag.ripple ? 0 : overlapCrossfadeS(seq, assets, drag.clipId, drag.edge, t, drag.solo)
  if (crossfadeS > 0) {
    // Past the neighbour the edge is no longer trimming, it is sizing the
    // crossfade, so the readout says that and nothing else.
    return { next, tip: `Crossfade  ${formatTimecode(crossfadeS, seq.fps)}` }
  }
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
  seq: Sequence,
  assets: Assets,
): { label: string; apply: (sq: Sequence) => Sequence } | null {
  const { trackId, tS } = final
  switch (drag.kind) {
    case 'move':
      return {
        label: drag.others.length > 0 ? 'Move clips' : 'Move clip',
        apply: (sq) => moveSelectionWith(sq, drag.clipId, trackId, tS, drag.others, drag.solo),
      }
    case 'trim': {
      const crossfaded = !drag.ripple && overlapCrossfadeS(seq, assets, drag.clipId, drag.edge, tS, drag.solo) > 0
      return {
        label: drag.ripple ? 'Ripple trim' : crossfaded ? 'Crossfade' : 'Trim clip',
        apply: (sq) => trimFnFor(drag.solo, drag.ripple)(sq, assets, drag.clipId, drag.edge, tS),
      }
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
