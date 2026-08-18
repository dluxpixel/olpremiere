// The keyboard, for keyframes. Every verb here is aimed at WHATEVER THE MOTION
// RAIL HAS SELECTED, which is why it could not exist before 2026-08-18: the
// rail's selection was component-local `useState` and the central keymap can
// only see the store. → D118
//
// ⛔ ONE MEANING PER KEY. Alt+Left nudges "the selection" one frame, and the
// selection is diamonds when he has diamonds and clips otherwise. It is not a
// mode: nothing is held down, nothing is toggled, and there is no state he has
// to remember being in. `motionKeyTarget()` is the whole of that decision and
// every overloaded binding asks it the same question.
//
// ⛔ AND THE GATE IS `handTuneOpen`, NOT just "are there picks". Diamonds are
// only DRAWN while that door is open (EffectControls passes it as the rail's
// `lanes`), and a key that silently edits something off screen is the worst kind
// of surprise. Closed door, closed keyboard: Alt+Left goes back to the clip.

import { activeSequence, type AnimChannel, type Clip, type Keyframe } from '../engine/types'
import { channelKeyframes } from '../engine/effects/channels'
import { MOMENT_EPS } from '../engine/keyframes'
import { clipDurationS } from '../engine/timeline'
import {
  addKeyframeAtTime,
  moveKeyframes,
  removeKeyframes,
  scaleKeyframeSpan,
  stampKeyframes,
  type KeyframePick,
} from './clipEdits'
import { useStore, type MotionSelection } from './store'

/** How much one press of the stretch keys changes the length of a selection. */
export const STRETCH_STEP = 1.1

/** What the keyframe verbs act on, or null when the clip keys should have the press. */
export interface MotionKeyTarget {
  clipId: string
  clip: Clip
  picks: readonly KeyframePick[]
  fps: number
}

export function motionKeyTarget(): MotionKeyTarget | null {
  const s = useStore.getState()
  if (!s.ui.handTuneOpen) return null
  const picks = s.ui.motionPicks
  if (picks.length === 0) return null
  const clipId = s.ui.selection[0]
  if (!clipId) return null
  const seq = activeSequence(s.project)
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!clip) return null
  return { clipId, clip, picks, fps: seq.fps }
}

/**
 * Move the picked diamonds by whole frames, and carry the SELECTION with them.
 *
 * ⛔ THE PICKS HAVE TO BE RE-AIMED AFTERWARDS or the second press does nothing:
 * a pick is a channel plus a TIME, so once the keyframes have moved, picks still
 * pointing at the old times match no keyframe and `moveKeyframes` returns early.
 * The drag path has always done this through the rail's `shiftPicks`; the
 * keyboard has no rail in scope, so it does the same thing against the store.
 *
 * The distance is read back off the clip rather than assumed, because the action
 * clamps: pressing Alt+Left into the head of the clip moves the selection less
 * than a frame, or not at all, and the picks must follow what LANDED.
 */
export function nudgePicks(frames: number): void {
  const target = motionKeyTarget()
  if (!target) return
  const before = firstPickedTime(target.clip, target.picks)
  moveKeyframes(target.clipId, target.picks, frames / target.fps)
  const after = firstPickedTimeIn(currentClip(target.clipId), target.picks, frames)
  if (after === null || before === null) return
  shiftPicksBy(after - before)
}

/** Drop every picked diamond, in one undo step, and leave nothing selected. */
export function deletePicks(): void {
  const target = motionKeyTarget()
  if (!target) return
  removeKeyframes(target.clipId, target.picks)
  useStore.getState().setUI({ motionSelection: null, motionPicks: [], motionGroupDeltaS: null })
}

/**
 * Make the picked run of diamonds longer or shorter without redrawing it: the
 * whole animation slower or faster, its shape untouched.
 *
 * ⛔ THE ANCHOR IS THE FIRST PICKED DIAMOND, so a move always grows out of where
 * it starts. Anchoring on the playhead was the alternative and is rejected: the
 * playhead is usually somewhere else entirely, and a stretch about a point
 * outside the selection slides the move as well as retiming it, which reads as
 * two edits.
 *
 * This is the door `scaleKeyframeSpan` never had. It was written for an Alt drag
 * and Alt was already spent on copying a diamond, so a finished and tested
 * feature sat unreachable from 2026-08-14 until he gave it these keys. → D115
 */
