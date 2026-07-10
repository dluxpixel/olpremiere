// Store helpers for editing a clip's animated channels, filters, and
// transitions. Channel names + math come from engine/keyframes; every edit is
// one undo step. localT is always relative to the clip start.

import {
  channelBase,
  channelDefault,
  channelKeyframes,
  resolveChannel,
  withChannelKeyframes,
  withChannelValue,
} from '../engine/effects/channels'
import * as ops from '../engine/effects/ops'
import { getEffect } from '../engine/effects/registry'
import { removeKeyframeNear, upsertKeyframe } from '../engine/keyframes'
import { clipDurationS, clipEndS, setClipSpeed as setClipSpeedT } from '../engine/timeline'
import {
  activeSequence,
  ANIM_CHANNELS,
  newId,
  type AnimChannel,
  type Clip,
  type Id,
  type Keyframe,
} from '../engine/types'
import type { TransitionKind } from '../engine/render/types'
import { updateActiveSequence, useStore } from './store'

const KEYFRAME_TOLERANCE_S = 1e-4

function findClip(clipId: string): Clip | undefined {
  const seq = activeSequence(useStore.getState().project)
  return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
}

/** Local clip time for the current playhead, clamped to the clip's span. */
export function playheadLocalT(clip: Clip): number {
  const t = useStore.getState().ui.playheadS
  return Math.max(0, Math.min(t - clip.startS, Math.max(0, clipEndS(clip) - clip.startS)))
}

function mapClip(clipId: string, label: string, fn: (clip: Clip) => Clip): void {
  updateActiveSequence(label, (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId)
        ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) }
        : t,
    ),
  }))
}

/**
 * Set a channel value. Animated channel → upsert a keyframe at the playhead;
 * static channel → set the base. This is what scrubbable fields call on commit.
 * Where the value LIVES (on the clip, or inside its effect stack) is the
 * adapter's problem, not this module's.
 */
export function setChannel(clipId: string, channel: AnimChannel, value: number): void {
  const clip = findClip(clipId)
  if (!clip) return
  const animated = channelKeyframes(clip, channel).length > 0
  mapClip(clipId, `Set ${channel}`, (c) => {
    if (!animated) return withChannelValue(c, channel, value)
    const localT = playheadLocalT(c)
    return withChannelKeyframes(
      c,
      channel,
      upsertKeyframe(channelKeyframes(c, channel), { t: localT, value, ease: 'linear' }),
    )
  })
}

/** Stopwatch: enable → seed a keyframe at the playhead with the current value; disable → drop all. */
export function toggleChannelAnimation(clipId: string, channel: AnimChannel): void {
  const clip = findClip(clipId)
  if (!clip) return
  const animated = channelKeyframes(clip, channel).length > 0
  mapClip(clipId, animated ? `Disable ${channel} keyframes` : `Enable ${channel} keyframes`, (c) => {
    if (animated) return withChannelKeyframes(c, channel, [])
    const localT = playheadLocalT(c)
    const value = channelBase(c, channel)
    return withChannelKeyframes(c, channel, [{ t: localT, value, ease: 'linear' }])
  })
}

/** Add a keyframe at the playhead capturing the channel's current resolved value. */
export function addKeyframeAtPlayhead(clipId: string, channel: AnimChannel): void {
  const clip = findClip(clipId)
  if (!clip) return
  mapClip(clipId, `Add ${channel} keyframe`, (c) => {
    const localT = playheadLocalT(c)
    const value = resolveChannel(c, channel, localT)
    return withChannelKeyframes(
      c,
      channel,
      upsertKeyframe(channelKeyframes(c, channel), { t: localT, value, ease: 'linear' }),
    )
  })
}

/** Remove the keyframe nearest the playhead on a channel (no-op if none within tolerance). */
export function removeKeyframeAtPlayhead(clipId: string, channel: AnimChannel): void {
  const clip = findClip(clipId)
  if (!clip) return
  mapClip(clipId, `Remove ${channel} keyframe`, (c) => {
    const localT = playheadLocalT(c)
    return withChannelKeyframes(c, channel, removeKeyframeNear(channelKeyframes(c, channel), localT, 0.05))
  })
}

export function setKeyframeEase(clipId: string, channel: AnimChannel, kfT: number, ease: Keyframe['ease']): void {
  mapClip(clipId, `Set ${channel} easing`, (c) => {
    const kfs = channelKeyframes(c, channel)
    if (kfs.length === 0) return c
    return withChannelKeyframes(
      c,
      channel,
      kfs.map((k) => (Math.abs(k.t - kfT) <= KEYFRAME_TOLERANCE_S ? { ...k, ease } : k)),
    )
  })
}

/** Clear a channel: drop its keyframes and reset the base to neutral/default. */
export function resetChannel(clipId: string, channel: AnimChannel): void {
  mapClip(clipId, `Reset ${channel}`, (c) =>
    withChannelValue(withChannelKeyframes(c, channel, []), channel, channelDefault(channel)),
  )
}

/** Reset every channel a clip can animate, in one undo step. */
export function resetAllChannels(clipId: string): void {
  mapClip(clipId, 'Reset all', (c) =>
    ANIM_CHANNELS.reduce<Clip>(
      (acc, ch) => withChannelValue(withChannelKeyframes(acc, ch, []), ch, channelDefault(ch)),
      c,
    ),
  )
}

// ---------------------------------------------------------------------------
// Effect stack. Addressed by effect INSTANCE id, so a clip can carry the same
// effect twice. Every call is one named undo step; the math lives in
// engine/effects/ops.ts and is unit-tested there.

/** Apply an effect to a clip. Returns silently for unknown types. */
export function applyEffect(clipId: string, type: string): void {
  const label = getEffect(type)?.label ?? type
  const id = newId()
  mapClip(clipId, `Add ${label}`, (c) => ops.addEffect(c, type, id))
}

