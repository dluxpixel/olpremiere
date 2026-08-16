// Multi-select bulk edits: apply ONE change to every selected clip in ONE undo
// step. The per-clip helpers in clipEdits.ts each open their own dispatch, so
// fanning them out would flood the undo stack, so these route through a single
// mapClips() dispatch instead. Locked tracks are skipped (same choke point as
// mapClip), and a no-op fan-out records no undo step (change detection below).

import { applyAppearanceToClip } from '../engine/anim/appearance'
import {
  channelKeyframes,
  withChannelKeyframes,
  withChannelValue,
  withChannelsAtTime,
} from '../engine/effects/channels'
import { addEffect } from '../engine/effects/ops'
import { getEffect } from '../engine/effects/registry'
import { upsertKeyframe } from '../engine/keyframes'
import { MOTION_CURVES } from '../engine/motion'
import { clipDurationS, clipEndS } from '../engine/timeline'
import { activeSequence, newId, type AnimChannel, type Clip, type Curve, type Keyframe } from '../engine/types'
// isClipArmed comes from the SINGLE-clip module on purpose: the multi-select
// align has to ask the exact question the gizmo asks, off the exact same code,
// or the two paths drift the way they did when one read a global preference.
import { isClipArmed, playheadLocalT } from './clipEdits'
import { noteRecentEffect } from './recentEffects'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

/**
 * The shape every keyframe this module commits leaves behind, read from the ONE
 * curve table so a bulk commit and the single-clip commit in clipEdits.ts can
 * never write two different moves for the same gesture.
 *
 * `ease` stays the named fallback UNDER the curve: a keyframe's ease describes
 * the segment leaving it, so it is the shape the segment falls back to if the
 * curve is ever cleared in the editor.
 */
const moveCommit = (): { ease: Keyframe['ease']; curve?: Curve } => {
  const curve: Curve | undefined = MOTION_CURVES[useStore.getState().ui.moveCurve]
  return curve ? { ease: 'linear', curve } : { ease: 'linear' }
}

/**
 * Map `fn` over every selected clip that lives on an unlocked track, as a
 * single undoable edit. Unchanged clips (fn returns the same reference) are left
 * alone, and if nothing changes at all the sequence is returned untouched so no
 * empty command lands on the undo stack.
 *
 * `mergeField` names the PROPERTY being scrubbed ('gain', 'fade:in'). Without
 * it every commit is its own undo step, which is why a multi-clip nudge used to
 * cost one Ctrl+Z per arrow press while the single-clip fields cost one per run
 * (setChannel in clipEdits.ts). The key is scoped to this EXACT selection the
 * same way updateTitles does it, so a run on one selection folds into one step
 * and a different selection can never merge into it.
 */
export function mapClips(
  ids: Iterable<string>,
  label: string,
  fn: (clip: Clip) => Clip,
  mergeField?: string,
): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  const mergeKey =
    mergeField === undefined ? undefined : `${mergeField}:${[...idSet].sort().join(',')}`
  updateActiveSequence(label, (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id))) return t
      let tChanged = false
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id)) return c
        const nc = fn(c)
        if (nc !== c) {
          tChanged = true
          changed = true
        }
        return nc
      })
      return tChanged ? { ...t, clips } : t
    })
    return changed ? { ...seq, tracks } : seq
  }, mergeKey)
}

/**
 * Set a channel value on every selected clip. Mirrors the single-clip setChannel:
 * a STATIC channel sets the base; an ANIMATED one (a caption's pop, a punch-in)
 * keys the value at the playhead. Otherwise the base write is overridden by the
 * keyframes and the bulk edit silently does nothing.
 */
export function setChannelForClips(ids: Iterable<string>, channel: AnimChannel, value: number): void {
  // One read for the whole fan-out, so twelve clips cannot end up carrying two
  // different curves because the chip changed mid-dispatch.
  const commit = moveCommit()
  mapClips(
    ids,
    `Set ${channel}`,
    (c) => {
      const kfs = channelKeyframes(c, channel)
      if (kfs.length === 0) return withChannelValue(c, channel, value)
      const localT = playheadLocalT(c)
      return withChannelKeyframes(c, channel, upsertKeyframe(kfs, { t: localT, value, ...commit }))
    },
    // Per channel, so nudging Opacity and then Scale still leaves two steps.
    `channel:${channel}`,
  )
}

/**
 * Align every selected clip to the SAME on-screen position (x, y) in one undo
 * step: dragging one caption in the preview snaps them all to that spot.
 *
 * Obeys the SAME per-channel policy as the single-clip gizmo
 * (`withChannelsAtTime`), asks the SAME armed question of each clip
 * (`isClipArmed`), and writes the SAME curve. It used to write `transform.x/y`
 * unconditionally, and then it read the GLOBAL auto-keyframe setting while the
 * gizmo had already moved on: either way one drag animated the clip under the
 * gizmo and permanently MOVED the rest of the selection. One gesture means one
 * thing whether one clip is selected or twelve.
 *
 * Armed is asked PER CLIP because it is a per-clip fact: a selection can hold
 * one clip already carrying motion and one that is still, and each takes the
 * branch its own keyframes earn.
 */
