import { linkGroupIndex, recomputeDuration } from './timeline'
import { clipEndS, type Clip, type Id, type Sequence } from './types'

/**
 * ⛔ A CLIP DRAG MOVES ONE RIGID BLOCK. Rebuilt from scratch on 2026-10-03.
 *
 * His words that day: *"sometimes when i drag audio or video clips lanes it deleted the clip
 * behind it fix that, and lastly the dragging feature is still so shit! ... make it so when i
 * select multiple stuff and drag it anywhere it actually works and stays in the SAME SHAPE as when
 * i dragged it"*.
 *
 * The drag that came before this file was a pile of patches, each one right about the bug in front
 * of it, and the pile was wrong as a whole. Two hunts fuzzed it and proved, among others:
 *
 * - **It still carved.** The 2026-08-15 ban on carving held on the clip's own lane only. On another
 *   lane the "nearest free start" fell back to the clip's OLD time without checking the new lane,
 *   and the overwrite move underneath then deleted or split whatever was there. That is his "it
 *   deleted the clip behind it", and it fired on 13 percent of random cross-lane drags.
 * - **It placed the carried clips one at a time**, each with its own gap search, so any one of them
 *   meeting an obstacle was shoved somewhere else on its own and the selection tore apart. The
 *   grabbed clip treated the OTHER selected clips as walls, so a selected run of butted clips could
 *   not move at all unless he grabbed its leading clip. Lanes were clamped per clip, so a two-lane
 *   selection dragged to the top of the stack collapsed onto one lane. Only the grabbed clip was
 *   clamped at zero, so dragging left squashed the gaps of everything before it.
 *
 * So the rule is now one sentence, and everything below is that sentence:
 *
 * **The dragged set is ONE block. It moves by ONE time delta and ONE lane delta, computed from the
 * original sequence with the whole block lifted out, and it lands only where every clip of it is
 * free. Nothing outside the block is ever touched.**
 *
 * - Every gap, lane offset, length and setting inside the block stays exactly as it was. A single
 *   clip is a block of one.
 * - The lane delta is counted in lanes of the GRABBED clip's kind (2026-08-06, *"when I drag one
 *   clip, for example, from v6 to v5, it should drag all"*). Clips of the other kind keep their
 *   lane and travel in time. If any clip of the block would leave the stack or land on a locked
 *   lane, the lane delta comes back toward zero for the whole block, never per clip.
 * - If the block's exact spot is taken on any lane, the WHOLE block goes to the nearest time delta
 *   where it fits, searching both ways along the same lanes, a tie going the way he dragged. It is
 *   never squeezed, split or reshuffled to fit. It is clamped at zero as a block.
 * - It always moves when there is any legal spot (his 2026-08-12 report: *"It has one function, and
 *   it can't even do that"*), and it never lands on anything (2026-08-15: *"remove that feature and
 *   I never wanna see it again"*). Those two used to fight because the only way to always move on a
 *   packed lane was to overwrite. Searching for the nearest legal delta for the block as a whole
 *   gives both: the preview shows him exactly where it will land at every point of the drag.
 *
 * The live preview and the release both run `moveBlock` with the same inputs (timelineGestures.ts
 * `moveStep` and `dragCommit`), so what he sees while dragging is exactly what lands.
 */

const EPS = 1e-9

/**
 * The clips one drag carries: his selection as it stands after the press, the grabbed clip always
 * included.
 *
 * ⛔ A LINKED PARTNER TRAVELS ONLY WHEN IT IS SELECTED TOO. His words, 2026-08-05: *"when I drag the
 * video clip, it automatically drags the audio clip. Can you make it so the audio and video clips
 * can be dragged separately?"* And 2026-08-12, after a multi-clip drag still dragged partners he
 * never picked: *"When I fucking drag, it drags the audio with the video clip to and other the way
 * around."* So every selected clip answers the same question: is its whole link group selected?
 * Then the group travels together, which is how he keeps a pair in sync. If not, only that clip
 * moves. One rule for the clip under his cursor and for every clip travelling with it.
 *
 * A clip on a locked track never moves. A pair with one half locked stays where it is as a pair,
 * because moving only the free half would put it out of sync (that is what the old drag did). If
 * that pair is the one he grabbed, the answer is an empty block and the drag moves nothing.
 */
