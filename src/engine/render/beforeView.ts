// The "Before" picture: the sequence as it looks with its effects off.
//
// His ask, 2026-10-08: hold a key or a button and see the picture without the
// effects, to compare. It is a VIEW and nothing else: it is built from the same
// project the renderer draws, never written back, so it adds no undo entry and
// moves no clip.
//
// ⛔ STRIP THE SEQUENCE, NOT THE FRAME. Two things in a resolved frame look
// like effect carriers and are not: the blurred backdrop is a layer that shares
// the source clip's clipId (so dropping a clip's effects by clipId would take
// the backdrop's own blur with it and leave the bars black), and an adjustment
// op has no clipId at all. Emptying `effects` on the clips before the frame is
// resolved leaves the backdrop's private blur alone and turns an adjustment
// layer into an adjustment op with nothing in it, which dropIdleAdjustments
// then removes.

import type { Clip, Id, Sequence } from '../types'
import type { RenderFrame } from './types'

/** Which clips lose their effects: the ones he picked, or every clip. */
export type BeforeScope = ReadonlySet<Id> | 'all'

/**
 * The clips the Before picture applies to: his selected VIDEO-track clips, or
 * every clip when none of those is selected. A selection of audio clips alone
 * does not narrow it, since audio carries no picture effects to compare.
 */
export function beforeScopeFor(seq: Sequence, selection: readonly Id[]): BeforeScope {
  if (selection.length === 0) return 'all'
  const picked = new Set(selection)
  const scope = new Set<Id>()
  for (const track of seq.tracks) {
    if (track.kind !== 'video') continue
    for (const clip of track.clips) if (picked.has(clip.id)) scope.add(clip.id)
  }
  return scope.size > 0 ? scope : 'all'
}

const inScope = (scope: BeforeScope, clip: Clip): boolean => scope === 'all' || scope.has(clip.id)

// One entry per sequence: the draw loop asks for the same view on every frame
// of a hold, and an edit makes a new sequence, so a stale entry is never read.
const cache = new WeakMap<Sequence, { scope: BeforeScope; view: Sequence }>()

/**
 * A copy of the sequence with `effects: []` on the scoped video clips. Returns
 * the sequence itself when nothing in scope carries an effect, so a hold on a
 * plain project costs nothing and compares equal.
 */
export function beforeView(seq: Sequence, scope: BeforeScope): Sequence {
  const hit = cache.get(seq)
  if (hit && hit.scope === scope) return hit.view
  let changed = false
  const tracks = seq.tracks.map((track) => {
    if (track.kind !== 'video') return track
    let trackChanged = false
    const clips = track.clips.map((clip) => {
      if (clip.effects.length === 0 || !inScope(scope, clip)) return clip
      trackChanged = true
      return { ...clip, effects: [] }
    })
    if (!trackChanged) return track
    changed = true
    return { ...track, clips }
  })
  const view = changed ? { ...seq, tracks } : seq
  cache.set(seq, { scope, view })
  return view
}

/**
 * Remove adjustment ops that have no effects left. They draw nothing, but they
 * would still force the renderer onto its accumulation path for the frame.
 * Returns the same frame when there is nothing to remove.
 */
export function dropIdleAdjustments(frame: RenderFrame): RenderFrame {
  if (!frame.ops.some((op) => op.type === 'adjustment' && op.effects.length === 0)) return frame
  return { ...frame, ops: frame.ops.filter((op) => !(op.type === 'adjustment' && op.effects.length === 0)) }
}