export function stretchPicks(factor: number): void {
  const target = motionKeyTarget()
  if (!target) return
  const anchor = firstPickedTime(target.clip, target.picks)
  if (anchor === null) return
  scaleKeyframeSpan(target.clipId, target.picks, anchor, factor)
  // Same re-aim as the nudge, by the same rule: every pick keeps its distance
  // from the anchor, scaled. The anchor itself does not move.
  useStore.getState().setUI({
    motionPicks: target.picks.map((p) => ({ ...p, t: anchor + (p.t - anchor) * factor })),
    motionSelection: reaimSelection(anchor, factor),
  })
}

/**
 * The picked diamonds, held between a copy and a paste, with their times
 * RELATIVE to the earliest of them.
 *
 * Relative because absolute times would make paste useless: the whole reason to
 * copy a move is to put it somewhere else, and "somewhere else" is a different
 * moment by definition. A module-level box is the same shape the clip-attributes
 * and the move clipboards already use, and for the same reason: it must not
 * survive a reload, because the clip it was copied from may not.
 */
let picked: { channel: AnimChannel; kf: Keyframe }[] | null = null

export const hasCopiedKeyframes = (): boolean => picked !== null

/**
 * Copy the picked diamonds, shape and all.
 *
 * ⛔ THE EASE AND THE CURVE COME TOO. A copy that carried only times and values
 * would paste a move he liked and hand back a linear one, and nothing on screen
 * would say why it looks worse.
 */
export function copyPicks(): boolean {
  const target = motionKeyTarget()
  if (!target) return false
  const grabbed: { channel: AnimChannel; kf: Keyframe }[] = []
  for (const p of target.picks) {
    const hit = channelKeyframes(target.clip, p.channel).find((k) => Math.abs(k.t - p.t) <= MOMENT_EPS)
    if (hit) grabbed.push({ channel: p.channel, kf: { ...hit } })
  }
  if (grabbed.length === 0) return false
  const head = Math.min(...grabbed.map((g) => g.kf.t))
  picked = grabbed.map((g) => ({ channel: g.channel, kf: { ...g.kf, t: g.kf.t - head } }))
  return true
}

/**
 * Drop the copied diamonds at the PLAYHEAD, on the selected clip, and select
 * what landed.
 *
 * ⛔ THE PLAYHEAD IS THE ANCHOR because a keyboard paste has no other one. A
 * mouse paste could land where the pointer is; a key press cannot, and pasting
 * back on top of the original would look like nothing happened at all.
 *
 * ⛔ IT PASTES ONTO THE SELECTED CLIP, which may not be the clip it was copied
 * from, and that is the point: copying the punch off one clip onto the next is
 * most of why he would reach for this.
 */
export function pastePicks(): boolean {
  if (!picked || picked.length === 0) return false
  const s = useStore.getState()
  if (!s.ui.handTuneOpen) return false
  const clipId = s.ui.selection[0]
  if (!clipId) return false
  const clip = currentClip(clipId)
  if (!clip) return false
  const at = s.ui.playheadS - clip.startS
  if (at < -MOMENT_EPS || at > clipDurationS(clip) + MOMENT_EPS) return false
  const drops = picked.map((g) => ({ channel: g.channel, kf: { ...g.kf, t: g.kf.t + at } }))
  stampKeyframes(clipId, drops)
  useStore.getState().setUI({
    motionPicks: drops.map((d) => ({ channel: d.channel, t: d.kf.t })),
    motionSelection: { channel: drops[0].channel, kind: 'key', t: drops[0].kf.t },
  })
  return true
}

/**
 * Walk the one selected diamond to the one before or after it, ON ITS OWN
 * CHANNEL, and take the picks with it.
 *
 * `[` and `]` already jump the PLAYHEAD across every channel's keyframes at
 * once. This is the other half he had no key for: moving what he is SHAPING,
 * one diamond at a time, without hitting a two-pixel target with the mouse.
 */
export function walkSelection(dir: -1 | 1): void {
  const s = useStore.getState()
  if (!s.ui.handTuneOpen) return
  const sel = s.ui.motionSelection
  const clipId = s.ui.selection[0]
  if (!sel || !clipId) return
  const clip = currentClip(clipId)
  if (!clip) return
  const times = channelKeyframes(clip, sel.channel).map((k) => k.t)
  const to =
    dir < 0 ? times.filter((t) => t < sel.t - MOMENT_EPS).pop() : times.find((t) => t > sel.t + MOMENT_EPS)
  if (to === undefined) return
  s.setUI({ motionSelection: { ...sel, t: to }, motionPicks: [{ channel: sel.channel, t: to }] })
}