export function dragBlockIds(seq: Sequence, selection: readonly Id[], grabbedId: Id): Id[] {
  const selected = new Set(selection)
  selected.add(grabbedId)
  const byLink = linkGroupIndex(seq)
  const clipById = new Map<Id, Clip>()
  const locked = new Set<Id>()
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      clipById.set(c.id, c)
      if (t.locked) locked.add(c.id)
    }
  }
  const grabbed = clipById.get(grabbedId)
  if (!grabbed) return []
  const unitOf = (c: Clip): Id[] => {
    const group = c.linkId ? (byLink.get(c.linkId) ?? [c.id]) : [c.id]
    return group.every((g) => selected.has(g)) ? group : [c.id]
  }

  const block = new Set<Id>()
  const grabbedUnit = unitOf(grabbed)
  if (grabbedUnit.some((id) => locked.has(id))) return []
  for (const id of grabbedUnit) block.add(id)
  for (const id of selected) {
    const c = clipById.get(id)
    if (!c || block.has(id)) continue
    const unit = unitOf(c)
    if (unit.some((u) => locked.has(u))) continue
    for (const u of unit) block.add(u)
  }
  // Sequence order, so the answer never depends on the order he happened to select things in.
  const out: Id[] = []
  for (const t of seq.tracks) for (const c of t.clips) if (block.has(c.id)) out.push(c.id)
  return out
}

/** One clip of the block: the clip as it was, the track it is on, the track the move sends it to. */
interface Member {
  clip: Clip
  from: number
  to: number
}

/** Where the block goes: one time delta, one lane delta, and each clip's destination track. */
export interface BlockMovePlan {
  deltaS: number
  laneShift: number
  members: readonly Member[]
}

/**
 * The lane delta the whole block can take, as close to `requested` as it can get without passing
 * it. Every clip of the grabbed kind must land on a lane that exists and is not locked; if one
 * cannot, the block comes back toward zero TOGETHER. Zero is always legal, because a block clip
 * is never on a locked lane to begin with.
 *
 * Walking from zero toward the request and keeping the farthest legal shift lets the block hop
 * over a locked lane to an open one beyond it, the same thing a single clip could always do, and
 * stops it at the edge of the stack.
 */
function fitLaneShift(
  seq: Sequence,
  members: readonly { from: number }[],
  lanes: readonly number[],
  laneOf: ReadonlyMap<number, number>,
  requested: number,
): number {
  if (requested === 0) return 0
  const step = Math.sign(requested)
  let best = 0
  for (let s = step; Math.abs(s) <= Math.abs(requested); s += step) {
    if (laneShiftFits(seq, members, lanes, laneOf, s)) best = s
  }
  return best
}

/** Does every clip of the grabbed kind land on a lane that exists and is open, shifted by `s`? */
function laneShiftFits(
  seq: Sequence,
  members: readonly { from: number }[],
  lanes: readonly number[],
  laneOf: ReadonlyMap<number, number>,
  s: number,
): boolean {
  if (s === 0) return true
  return members.every((m) => {
    const p = laneOf.get(m.from)
    if (p === undefined) return true // the other kind: keeps its lane
    const q = p + s
    return q >= 0 && q < lanes.length && !seq.tracks[lanes[q]!]!.locked
  })
}

/** Is the block free at `deltaS`: no clip of it on top of any clip outside it, on any lane? */
function fitsAt(seq: Sequence, members: readonly Member[], inBlock: ReadonlySet<Id>, deltaS: number): boolean {
  for (const m of members) {
    const s = m.clip.startS + deltaS
    const e = clipEndS(m.clip) + deltaS
    for (const c of seq.tracks[m.to]!.clips) {
      if (inBlock.has(c.id)) continue
      if (s < clipEndS(c) - EPS && e > c.startS + EPS) return false
    }
  }
  return true
}

