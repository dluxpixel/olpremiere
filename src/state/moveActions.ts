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
  appendMove,
  applyMove,
  clearMoveChannels,
  isBuiltInMoveId,
  matchChain,
  matchMove,
  moveSpan,
  type MoveDef,
  type MoveId,
  type MoveMatch,
} from '../engine/moves'
import { channelBase, channelKeyframes, resolveChannel } from '../engine/effects/channels'
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

/**
 * The depth a tile actually gets, given where his slider sits.
 *
 * ⛔ THE SLIDER IS MAGNITUDE NOW. THE TILE OWNS THE DIRECTION. His ask,
 * 2026-08-15: *"when it goes out, I want it to go out to the blur."*
 *
 * Push in at 80 percent and Pull back at 120 produce the SAME keyframes, because
 * they are the same move. While direction lived in the slider, the shelf could
 * not say which tile a clip came from, and one of them was always going to light
 * wrongly. Moving it onto the tile makes every one of them do what its name says,
 * always, and makes the read-back exact: a clip smaller than its frame came from
 * an out tile, and nothing else can have made it.
 *
 * 1/depth rather than 2-depth, so the slider's own top lands on its own bottom
 * and both ends of his range stay reachable.
 */
export const depthFor = (def: MoveDef, sliderDepth: number): number => {
  const d = sliderDepth || 1
  const magnitude = d < 1 ? 1 / d : d
  return def.out ? 1 / magnitude : magnitude
}

const defOf = (id: MoveId): MoveDef | null =>
  isBuiltInMoveId(id) ? MOVE_BY_ID[id] : (getMyMove(id)?.def ?? null)

/** The three sequence numbers every build takes, so a call site names only what it decides. */
const seqOptions = (ctx: MoveContext): { riseFrames: number; seqWidth: number; seqHeight: number } => ({
  riseFrames: ctx.riseFrames,
  seqWidth: ctx.seqWidth,
  seqHeight: ctx.seqHeight,
})

/**
 * Everything the recogniser needs beyond the sequence itself, gathered ONCE per
 * fan-out: `listMyMoves` reads localStorage, which is synchronous, and the old
 * per-clip call paid for it twenty times on a twenty clip selection.
 */
const matchOptions = (ctx: MoveContext): Parameters<typeof matchMove>[2] => ({
  ...seqOptions(ctx),
  extraMoves: myMoveDefs(),
})

/**
 * The runs on a clip: one move, two when it carries a chain, none when it was
 * edited by hand.
 *
 * ⛔ `matchChain` IS ONLY ASKED AFTER `matchMove` HAS FAILED, which is the engine's
 * own instruction: a single move is the common case and the chain search walks
 * every keyframe instant times the shelf, so spending it on every clip of a
 * finished edit would be paying for a chain nobody made.
 *
 * An empty clip answers `[{ id: 'none' }]`, exactly as a single match does, so
 * "no move" and "hand edited" stay two different answers.
 */
/**
 * ⛔ REMEMBERED AGAINST THE CLIP OBJECT, and this one is not an optimisation, it
 * is what keeps the depth slider smooth.
 *
 * The chain search walks every keyframe instant times the whole shelf, and it runs
 * exactly when `matchMove` found nothing, which is every HAND EDITED clip. Dragging
 * the slider over a selection of those asks the same unanswerable question of the
 * same untouched clips sixty times a second: they come back unchanged, so the
 * object is the same object, and the second question was free to skip.
 *
 * Object identity is the one key that cannot go stale, for the reason the shelf's
 * own cache gives: every edit in this app replaces the clip it touches.
 */
const runCache = new WeakMap<Clip, { key: string; runs: MoveMatch[] }>()

function runsOf(clip: Clip, ctx: MoveContext, options: Parameters<typeof matchMove>[2]): MoveMatch[] {
  const key = `${ctx.fps} ${ctx.riseFrames} ${ctx.seqWidth} ${ctx.seqHeight} ${(options.extraMoves ?? [])
    .map((m) => m.id)
    .join(',')}`
  const seen = runCache.get(clip)
  if (seen && seen.key === key) return seen.runs
  const one = matchMove(clip, ctx.fps, options)
  const runs = one ? [one] : (matchChain(clip, ctx.fps, options) ?? [])
  runCache.set(clip, { key, runs })
  return runs
}

/**
 * Near enough to be the same framing: a thousandth of the picture's size, or half
 * a pixel of travel. The engine compares its own keyframes to the same numbers.
 */
const sameValue = (channel: (typeof MOVE_CHANNELS)[number], a: number, b: number): boolean =>
  Math.abs(a - b) <= (channel === 'scale' ? 1e-3 : 0.5)

