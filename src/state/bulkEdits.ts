// Multi-select bulk edits: apply ONE change to every selected clip in ONE undo
// step. The per-clip helpers in clipEdits.ts each open their own dispatch, so
// fanning them out would flood the undo stack — these route through a single
// mapClips() dispatch instead. Locked tracks are skipped (same choke point as
// mapClip), and a no-op fan-out records no undo step (change detection below).

import { applyAppearanceToClip } from '../engine/anim/appearance'
import { channelKeyframes, withChannelKeyframes, withChannelValue } from '../engine/effects/channels'
import { addEffect } from '../engine/effects/ops'
import { getEffect } from '../engine/effects/registry'
import { upsertKeyframe } from '../engine/keyframes'
import { clipDurationS } from '../engine/timeline'
import { activeSequence, newId, type AnimChannel, type Clip } from '../engine/types'
import { playheadLocalT } from './clipEdits'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

/**
 * Map `fn` over every selected clip that lives on an unlocked track, as a
 * single undoable edit. Unchanged clips (fn returns the same reference) are left
 * alone, and if nothing changes at all the sequence is returned untouched so no
 * empty command lands on the undo stack.
 */
export function mapClips(ids: Iterable<string>, label: string, fn: (clip: Clip) => Clip): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
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
  })
}

/**
 * Set a channel value on every selected clip. Mirrors the single-clip setChannel:
 * a STATIC channel sets the base; an ANIMATED one (a caption's pop, a punch-in)
 * keys the value at the playhead — otherwise the base write is overridden by the
 * keyframes and the bulk edit silently does nothing.
 */
export function setChannelForClips(ids: Iterable<string>, channel: AnimChannel, value: number): void {
  mapClips(ids, `Set ${channel}`, (c) => {
    const kfs = channelKeyframes(c, channel)
    if (kfs.length === 0) return withChannelValue(c, channel, value)
    const localT = playheadLocalT(c)
    return withChannelKeyframes(c, channel, upsertKeyframe(kfs, { t: localT, value, ease: 'linear' }))
  })
}

/**
 * Align every selected clip to the SAME on-screen position (x, y) in one undo
 * step — dragging one caption in the preview snaps them all to that spot. A clip
 * with an entrance/exit animation re-derives its keyframes from the new base.
 */
export function setClipsPosition(ids: Iterable<string>, x: number, y: number): void {
  const seq = activeSequence(useStore.getState().project)
  mapClips(ids, 'Align clips', (c) => {
    const moved: Clip = { ...c, transform: { ...c.transform, x, y } }
    return moved.appearance ? applyAppearanceToClip(moved, moved.appearance, seq.width, seq.height) : moved
  })
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
}

/**
 * Add one fresh instance of an effect to EVERY video clip in the active
 * sequence — ONE undo step, no selection needed. Audio clips are skipped
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
  mapClips(ids, 'Set volume', (c) => {
    const kfs = channelKeyframes(c, 'volume')
    if (kfs.length > 0) {
      return withChannelKeyframes(c, 'volume', upsertKeyframe(kfs, { t: playheadLocalT(c), value: db, ease: 'linear' }))
    }
    return c.audioGainDb === db ? c : { ...c, audioGainDb: db }
  })
}

const clampFade = (s: number, dur: number): number => (s < 0 ? 0 : s > dur ? dur : s)

/** Set the same fade in/out length (seconds) on every selected clip, clamped per clip. */
export function setClipsFade(ids: Iterable<string>, edge: 'in' | 'out', seconds: number): void {
  const key = edge === 'in' ? 'fadeInS' : 'fadeOutS'
  mapClips(ids, edge === 'in' ? 'Set fade in' : 'Set fade out', (c) => {
    const v = clampFade(seconds, clipDurationS(c))
    return c[key] === v ? c : { ...c, [key]: v }
  })
}