export function setClipsPosition(ids: Iterable<string>, x: number, y: number): void {
  const { project, ui } = useStore.getState()
  const seq = activeSequence(project)
  const commit = moveCommit()
  mapClips(
    ids,
    'Align clips',
    (c) => {
      // An appearance preset OWNS these channels and recompiles from the base, so
      // it takes the base write; the single-clip gizmo declines to keyframe an
      // appearance-owned clip for exactly the same reason.
      const spec = c.appearance
      if (spec) {
        const moved: Clip = { ...c, transform: { ...c.transform, x, y } }
        return applyAppearanceToClip(moved, spec, seq.width, seq.height)
      }
      // Only a clip the playhead is actually INSIDE has a meaningful time to key
      // at. A selection can reach clips elsewhere on the timeline, and their local
      // time clamps to the head or the tail, and animating those would be noise the
      // user never asked for, so they keep the plain move.
      const localT = ui.playheadS - c.startS
      if (localT < 0 || ui.playheadS >= clipEndS(c)) {
        return withChannelValue(withChannelValue(c, 'posX', x), 'posY', y)
      }
      return withChannelsAtTime(c, localT, [['posX', x], ['posY', y]], isClipArmed(c), commit)
    },
    // One drag of the preview gizmo commits once on release, but the arrow keys
    // that nudge the same selection commit per press.
    'position',
  )
}

/** Add one fresh instance of an effect to every selected clip (own id each). */
export function applyEffectToClips(ids: Iterable<string>, type: string): void {
  const label = getEffect(type)?.label ?? type
  // Skip audio clips the way the single-clip applyEffect does (clipEdits.ts): a
  // visual effect on an audio clip stores a card, costs an undo and renders
  // nothing. A mixed selection applies to its visual clips only.
  const seq = activeSequence(useStore.getState().project)
  const audioIds = new Set(
    seq.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips.map((c) => c.id)),
  )
  const requested = [...ids]
  const visual = requested.filter((id) => !audioIds.has(id))
  if (visual.length === 0) {
    // Double-clicking an effect with nothing (or only audio) selected used to do
    // absolutely nothing, silently. The browser row is always usable, so the
    // reason it did not land has to be said out loud.
    useToasts
      .getState()
      .show(
        requested.length === 0 ? 'Select a clip first' : 'Effects don’t apply to audio clips',
        'danger',
      )
    return
  }
  mapClips(visual, `Add ${label}`, (c) => addEffect(c, type, newId()))
  // The browser's double-click, its right-click menu and the drop all arrive
  // here, so this is where most of his real usage gets remembered.
  noteRecentEffect(type)
}

/**
 * Add one fresh instance of an effect to EVERY video clip in the active
 * sequence, all in ONE undo step, no selection needed. Audio clips are skipped
 * (a visual effect means nothing on them) and locked tracks are skipped by
 * mapClips. Mirrors applyPresetToAllClips in library.ts.
 */
export function applyEffectToAllClips(type: string): void {
  const show = useToasts.getState().show
  const label = getEffect(type)?.label ?? type
  const ids = activeSequence(useStore.getState().project)
    .tracks.filter((t) => t.kind === 'video' && !t.locked)
    .flatMap((t) => t.clips.map((c) => c.id))
  if (ids.length === 0) {
    show(`No video clips to apply ${label} to`)
    return
  }
  applyEffectToClips(ids, type)
  show(`Applied "${label}" to ${ids.length} clip${ids.length === 1 ? '' : 's'}`, 'success')
}

/** Drop every applied effect from every selected clip. */
export function clearEffectsForClips(ids: Iterable<string>): void {
  mapClips(ids, 'Clear effects', (c) => (c.effects.length === 0 ? c : { ...c, effects: [] }))
}

/** Set the same gain (dB) on every selected clip. Keyframe-aware per clip:
 *  an animated volume channel overrides the base, so those clips get a
 *  keyframe at the playhead instead of a dead base write. */
export function setClipsGainDb(ids: Iterable<string>, db: number): void {
  mapClips(
    ids,
    'Set volume',
    (c) => {
      const kfs = channelKeyframes(c, 'volume')
      if (kfs.length > 0) {
        return withChannelKeyframes(c, 'volume', upsertKeyframe(kfs, { t: playheadLocalT(c), value: db, ease: 'linear' }))
      }
      return c.audioGainDb === db ? c : { ...c, audioGainDb: db }
    },
    'gain',
  )
}

const clampFade = (s: number, dur: number): number => (s < 0 ? 0 : s > dur ? dur : s)

/** Set the same fade in/out length (seconds) on every selected clip, clamped per clip. */
export function setClipsFade(ids: Iterable<string>, edge: 'in' | 'out', seconds: number): void {
  const key = edge === 'in' ? 'fadeInS' : 'fadeOutS'
  mapClips(
    ids,
    edge === 'in' ? 'Set fade in' : 'Set fade out',
    (c) => {
      const v = clampFade(seconds, clipDurationS(c))
      return c[key] === v ? c : { ...c, [key]: v }
    },
    // Per edge, so a fade-in run and a fade-out run stay two undo steps.
    `fade:${edge}`,
  )
}