/**
 * The legal time delta nearest to `wantS` for the whole block on its destination lanes.
 *
 * Every pair of (block clip, clip outside the block on that clip's destination lane) rules out an
 * open window of deltas: from where the block clip's tail would touch the other clip's head to
 * where its head would touch the other clip's tail. The union of those windows is everything the
 * block cannot do. `wantS` either lies outside it (it fits exactly where he let go) or inside one
 * connected stretch of it, whose two ends are the nearest legal spots behind and ahead.
 *
 * The left end is legal only if it keeps the block at or after zero. A tie goes the way he dragged.
 * The answer is checked once more against the clips themselves, so a rounding edge in the window
 * arithmetic can never hand back a spot that overlaps; past every clip on every lane always fits.
 */
function nearestFreeDelta(
  seq: Sequence,
  members: readonly Member[],
  inBlock: ReadonlySet<Id>,
  wantS: number,
  dragDir: number,
): number {
  let minStart = Infinity
  for (const m of members) minStart = Math.min(minStart, m.clip.startS)
  const floor = -minStart
  const w = Math.max(floor, wantS)
  if (fitsAt(seq, members, inBlock, w)) return w

  const windows: [number, number][] = []
  for (const m of members) {
    const bs = m.clip.startS
    const be = clipEndS(m.clip)
    for (const c of seq.tracks[m.to]!.clips) {
      if (inBlock.has(c.id)) continue
      windows.push([c.startS - be, clipEndS(c) - bs])
    }
  }
  windows.sort((a, b) => a[0] - b[0])

  // Merge into connected stretches. Two windows join only when they overlap by more than the
  // tolerance: where one ends exactly as the next begins, the block fits there exactly, butted on
  // both sides, and that spot is legal.
  const stretches: [number, number][] = []
  for (const [lo, hi] of windows) {
    const last = stretches[stretches.length - 1]
    if (last && lo < last[1] - 2 * EPS) last[1] = Math.max(last[1], hi)
    else stretches.push([lo, hi])
  }

  const candidates: number[] = []
  const home = stretches.find(([lo, hi]) => lo + EPS < w && w < hi - EPS)
  if (home) {
    const [lo, hi] = home
    const leftOk = lo >= floor - EPS
    const dl = w - lo
    const dr = hi - w
    const preferLeft = leftOk && (dl < dr - EPS || (Math.abs(dl - dr) <= EPS && dragDir < 0))
    if (preferLeft) candidates.push(Math.max(floor, lo), hi)
    else {
      candidates.push(hi)
      if (leftOk) candidates.push(Math.max(floor, lo))
    }
  }
  for (const c of candidates) if (fitsAt(seq, members, inBlock, c)) return c

  // Only a rounding edge can get here. Walk every stretch end outward from where he let go and
  // take the nearest that really fits; the end of the last stretch is past everything.
  const ends = stretches
    .flatMap(([lo, hi]) => [lo, hi])
    .filter((d) => d >= floor - EPS)
    .map((d) => Math.max(floor, d))
    .sort((a, b) => Math.abs(a - w) - Math.abs(b - w))
  for (const d of ends) if (fitsAt(seq, members, inBlock, d)) return d
  return stretches.length > 0 ? stretches[stretches.length - 1]![1] : w
}

/**
 * How a drag weighs the lanes against time when the lane he aims at has no room near his hand.
 *
 * ⛔ A LANE WITH NO ROOM NEAR THE POINTER IS NOT WORTH A FLIGHT, 2026-10-03. Measured through the
 * real mouse that day: an overlay pulled from V2 down onto a packed V1 at 10 s landed at 60 s,
 * fifty seconds from his hand and so far off the screen the preview was not even drawn; with a
 * hole at 40 s it landed at 40 s. That WAS the nearest legal spot on the lane he aimed at, and it
 * was nowhere near where he was looking. "Nearest" is now measured the way he sees it: every lane
 * short of the one he aims at costs `laneCostS` seconds of sideways miss. A spot on his aimed lane
 * wins while it is close to his hand; when it is not, the block settles on the nearest lane toward
 * its own that has room there, and keeps following his hand in time. Its own lanes always have
 * room near the hand (it came from there), so the answer is never far from where he points.
 *
 * Absent (no pointer, no screen to measure on), the aimed lane always wins, however far the time.
 */
