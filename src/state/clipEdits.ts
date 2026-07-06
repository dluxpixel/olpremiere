// Store helpers for editing a clip's animated channels, filters, and
// transitions. Channel names + math come from engine/keyframes; every edit is
// one undo step. localT is always relative to the clip start.

import { channelBase, resolveChannel, removeKeyframeNear, upsertKeyframe } from '../engine/keyframes'
import { clipEndS } from '../engine/timeline'
import {
  activeSequence,
  type AnimChannel,
  type Clip,
  type Keyframe,
  type Transform,
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

/** Write a channel's static base back into the clip's transform/opacity/filters. */
function withChannelBase(clip: Clip, channel: AnimChannel, value: number): Clip {
  const tf = clip.transform
  const setTf = (patch: Partial<Transform>): Clip => ({ ...clip, transform: { ...tf, ...patch } })
  const setCrop = (patch: Partial<Transform['crop']>): Clip => ({
    ...clip,
    transform: { ...tf, crop: { ...tf.crop, ...patch } },
  })
  const setFilter = (key: keyof NonNullable<Clip['filters']>): Clip => ({
    ...clip,
    filters: { ...clip.filters, [key]: value },
  })
  switch (channel) {
    case 'posX':
      return setTf({ x: value })
    case 'posY':
      return setTf({ y: value })
    case 'scale':
      return setTf({ scale: value })
    case 'rotation':
      return setTf({ rotationDeg: value })
    case 'anchorX':
      return setTf({ anchorX: value })
    case 'anchorY':
      return setTf({ anchorY: value })
    case 'cropT':
      return setCrop({ t: value })
    case 'cropR':
      return setCrop({ r: value })
    case 'cropB':
      return setCrop({ b: value })
    case 'cropL':
      return setCrop({ l: value })
    case 'opacity':
      return { ...clip, opacity: value }
    case 'brightness':
      return setFilter('brightness')
    case 'contrast':
      return setFilter('contrast')
    case 'saturation':
      return setFilter('saturation')
    case 'exposure':
      return setFilter('exposure')
    case 'blur':
      return setFilter('blur')
  }
}

const withKeyframes = (clip: Clip, channel: AnimChannel, kfs: Keyframe[]): Clip => {
  const next: Partial<Record<AnimChannel, Keyframe[]>> = { ...clip.keyframes }
  if (kfs.length === 0) delete next[channel]
  else next[channel] = kfs
  return { ...clip, keyframes: next }
}

/**
 * Set a channel value. Animated channel → upsert a keyframe at the playhead;
 * static channel → set the base. This is what scrubbable fields call on commit.
 */
export function setChannel(clipId: string, channel: AnimChannel, value: number): void {
  const clip = findClip(clipId)
  if (!clip) return
  const animated = (clip.keyframes?.[channel]?.length ?? 0) > 0
  mapClip(clipId, `Set ${channel}`, (c) => {
    if (!animated) return withChannelBase(c, channel, value)
    const localT = playheadLocalT(c)
    return withKeyframes(c, channel, upsertKeyframe(c.keyframes?.[channel], { t: localT, value, ease: 'linear' }))
  })
}

/** Stopwatch: enable → seed a keyframe at the playhead with the current value; disable → drop all. */
export function toggleChannelAnimation(clipId: string, channel: AnimChannel): void {
  const clip = findClip(clipId)
  if (!clip) return
  const animated = (clip.keyframes?.[channel]?.length ?? 0) > 0
  mapClip(clipId, animated ? `Disable ${channel} keyframes` : `Enable ${channel} keyframes`, (c) => {
    if (animated) return withKeyframes(c, channel, [])
    const localT = playheadLocalT(c)
    const value = channelBase(c, channel)
    return withKeyframes(c, channel, [{ t: localT, value, ease: 'linear' }])
  })
}

/** Add a keyframe at the playhead capturing the channel's current resolved value. */
export function addKeyframeAtPlayhead(clipId: string, channel: AnimChannel): void {
  const clip = findClip(clipId)
  if (!clip) return
  mapClip(clipId, `Add ${channel} keyframe`, (c) => {
    const localT = playheadLocalT(c)
    const value = resolveChannel(c, channel, localT)
    return withKeyframes(c, channel, upsertKeyframe(c.keyframes?.[channel], { t: localT, value, ease: 'linear' }))
  })
}

/** Remove the keyframe nearest the playhead on a channel (no-op if none within tolerance). */
export function removeKeyframeAtPlayhead(clipId: string, channel: AnimChannel): void {
  const clip = findClip(clipId)
  if (!clip) return
  mapClip(clipId, `Remove ${channel} keyframe`, (c) => {
    const localT = playheadLocalT(c)
    const next = removeKeyframeNear(c.keyframes?.[channel], localT, 0.05)
    return withKeyframes(c, channel, next)
  })
}

export function setKeyframeEase(clipId: string, channel: AnimChannel, kfT: number, ease: Keyframe['ease']): void {
  mapClip(clipId, `Set ${channel} easing`, (c) => {
    const kfs = c.keyframes?.[channel]
    if (!kfs) return c
    return withKeyframes(
      c,
      channel,
      kfs.map((k) => (Math.abs(k.t - kfT) <= KEYFRAME_TOLERANCE_S ? { ...k, ease } : k)),
    )
  })
}

/** Clear a channel: drop its keyframes and reset the base to neutral/default. */
export function resetChannel(clipId: string, channel: AnimChannel): void {
  const defaults: Record<AnimChannel, number> = {
    posX: 0,
    posY: 0,
    scale: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    cropT: 0,
    cropR: 0,
    cropB: 0,
    cropL: 0,
    opacity: 1,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    exposure: 0,
    blur: 0,
  }
  mapClip(clipId, `Reset ${channel}`, (c) => withChannelBase(withKeyframes(c, channel, []), channel, defaults[channel]))
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
