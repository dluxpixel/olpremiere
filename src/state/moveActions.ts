// The shelf, wired to the document.
//
// ONE tile click is ONE undo step, however many clips are selected. His Short is
// twenty clips, so the fan-out is the whole point: every action here routes
// through the single mapClips dispatch in bulkEdits rather than calling the
// per-clip helper twenty times and flooding the undo stack.
//
// Nothing is stored about which move a clip carries. It is written as keyframes
// and read back off them (matchMove), so a clip edited by hand afterwards simply
// stops matching, and the shelf can never claim a move the clip is not making.

import {
  MOVE_BY_ID,
  MOVE_CHANNELS,
  applyMove,
  isBuiltInMoveId,
  matchMove,
  type MoveDef,
  type MoveId,
  type MoveMatch,
} from '../engine/moves'
import { channelKeyframes } from '../engine/effects/channels'
import { clipDurationS, unlockedClipIds } from '../engine/timeline'
import { activeSequence, type Clip, type Sequence } from '../engine/types'
import { mapClips } from './bulkEdits'
import { getMyMove, listMyMoves } from './myMoves'
import { playMovePreview } from './movePreview'
import { useStore } from './store'
import { useToasts } from './toasts'

/** The wording the gizmo badge already uses for the same refusal. One sentence, one place. */
export const APPEARANCE_REFUSAL = 'This clip uses an entrance animation, which owns its keyframes.'

/** Everything a move needs to know about the sequence it is being written into. */
export interface MoveContext {
  fps: number
  seqWidth: number
  seqHeight: number
  riseFrames: number
  depth: number
}

export function moveContext(): MoveContext {
  const state = useStore.getState()
  const seq = activeSequence(state.project)
  return {
    fps: seq.fps || 30,
    seqWidth: seq.width,
    seqHeight: seq.height,
    riseFrames: state.ui.punchRiseFrames,
    depth: state.ui.punchDepth,
  }
}

/**
 * A clip a move can be written onto: real picture, on an unlocked track, not an
 * adjustment layer, and not one whose entrance animation owns its keyframes.
 *
 * Audio is excluded because a camera move on a sound is nothing, and an
 * adjustment layer because the renderer builds its op from effects, mask and
 * opacity alone, so a transform written there would be an inert document edit.
 */
export function canTakeAMove(clip: Clip, seq: Sequence): boolean {
  if (clip.adjustment === true) return false
  if (clip.appearance) return false
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
  if (!track || track.kind !== 'video') return false
  return clipDurationS(clip) > 0
}

/** The clips a shelf action will actually touch, and why some were dropped. */
function targets(ids: readonly string[]): { seq: Sequence; clips: Clip[]; refusedAppearance: boolean } {
  const seq = activeSequence(useStore.getState().project)
  const allowed = new Set(unlockedClipIds(seq, [...ids]))
  const all = seq.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id))
  const clips = all.filter((c) => allowed.has(c.id) && canTakeAMove(c, seq))
  return { seq, clips, refusedAppearance: all.some((c) => !!c.appearance) }
}

/** The current selection, or an explicit list. */
const selectionIds = (ids?: readonly string[]): string[] => ids ? [...ids] : [...useStore.getState().ui.selection]

/**
 * Put a move on every selected clip, in ONE undo step.
 *
 * The window is not passed, so each clip gets the move across its OWN length:
 * twelve clips of different lengths all end up with a move that fits, which is
 * what makes selecting the whole Short and clicking once the right gesture.
 */
/**
 * The definition behind a move id, whether it is one of the shipped tiles or one
 * HE recorded and saved.
 *
 * ⛔ ONE PLACE KNOWS THE DIFFERENCE, and this is it. His own moves live in
 * localStorage rather than in the table, so every lookup that used to index
 * MOVE_BY_ID directly would silently answer undefined for one of his and take
 * the tile off the shelf under him.
 */
/** The defs of every move he has saved, for the recogniser to search after the ten. */
const myMoveDefs = (): MoveDef[] => listMyMoves().map((m) => m.def)

const defOf = (id: MoveId): MoveDef | null =>
  isBuiltInMoveId(id) ? MOVE_BY_ID[id] : (getMyMove(id)?.def ?? null)

export function applyMoveToSelection(moveId: MoveId, ids?: readonly string[], options?: { preview?: boolean }): void {
  const def = defOf(moveId)
  if (!def) return
  const wanted = selectionIds(ids)
  if (wanted.length === 0) {
    useToasts.getState().show('Pick a clip first', 'danger')
    return
  }
  const { clips, refusedAppearance } = targets(wanted)
  if (clips.length === 0) {
    useToasts.getState().show(refusedAppearance ? APPEARANCE_REFUSAL : 'No clip here can take a move', 'danger')
    return
  }
  const ctx = moveContext()
  mapClips(
    clips.map((c) => c.id),
    def.name,
    (clip) =>
      applyMove(clip, ctx.fps, def, {
        depth: ctx.depth,
        riseFrames: ctx.riseFrames,
        seqWidth: ctx.seqWidth,
        seqHeight: ctx.seqHeight,
      }),
  )
  if (refusedAppearance) useToasts.getState().show(APPEARANCE_REFUSAL, 'danger')
  // Show him what he picked, straight away, on the clip he picked it for.
  if (options?.preview !== false && moveId !== 'none') playMovePreview(clips[0].id)
}