export interface BlockMoveOptions {
  laneCostS?: number
}

/**
 * Where a drag of `blockIds`, holding `grabbedId`, aimed at `targetTrackId` with the grabbed clip
 * starting at `tS`, actually lands. Pure; reads only the sequence it is given.
 *
 * `targetTrackId` is the lane the pointer is aimed at. A lane of the other kind, or one that does
 * not exist, means no lane change.
 */
export function planBlockMove(
  seq: Sequence,
  blockIds: readonly Id[],
  grabbedId: Id,
  targetTrackId: Id,
  tS: number,
  opts: BlockMoveOptions = {},
): BlockMovePlan {
  const inBlock = new Set(blockIds)
  const none: BlockMovePlan = { deltaS: 0, laneShift: 0, members: [] }
  if (!inBlock.has(grabbedId)) return none

  const found: { clip: Clip; from: number }[] = []
  let grabbed: Clip | undefined
  let grabbedTrack = -1
  seq.tracks.forEach((t, i) => {
    for (const c of t.clips) {
      if (!inBlock.has(c.id)) continue
      found.push({ clip: c, from: i })
      if (c.id === grabbedId) {
        grabbed = c
        grabbedTrack = i
      }
    }
  })
  if (!grabbed) return none
  // A locked track rejects every edit. dragBlockIds never puts such a clip in a block, and a block
  // handed in from elsewhere that holds one does not move at all rather than tearing.
  if (found.some((m) => seq.tracks[m.from]!.locked)) return none

  const kind = seq.tracks[grabbedTrack]!.kind
  const lanes: number[] = []
  const laneOf = new Map<number, number>()
  seq.tracks.forEach((t, i) => {
    if (t.kind !== kind) return
    laneOf.set(i, lanes.length)
    lanes.push(i)
  })
  const targetIdx = seq.tracks.findIndex((t) => t.id === targetTrackId)
  const requested =
    targetIdx >= 0 && seq.tracks[targetIdx]!.kind === kind ? laneOf.get(targetIdx)! - laneOf.get(grabbedTrack)! : 0
  const membersAt = (s: number): Member[] =>
    found.map((m) => {
      const p = laneOf.get(m.from)
      return { ...m, to: p === undefined ? m.from : lanes[p + s]! }
    })
  const wantS = tS - grabbed.startS
  const deltaAt = (members: readonly Member[]): number => {
    const d = nearestFreeDelta(seq, members, inBlock, wantS, Math.sign(wantS))
    return Math.abs(d) <= EPS ? 0 : d
  }

  const laneCostS = opts.laneCostS ?? Infinity
  if (!(laneCostS < Infinity) || requested === 0) {
    const laneShift = fitLaneShift(seq, found, lanes, laneOf, requested)
    const members = membersAt(laneShift)
    return { deltaS: deltaAt(members), laneShift, members }
  }

  // Every legal lane delta from the aimed one back to zero, each at its own nearest legal time,
  // costed as he sees it: the time missed plus `laneCostS` for every lane short of the aim. The
  // walk starts at the aimed lane, so an exact tie keeps the lane he points at, and it stops as
  // soon as the lanes alone cost more than the best spot found. Zero always fits.
  let minStart = Infinity
  for (const m of found) minStart = Math.min(minStart, m.clip.startS)
  const w = Math.max(-minStart, wantS)
  let best: BlockMovePlan | null = null
  let bestCost = Infinity
  for (let s = requested; ; s -= Math.sign(requested)) {
    const short = Math.abs(requested - s) * laneCostS
    if (short > bestCost + EPS) break
    if (laneShiftFits(seq, found, lanes, laneOf, s)) {
      const members = membersAt(s)
      const deltaS = deltaAt(members)
      const cost = Math.abs(deltaS - w) + short
      if (cost < bestCost - EPS) {
        best = { deltaS, laneShift: s, members }
        bestCost = cost
      }
    }
    if (s === 0) break
  }
  return best!
}

/**
 * The drag itself: `planBlockMove`, then the block lifted out and set down by its one delta. Every
 * clip outside the block keeps its object identity, and a drag that lands where it started hands
 * back the SAME sequence, so it writes nothing into his undo history.
 */