/** Is the picture doing nothing at all between these two instants? */
const stillBetween = (clip: Clip, fromS: number, toS: number): boolean =>
  MOVE_CHANNELS.every((ch) => sameValue(ch, resolveChannel(clip, ch, fromS), resolveChannel(clip, ch, toS)))

/**
 * Is the picture back at the framing it rests at, at this instant?
 *
 * ⛔ THIS IS THE WHOLE RULE FOR WHAT CAN BE CHAINED, and it is not a policy, it is
 * arithmetic. Every move is written against the framing the clip RESTS at, because
 * that is the only anchor recognition can rebuild one from. So two moves can only
 * be joined where the picture is resting: a head that ends up close has to slide
 * back out on its own before the next move starts, and that slide belongs to
 * neither of them. Measured across all 144 pairs of the shipped twelve on
 * 2026-08-17: 47 join, and every refusal is one end or the other of this.
 *
 * CapCut has the same shape for the same reason. Its In arrives at rest and its Out
 * leaves from rest, which is what makes them composable at all.
 */
const atRest = (clip: Clip, atS: number): boolean =>
  MOVE_CHANNELS.every((ch) => sameValue(ch, resolveChannel(clip, ch, atS), channelBase(clip, ch)))

/**
 * Can a second move follow the one this clip is making, at all?
 *
 * The shelf asks before it offers, so the line is simply absent on a clip whose
 * move stays where it lands rather than being a button that always says no.
 */
export const canTakeASecondMove = (clip: Clip, endS: number): boolean => atRest(clip, endS)

/** What a run needs to be written: which move, how deep, over what window. */
interface MoveRun {
  def: MoveDef
  depth: number
  startS: number
  endS: number
}

/** A match turned back into something writable, or null when the move behind it is gone. */
const runOf = (match: MoveMatch): MoveRun | null => {
  const def = defOf(match.id)
  return def && def.beats.length > 0 ? { def, depth: match.depth, startS: match.startS, endS: match.endS } : null
}

/**
 * Write a whole chain onto a clip: the first move REPLACES what is there, every
 * later one is appended after it.
 *
 * ⛔ ONE PLACE WRITES A CHAIN, and every gesture goes through it: adding the
 * second move, dragging the slider, dragging either window, removing one half.
 * `applyMove` clears the move channels before it writes, so any of those doing
 * its own thing would quietly delete the half it was not looking at.
 *
 * ⛔ EACH RUN STARTS FROM WHAT ACTUALLY LANDED, never from what was asked for.
 * Windows are snapped to the frame grid on the way in, so a run asked to start
 * where the previous one was asked to end can begin half a frame early, and
 * `appendMove` reads that as an overlap and refuses: the second move would
 * silently vanish and the clip would come back carrying one.
 *
 * Null means a run wrote nothing, which happens when a window is squeezed until
 * every beat lands on the same frame. The caller keeps the clip it had.
 */
function writeRuns(clip: Clip, ctx: MoveContext, runs: readonly MoveRun[]): Clip | null {
  if (runs.length === 0) return clearMoveChannels(clip)
  const build = (run: MoveRun, startS: number) => ({
    depth: run.depth,
    riseFrames: ctx.riseFrames,
    seqWidth: ctx.seqWidth,
    seqHeight: ctx.seqHeight,
    startS,
    endS: run.endS,
  })
  let next = applyMove(clip, ctx.fps, runs[0].def, build(runs[0], runs[0].startS))
  if (moveKeyframeCount(next) === 0) return null
  for (let i = 1; i < runs.length; i++) {
    const before = moveKeyframeCount(next)
    const landed = moveSpan(next)
    const startS = Math.max(runs[i].startS, landed ? landed.endS : 0)
    const after = appendMove(next, ctx.fps, runs[i].def, build(runs[i], startS))
    if (moveKeyframeCount(after) <= before) return null
    next = after
  }
  return next
}

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
        depth: depthFor(def, ctx.depth),
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
 * Put a SECOND move after the one the clip already carries, rather than replacing it.
 *
 * His call, 2026-08-17: two moves, a head and a tail, which may touch and may never
 * overlap. That is CapCut's In and Out, and CapCut is the only editor of the four
 * looked at that still NAMES what a clip is doing afterwards.
 * → [[olp-chained-moves-design]]
 *
 * ⛔ THE SECOND MOVE MAKES ROOM WHEN THERE IS NONE, and without that the feature is
 * unreachable: every built-in runs the whole length of the clip, so the tail would
 * be asked to start where the clip ends and would write nothing at all. Touching the
 * head's end is tried FIRST, because a head he has already retimed says where he
 * wants the boundary; only when nothing fits there is the head squeezed into the
 * front half of its own window.
 *
 * ⛔ AND IT ONLY LANDS IF THE SHELF CAN THEN NAME BOTH HALVES. Recognition is the
 * whole promise of this panel, so a pair that reads back as one hand-edited clip is
 * refused out loud instead of being written and left looking broken.
 */