export function deleteEffect(clipId: string, effectId: Id): void {
  mapClip(clipId, 'Remove effect', (c) => ops.removeEffect(c, effectId))
}

export function toggleEffectEnabled(clipId: string, effectId: Id): void {
  mapClip(clipId, 'Toggle effect', (c) => ops.toggleEffect(c, effectId))
}

export function moveEffectInStack(clipId: string, effectId: Id, delta: -1 | 1): void {
  mapClip(clipId, 'Reorder effect', (c) => ops.moveEffect(c, effectId, delta))
}

export function resetEffectParams(clipId: string, effectId: Id): void {
  mapClip(clipId, 'Reset effect', (c) => ops.resetEffect(c, effectId))
}

export function setEffectParamValue(clipId: string, effectId: Id, key: string, value: number): void {
  mapClip(clipId, `Set ${key}`, (c) => ops.setEffectParam(c, effectId, key, value, playheadLocalT(c)))
}

export function toggleEffectParamKeyframes(clipId: string, effectId: Id, key: string): void {
  mapClip(clipId, `Toggle ${key} keyframes`, (c) => ops.toggleEffectParamAnimation(c, effectId, key, playheadLocalT(c)))
}

export function addEffectKeyframeAtPlayhead(clipId: string, effectId: Id, key: string): void {
  mapClip(clipId, `Add ${key} keyframe`, (c) => ops.addEffectParamKeyframe(c, effectId, key, playheadLocalT(c)))
}

export function removeEffectKeyframeAtPlayhead(clipId: string, effectId: Id, key: string): void {
  mapClip(clipId, `Remove ${key} keyframe`, (c) => ops.removeEffectParamKeyframe(c, effectId, key, playheadLocalT(c)))
}

export function setEffectKeyframeEase(
  clipId: string,
  effectId: Id,
  key: string,
  kfT: number,
  ease: Keyframe['ease'],
): void {
  mapClip(clipId, `Set ${key} easing`, (c) => ops.setEffectParamEase(c, effectId, key, kfT, ease))
}

export function setClipTransition(
  clipId: string,
  edge: 'in' | 'out',
  kind: TransitionKind,
  durationS = 1,
): void {
  mapClip(clipId, `Add ${edge} transition`, (c) => ({
    ...c,
    [edge === 'in' ? 'transitionIn' : 'transitionOut']: { type: kind, durationS },
  }))
}

export function removeClipTransition(clipId: string, edge: 'in' | 'out'): void {
  mapClip(clipId, `Remove ${edge} transition`, (c) => ({
    ...c,
    [edge === 'in' ? 'transitionIn' : 'transitionOut']: undefined,
  }))
}

// ---------------------------------------------------------------------------
// Audio (Phase 6): per-clip gain + fades and a simple crossfade.

const clampFade = (s: number, dur: number): number => (s < 0 ? 0 : s > dur ? dur : s)

/** Change a clip's playback speed (negative = reverse); ripples the tail. */
export function setClipSpeed(clipId: string, speed: number): void {
  updateActiveSequence('Set speed', (seq) => setClipSpeedT(seq, clipId, speed))
}

/** Set position + scale together in ONE undo step (the Monitor drag-gizmo commit). */
export function setClipTransform(clipId: string, patch: { x?: number; y?: number; scale?: number }): void {
  mapClip(clipId, 'Transform clip', (c) => ({
    ...c,
    transform: {
      ...c.transform,
      x: patch.x ?? c.transform.x,
      y: patch.y ?? c.transform.y,
      scale: patch.scale ?? c.transform.scale,
    },
  }))
}

/** Set a clip's static gain in dB. */
export function setClipGainDb(clipId: string, db: number): void {
  mapClip(clipId, 'Set clip gain', (c) => (c.audioGainDb === db ? c : { ...c, audioGainDb: db }))
}

/** Set a clip's fade in/out length (seconds), clamped to the clip duration. */
export function setClipFade(clipId: string, edge: 'in' | 'out', seconds: number): void {
  mapClip(clipId, edge === 'in' ? 'Set fade in' : 'Set fade out', (c) => {
    const v = clampFade(seconds, clipDurationS(c))
    const key = edge === 'in' ? 'fadeInS' : 'fadeOutS'
    return c[key] === v ? c : { ...c, [key]: v }
  })
}

/**
 * Simple audio crossfade at the cut between an audio clip and its time-adjacent
 * neighbour: fade the outgoing clip out and the incoming clip in over the same
 * length, in ONE undo step. No-op if there is no adjacent neighbour on the side.
 */
export function crossfadeWithNeighbour(clipId: Id, side: 'next' | 'prev', seconds = 0.5): void {
  updateActiveSequence('Crossfade', (seq) => {
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
    if (!track) return seq
    const idx = track.clips.findIndex((c) => c.id === clipId)
    const a = side === 'next' ? track.clips[idx] : track.clips[idx - 1]
    const b = side === 'next' ? track.clips[idx + 1] : track.clips[idx]
    if (!a || !b) return seq
    // Adjacent only (A's out edge meets B's in edge within a frame-ish).
    if (Math.abs(clipEndS(a) - b.startS) > 1e-3) return seq
    const d = Math.min(seconds, clipDurationS(a), clipDurationS(b))
    if (d <= 0) return seq
    return {
      ...seq,
      tracks: seq.tracks.map((t) =>
        t.id !== track.id
          ? t
          : {
              ...t,
              clips: t.clips.map((c) =>
                c.id === a.id ? { ...c, fadeOutS: d } : c.id === b.id ? { ...c, fadeInS: d } : c,
              ),
            },
      ),
    }
  })
}