export function moveBlock(
  seq: Sequence,
  blockIds: readonly Id[],
  grabbedId: Id,
  targetTrackId: Id,
  tS: number,
  opts: BlockMoveOptions = {},
): Sequence {
  return applyBlockPlan(seq, planBlockMove(seq, blockIds, grabbedId, targetTrackId, tS, opts))
}

/**
 * Set a planned block down: lifted out, moved by its one delta onto its lanes. Split from moveBlock
 * so a pointermove that already holds the plan (timelineGestures.moveStep) does not work it out a
 * second time; on a 150 clip block the plan is most of a move's cost.
 */
export function applyBlockPlan(seq: Sequence, plan: BlockMovePlan): Sequence {
  if (plan.members.length === 0 || (plan.deltaS === 0 && plan.laneShift === 0)) return seq

  const lifted = new Map<number, Set<Id>>()
  const landing = new Map<number, Clip[]>()
  for (const m of plan.members) {
    if (!lifted.has(m.from)) lifted.set(m.from, new Set())
    lifted.get(m.from)!.add(m.clip.id)
    if (!landing.has(m.to)) landing.set(m.to, [])
    // Only the start changes. Math.max only ever absorbs a rounding crumb: the delta already keeps
    // the earliest clip at or after zero.
    landing.get(m.to)!.push({ ...m.clip, startS: Math.max(0, m.clip.startS + plan.deltaS) })
  }
  const tracks = seq.tracks.map((t, i) => {
    const out = lifted.get(i)
    const into = landing.get(i)
    if (!out && !into) return t
    const kept = out ? t.clips.filter((c) => !out.has(c.id)) : t.clips
    const clips = into ? [...kept, ...into].sort((a, b) => a.startS - b.startS) : kept
    return { ...t, clips }
  })
  return recomputeDuration({ ...seq, tracks })
}

/**
 * Every edge of the block as it sits now, the grabbed clip's head and tail first so they win an
 * exact tie, the way the single-clip snap always preferred the head.
 */
export function blockEdges(seq: Sequence, blockIds: readonly Id[], grabbedId: Id): number[] {
  const inBlock = new Set(blockIds)
  const head: number[] = []
  const rest: number[] = []
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      if (!inBlock.has(c.id)) continue
      if (c.id === grabbedId) head.push(c.startS, clipEndS(c))
      else rest.push(c.startS, clipEndS(c))
    }
  }
  return [...head, ...rest]
}

/** The point in a sorted list nearest to `t`, the earlier one on an exact tie. */
function nearestPoint(points: readonly number[], t: number): number | undefined {
  if (points.length === 0) return undefined
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid]! < t) lo = mid + 1
    else hi = mid
  }
  const after = points[lo]
  const before = points[lo - 1]
  if (before === undefined) return after
  if (after === undefined) return before
  return t - before <= after - t ? before : after
}

/**
 * ⛔ THE BLOCK SNAPS AS A BLOCK. One shared delta: every edge of every clip in the block is tried
 * against the snap points (which never include the block's own clips), the closest catch wins, and
 * that one correction applies to all of them. Snapping only the grabbed clip meant a selection could
 * never line its OTHER clips up with anything, and a carried clip landing a frame off a cut was
 * exactly the kind of shape change he asked to be rid of.
 *
 * `points` must be sorted ascending (snapPointCache and collectSnapPoints both are).
 */
export function snapBlockDelta(
  edges: readonly number[],
  deltaS: number,
  points: readonly number[],
  thresholdS: number,
): { deltaS: number; indicatorT: number | null } {
  let bestDist = Infinity
  let bestDelta = deltaS
  let bestT: number | null = null
  for (const e of edges) {
    const t = e + deltaS
    const p = nearestPoint(points, t)
    if (p === undefined) continue
    const d = Math.abs(p - t)
    // Strict: the earlier edge in the list keeps an exact tie (the grabbed head first).
    if (d < bestDist) {
      bestDist = d
      bestDelta = p - e
      bestT = p
    }
  }
  return bestDist <= thresholdS ? { deltaS: bestDelta, indicatorT: bestT } : { deltaS, indicatorT: null }
}