export function appendMoveToSelection(moveId: MoveId, ids?: readonly string[]): void {
  const def = defOf(moveId)
  if (!def) return
  // The None tile is not a second move. It is the way back to no move at all.
  if (def.beats.length === 0) {
    applyMoveToSelection(moveId, ids)
    return
  }
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
  const options = matchOptions(ctx)
  const tailDepth = depthFor(def, ctx.depth)
  let landedOn: string | null = null
  let full = 0
  /** Which end of the join failed, for a refusal that says something he can act on. */
  let blocked: 'head' | 'tail' | null = null
  mapClips(
    clips.map((c) => c.id),
    `Add ${def.name}`,
    (clip) => {
      const runs = runsOf(clip, ctx, options)
      if (runs.length === 2) {
        full++
        return clip
      }
      const head = runs.length === 1 && runs[0].id !== 'none' ? runOf(runs[0]) : null
      // Nothing to chain after: an empty clip simply takes the move, and a hand
      // edited one is left exactly as he shaped it.
      if (!head) {
        if (runs.length !== 1) return clip
        landedOn = clip.id
        return applyMove(clip, ctx.fps, def, { ...seqOptions(ctx), depth: tailDepth })
      }
      const durS = clipDurationS(clip)
      for (const boundary of [head.endS, (head.startS + durS) / 2]) {
        const next = writeRuns(clip, ctx, [
          { ...head, endS: boundary },
          { def, depth: tailDepth, startS: boundary, endS: durS },
        ])
        if (!next) continue
        const back = runsOf(next, ctx, options)
        if (back.length !== 2) continue
        // ⛔ AND NOTHING MAY HAPPEN BETWEEN THEM. Both moves are written against
        // the framing the clip RESTS at, which is the only anchor recognition can
        // rebuild them from, so they can only meet where the picture is resting.
        // Join a move that stays big to one that starts from normal and the
        // picture slides between the two on its own: it reads back as a tidy pair
        // of names while doing a long unnamed drift he never asked for.
        if (!stillBetween(next, back[0].endS, back[1].startS)) continue
        landedOn = clip.id
        return next
      }
      blocked = blocked ?? (atRest(clip, head.endS) ? 'tail' : 'head')
      return clip
    },
  )
  if (refusedAppearance) useToasts.getState().show(APPEARANCE_REFUSAL, 'danger')
  else if (landedOn === null) {
    const why =
      full > 0
        ? 'A clip holds two moves, and this one is full'
        : blocked === 'head'
          ? 'That move stays where it lands, so nothing can follow it'
          : blocked === 'tail'
            ? `${def.name} does not start from normal, so it cannot follow another move`
            : 'No room here for a second move'
    useToasts.getState().show(why, 'danger')
  }
  if (landedOn !== null) playMovePreview(landedOn)
}

/**
 * How deep every selected clip's move goes, live, as one undo step per drag.
 *
 * Each clip keeps the move and the window it already has: the slider changes one
 * number, it does not re-decide what the clip is doing. A clip whose keyframes
 * no longer match any move is left alone rather than being quietly straightened
 * out into the nearest tile.
 *
 * ⛔ BOTH HALVES OF A CHAIN TAKE THE DRAG. The slider says how big the move on
 * this clip is, and a chained clip that answered it with one half moving and the
 * other frozen would be the slider going half dead under his hand.
 */
