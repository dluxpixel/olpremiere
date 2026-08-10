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

import { MOVE_BY_ID, applyMove, matchMove, type MoveId, type MoveMatch } from '../engine/moves'
import { clipDurationS, unlockedClipIds } from '../engine/timeline'
import { activeSequence, type Clip, type Sequence } from '../engine/types'
import { mapClips } from './bulkEdits'
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
export function applyMoveToSelection(moveId: MoveId, ids?: readonly string[], options?: { preview?: boolean }): void {
  const def = MOVE_BY_ID[moveId]
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
      })
      if (!found || found.id === 'none') return clip
      return applyMove(clip, ctx.fps, MOVE_BY_ID[found.id], {
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

/**
 * Move where a move starts and ends, by dragging the ends of the bar under the
 * tiles. Retiming is a PARAMETER of the move, not a hand edit, so the tile stays
 * lit: the window is read back from the first and last keyframe, so putting them
 * somewhere else simply moves the window.
 */
export function setMoveWindow(clipId: string, startS: number, endS: number): void {
  const ctx = moveContext()
  const { clips } = targets([clipId])
  const clip = clips[0]
  if (!clip) return
  const found = matchMove(clip, ctx.fps, {
    riseFrames: ctx.riseFrames,
    seqWidth: ctx.seqWidth,
    seqHeight: ctx.seqHeight,
  })
  if (!found || found.id === 'none') return
  const def = MOVE_BY_ID[found.id]
  const durS = clipDurationS(clip)
  const lo = Math.max(0, Math.min(startS, durS))
  const hi = Math.max(lo + 1 / ctx.fps, Math.min(endS, durS))
  mapClips(
    [clipId],
    'Move timing',
    (c) =>
      applyMove(c, ctx.fps, def, {
        depth: found.depth,
        riseFrames: ctx.riseFrames,
        seqWidth: ctx.seqWidth,
        seqHeight: ctx.seqHeight,
        startS: lo,
        endS: hi,
      }),
    'move-window',
  )
}

/** Which move a clip is making, worked out fresh. Null means it was edited by hand. */
export function moveOnClip(clip: Clip): MoveMatch | null {
  const ctx = moveContext()
  return matchMove(clip, ctx.fps, {
    riseFrames: ctx.riseFrames,
    seqWidth: ctx.seqWidth,
    seqHeight: ctx.seqHeight,
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