/**
 * Put a diamond in the MIDDLE of the selected segment, at the value the
 * animation already has there.
 *
 * ⛔ NOT AT THE PLAYHEAD, and that is the point of it. Every other way to add a
 * keyframe in this app parks the playhead first, which means leaving the shape
 * he is looking at to go and find a moment. A segment is a thing on screen with
 * two ends; the middle of it needs no aim at all. The value comes off the curve
 * so the picture does not jump: it is a handle to drag, not an edit.
 */
export function addKeyframeInSegment(): void {
  const s = useStore.getState()
  if (!s.ui.handTuneOpen) return
  const sel = s.ui.motionSelection
  const clipId = s.ui.selection[0]
  if (!sel || !clipId) return
  const clip = currentClip(clipId)
  if (!clip) return
  const kfs = channelKeyframes(clip, sel.channel)
  const mid = segmentMidpoint(kfs, sel.t, clipDurationS(clip))
  if (mid === null) return
  addKeyframeAtTime(clipId, sel.channel, mid)
  s.setUI({
    motionSelection: { channel: sel.channel, kind: 'key', t: mid },
    motionPicks: [{ channel: sel.channel, t: mid }],
  })
}

/**
 * The middle of the segment LEAVING the keyframe at `fromT`. Null when there is
 * no room for one: the last keyframe on a channel leaves no segment, and a
 * segment shorter than two frames has no middle worth a diamond.
 */
export function segmentMidpoint(
  kfs: readonly Keyframe[],
  fromT: number,
  durS: number,
): number | null {
  const i = kfs.findIndex((k) => Math.abs(k.t - fromT) <= MOMENT_EPS)
  if (i < 0) return null
  const next = kfs[i + 1]
  // The tail of the clip is not a segment: it holds the last value, so a
  // diamond dropped in it would change nothing and could not be dragged
  // anywhere useful either.
  if (!next) return null
  const mid = (kfs[i].t + next.t) / 2
  if (mid - kfs[i].t <= MOMENT_EPS || next.t - mid <= MOMENT_EPS) return null
  return Math.min(Math.max(mid, 0), durS)
}

// --- the small print --------------------------------------------------------

function currentClip(clipId: string): Clip | undefined {
  return activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
}

/** Earliest moment the picks actually land on, on the clip as it stands. */
function firstPickedTime(clip: Clip, picks: readonly KeyframePick[]): number | null {
  let best: number | null = null
  for (const p of picks) {
    const hit = channelKeyframes(clip, p.channel).find((k) => Math.abs(k.t - p.t) <= MOMENT_EPS)
    if (!hit) continue
    if (best === null || hit.t < best) best = hit.t
  }
  return best
}

/**
 * The same, AFTER a move: the picks now point at where the keyframes were, so
 * the match is the nearest keyframe in the direction it travelled rather than
 * one at the pick's own time.
 */
function firstPickedTimeIn(
  clip: Clip | undefined,
  picks: readonly KeyframePick[],
  frames: number,
): number | null {
  if (!clip) return null
  let best: number | null = null
  for (const p of picks) {
    const times = channelKeyframes(clip, p.channel).map((k) => k.t)
    if (times.length === 0) continue
    const near = nearest(times, p.t, frames)
    if (near === null) continue
    if (best === null || near < best) best = near
  }
  return best
}

/** Nearest time to `t`, preferring the side the nudge went. */
function nearest(times: readonly number[], t: number, frames: number): number | null {
  const side = frames < 0 ? times.filter((x) => x <= t) : times.filter((x) => x >= t)
  const pool = side.length > 0 ? side : times
  return pool.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
}

function shiftPicksBy(deltaS: number): void {
  if (!Number.isFinite(deltaS) || deltaS === 0) return
  const s = useStore.getState()
  const picks = s.ui.motionPicks
  const moved = new Set(picks.map((p) => key(p.channel, p.t)))
  const sel = s.ui.motionSelection
  s.setUI({
    motionPicks: picks.map((p) => ({ ...p, t: p.t + deltaS })),
    // The highlighted moment follows only if it TRAVELLED, the same rule the
    // rail's own shiftPicks uses.
    motionSelection:
      sel && sel.kind === 'key' && moved.has(key(sel.channel, sel.t)) ? { ...sel, t: sel.t + deltaS } : sel,
  })
}

function reaimSelection(anchor: number, factor: number): MotionSelection | null {
  const sel = useStore.getState().ui.motionSelection
  if (!sel || sel.kind !== 'key') return sel
  return { ...sel, t: anchor + (sel.t - anchor) * factor }
}

const key = (channel: AnimChannel, t: number): string => `${channel}@${t.toFixed(4)}`