export function setMoveDepth(depth: number, ids?: readonly string[]): void {
  useStore.getState().setUI({ punchDepth: depth })
  const wanted = selectionIds(ids)
  if (wanted.length === 0) return
  const { clips } = targets(wanted)
  if (clips.length === 0) return
  const ctx = moveContext()
  const options = matchOptions(ctx)
  const ids2 = clips.map((c) => c.id)
  mapClips(
    ids2,
    'Move depth',
    (clip) => {
      const runs = runsOf(clip, ctx, options).map(runOf)
      if (runs.length === 0 || runs.some((r) => r === null)) return clip
      const written = writeRuns(
        clip,
        ctx,
        // Through the same direction rule the tile click uses, or dragging the
        // slider would flip an out move back inward under his hand.
        (runs as MoveRun[]).map((r) => ({ ...r, depth: depthFor(r.def, depth) })),
      )
      return written ?? clip
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
 * should: see the comment below. On a chained clip it also passes `other`, the
 * half his cursor is NOT on, which is rewritten beside the one that moves: a
 * retime that used `applyMove` alone would clear the move channels and take that
 * half with it. It comes from the caller for the same reason the move itself
 * does, and reading it back mid-drag would fail at exactly the widths below.
 */
export function setMoveWindow(
  clipId: string,
  startS: number,
  endS: number,
  known?: { id: MoveId; depth: number; other?: { id: MoveId; depth: number; startS: number; endS: number } },
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
  const found = known ?? matchMove(clip, ctx.fps, matchOptions(ctx))
  if (!found || found.id === 'none') return
  const dragged = defOf(found.id)
  if (!dragged) return
  const other = known?.other
  const beside = other ? runOf(other) : null
  if (other && !beside) return
  const durS = clipDurationS(clip)
  // Touching is allowed, crossing is not: the neighbour's edge is this drag's wall.
  const floor = beside && beside.startS < startS ? beside.endS : 0
  const ceiling = beside && beside.startS >= startS ? beside.startS : durS
  const lo = Math.max(floor, Math.min(startS, ceiling))
  const hi = Math.max(lo + 1 / ctx.fps, Math.min(endS, ceiling))
  const run: MoveRun = { def: dragged, depth: found.depth, startS: lo, endS: hi }
  const runs = beside ? [run, beside].sort((a, b) => a.startS - b.startS) : [run]
  mapClips(
    [clipId],
    'Move timing',
    (c) => {
      // ⛔ A RETIME MUST NEVER DELETE THE MOVE IT IS RETIMING. Squeeze the window
      // small enough and every beat lands on one frame, so every channel comes
      // out flat and `buildMove` drops all of them: the clip keeps nothing and
      // there is no way back except undo, which also throws away the drag.
      // Measured at a 0.15 s window. Refusing the write leaves the handle
      // looking stuck, which is the honest thing for a window that small.
      //
      // `writeRuns` answers null for the same case in EITHER half of a chain, so
      // squeezing the second bar to nothing cannot cost him the first one.
      return writeRuns(c, ctx, runs) ?? c
    },
    'move-window',
  )
}

/**
 * Take ONE move off a chained clip and leave the other exactly where it is.
 *
 * The half that stays keeps its own window rather than spreading to fill the
 * clip: he put it there, and a move that silently grew to four seconds because he
 * removed its neighbour would be the app editing on his behalf.
 */
export function dropMove(clipId: string, index: number): void {
  const ctx = moveContext()
  const { clips } = targets([clipId])
  const clip = clips[0]
  if (!clip) return
  const runs = runsOf(clip, ctx, matchOptions(ctx))
  if (index < 0 || index >= runs.length) return
  const kept = runs.filter((_, i) => i !== index).map(runOf)
  if (kept.some((r) => r === null)) return
  const gone = defOf(runs[index].id)
  mapClips([clipId], gone ? `Remove ${gone.name}` : 'Remove move', (c) => writeRuns(c, ctx, kept as MoveRun[]) ?? c)
}

/** Which move a clip is making, worked out fresh. Null means a chain, or a hand edit. */
export function moveOnClip(clip: Clip): MoveMatch | null {
  const runs = movesOnClip(clip)
  return runs.length === 1 ? runs[0] : null
}

/**
 * Every move a clip is making, worked out fresh: one, two when it carries a
 * chain, none when it was edited by hand.
 *
 * ⛔ HIS OWN MOVES BELONG IN THIS ONE ESPECIALLY. This is the call the SHELF
 * lights its tiles from, so leaving them out is the version where he saves a
 * move, puts it on a clip, and the shelf still calls it hand edited.
 */
export function movesOnClip(clip: Clip): MoveMatch[] {
  const ctx = moveContext()
  return runsOf(clip, ctx, matchOptions(ctx))
}

/** The moves a whole selection agrees on, in order, or none when they differ. */
export function movesOnClips(clips: readonly Clip[]): MoveMatch[] {
  if (clips.length === 0) return []
  const ctx = moveContext()
  const options = matchOptions(ctx)
  const first = runsOf(clips[0], ctx, options)
  if (first.length === 0) return []
  for (let i = 1; i < clips.length; i++) {
    const next = runsOf(clips[i], ctx, options)
    if (next.length !== first.length || next.some((r, n) => r.id !== first[n].id)) return []
  }
  return first
}