/**
 * How deep every selected clip's move goes, live, as one undo step per drag.
 *
 * Each clip keeps the move and the window it already has: the slider changes one
 * number, it does not re-decide what the clip is doing. A clip whose keyframes
 * no longer match any move is left alone rather than being quietly straightened
 * out into the nearest tile.
 */
export function setMoveDepth(depth: number, ids?: readonly string[]): void {
  useStore.getState().setUI({ punchDepth: depth })
  const wanted = selectionIds(ids)
  if (wanted.length === 0) return
  const { clips } = targets(wanted)
  if (clips.length === 0) return
  const ctx = moveContext()
  const ids2 = clips.map((c) => c.id)
  mapClips(
    ids2,
    'Move depth',
    (clip) => {
      const found = matchMove(clip, ctx.fps, {
        riseFrames: ctx.riseFrames,
        seqWidth: ctx.seqWidth,
        seqHeight: ctx.seqHeight,
        extraMoves: myMoveDefs(),
      })
      if (!found || found.id === 'none') return clip
      const fdef = defOf(found.id)
      if (!fdef) return clip
      return applyMove(clip, ctx.fps, fdef, {
        depth,
        riseFrames: ctx.riseFrames,
        seqWidth: ctx.seqWidth,
        seqHeight: ctx.seqHeight,
        startS: found.startS,
        endS: found.endS,
      })
    },
    // One Ctrl+Z for a whole drag, folded per selection the way every other
    // scrubbed field in the app folds.
    'move-depth',
  )
}

/** How many keyframes a clip's move channels carry between them. 0 means no move. */
function moveKeyframeCount(clip: Clip): number {
  return MOVE_CHANNELS.reduce((n, ch) => n + channelKeyframes(clip, ch).length, 0)
}

/**
 * Move where a move starts and ends, by dragging the ends of the bar under the
 * tiles. Retiming is a PARAMETER of the move, not a hand edit, so the tile stays
 * lit: the window is read back from the first and last keyframe, so putting them
 * somewhere else simply moves the window.
 *
 * Pass `known` when the caller already knows which move it is dragging. It
 * should: see the comment below.
 */
export function setMoveWindow(
  clipId: string,
  startS: number,
  endS: number,
  known?: { id: MoveId; depth: number },
): void {
  const ctx = moveContext()
  const { clips } = targets([clipId])
  const clip = clips[0]
  if (!clip) return
  // ⛔ THE CALLER'S MOVE WINS, AND THIS IS THE WHOLE BUG HE REPORTED.
  //
  // This used to re-derive the move from the keyframes on EVERY pointermove.
  // Recognition rebuilds the preset at the window it reads back and compares
  // frame by frame, so at a great many window widths the quantised beats differ
  // by a frame and it matches nothing. Measured 2026-08-14 by sweeping the end
  // handle across a 6 second clip: "Left, then right" failed recognition at
  // ELEVEN widths spread over the whole bar, "In and out" at three. At the
  // first of them this function returned, the drag went dead under his cursor,
  // the tile went dark and the depth slider went inert.
  //
  // The ribbon already knows which move it is dragging, because it is drawing
  // it. Carrying that through means a retime can no longer depend on guessing.
  const found =
    known ??
    matchMove(clip, ctx.fps, {
      riseFrames: ctx.riseFrames,
      seqWidth: ctx.seqWidth,
      seqHeight: ctx.seqHeight,
      extraMoves: myMoveDefs(),
    })
  if (!found || found.id === 'none') return
  const def = defOf(found.id)
  if (!def) return
  const durS = clipDurationS(clip)
  const lo = Math.max(0, Math.min(startS, durS))
  const hi = Math.max(lo + 1 / ctx.fps, Math.min(endS, durS))
  mapClips(
    [clipId],
    'Move timing',
    (c) => {
      const next = applyMove(c, ctx.fps, def, {
        depth: found.depth,
        riseFrames: ctx.riseFrames,
        seqWidth: ctx.seqWidth,
        seqHeight: ctx.seqHeight,
        startS: lo,
        endS: hi,
      })
      // ⛔ A RETIME MUST NEVER DELETE THE MOVE IT IS RETIMING. Squeeze the window
      // small enough and every beat lands on one frame, so every channel comes
      // out flat and `buildMove` drops all of them: the clip keeps nothing and
      // there is no way back except undo, which also throws away the drag.
      // Measured at a 0.15 s window. Refusing the write leaves the handle
      // looking stuck, which is the honest thing for a window that small.
      return moveKeyframeCount(next) === 0 ? c : next
    },
    'move-window',
  )
}

/** Which move a clip is making, worked out fresh. Null means it was edited by hand. */
export function moveOnClip(clip: Clip): MoveMatch | null {
  const ctx = moveContext()
  // ⛔ HIS OWN MOVES BELONG IN THIS ONE ESPECIALLY. This is the call the SHELF
  // lights a tile from, so leaving them out here is the version where he saves a
  // move, puts it on a clip, and the shelf still calls it hand edited.
  return matchMove(clip, ctx.fps, {
    riseFrames: ctx.riseFrames,
    seqWidth: ctx.seqWidth,
    seqHeight: ctx.seqHeight,
    extraMoves: myMoveDefs(),
  })
}

/** The one move a whole selection agrees on, or null when they differ. */
export function moveOnClips(clips: readonly Clip[]): MoveMatch | null {
  if (clips.length === 0) return null
  const first = moveOnClip(clips[0])
  if (!first) return null
  for (let i = 1; i < clips.length; i++) {
    const next = moveOnClip(clips[i])
    if (!next || next.id !== first.id) return null
  }
  return first
}
