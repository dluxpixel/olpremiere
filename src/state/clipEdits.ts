// Store helpers for editing a clip's animated channels, filters, and
// transitions. Channel names + math come from engine/keyframes; every edit is
// one undo step. localT is always relative to the clip start.

import { applyAppearanceToClip } from '../engine/anim/appearance'
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
import {
  clipDurationS,
  clipEndS,
  clipGroupIds,
  deleteScoped,
  rippleDeleteGroup,
  rippleTrimGroup,
  setClipSpeed as setClipSpeedT,
  splitClipOnly,
  splitGroup,
  unlockedClipIds,
} from '../engine/timeline'
import { quantizeToFrame } from '../engine/timecode'
import {
  activeSequence,
  ANIM_CHANNELS,
  newId,
  type AnimChannel,
  type BlendMode,
  type Clip,
  type ClipMask,
  type Id,
  type Keyframe,
} from '../engine/types'
import { transitionDurationSpec, type TransitionKind } from '../engine/render/types'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

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

/**
 * The ONE choke point for every Inspector, effect, keyframe and transition edit,
 * and therefore the one that has to say "no" out loud.
 *
 * The lock used to be enforced by quietly mapping the track to itself, which
 * meant two things went wrong at once: the user got no signal that the track was
 * locked (every other guarded path in the app toasts — motionActions, audio,
 * captions, attributes), AND the no-op still produced a fresh sequence object, so
 * it sailed past the identity bail in updateActiveSequence and landed on the undo
 * stack. Five dead slider drags meant five phantom steps to Ctrl+Z through before
 * reaching a real edit.
 */
function mapClip(clipId: string, label: string, fn: (clip: Clip) => Clip): void {
  const track = activeSequence(useStore.getState().project).tracks.find((t) =>
    t.clips.some((c) => c.id === clipId),
  )
  if (!track) return
  if (track.locked) {
    useToasts.getState().show('Track is locked', 'danger')
    return
  }
  updateActiveSequence(label, (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) =>
      t.id === track.id ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) } : t,
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

/**
 * Retime a keyframe: move the one nearest `fromT` on this channel to `toT`
 * (clamped to the clip span), keeping its value + easing. This is what the
 * Keyframes lane's drag-and-type calls — "set the time this happens". Landing
 * exactly on another keyframe's time merges onto it (upsert replaces).
 */
export function moveKeyframeTime(clipId: string, channel: AnimChannel, fromT: number, toT: number): void {
  const clip = findClip(clipId)
  if (!clip) return
  const dur = Math.max(0, clipEndS(clip) - clip.startS)
  const t = Math.max(0, Math.min(toT, dur))
  // Early no-op BEFORE dispatch: mapClip always rebuilds the sequence, so
  // guarding only inside its callback would still push an empty undo command
  // (dragging a keyframe back to where it started, or retyping the same time).
  const kf = channelKeyframes(clip, channel).find((k) => Math.abs(k.t - fromT) <= 1e-4)
  if (!kf || Math.abs(kf.t - t) <= 1e-6) return
  mapClip(clipId, `Move ${channel} keyframe`, (c) => {
    const kfs = channelKeyframes(c, channel)
    const cur = kfs.find((k) => Math.abs(k.t - fromT) <= 1e-4)
    if (!cur) return c
    return withChannelKeyframes(c, channel, upsertKeyframe(kfs.filter((k) => k !== cur), { ...cur, t }))
  })
}

/** Remove the keyframe nearest time `t` on a channel (the Keyframes-lane trash button). */
export function removeKeyframeAtTime(clipId: string, channel: AnimChannel, t: number): void {
  const clip = findClip(clipId)
  if (!clip) return
  mapClip(clipId, `Remove ${channel} keyframe`, (c) =>
    withChannelKeyframes(c, channel, removeKeyframeNear(channelKeyframes(c, channel), t, 0.05)),
  )
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

/**
 * Remove a punch/zoom. Every zoom path (PunchControl Apply, the P key, the
 * clip context menu) writes SCALE keyframes and never touches the static base,
 * so dropping those keyframes restores the pre-zoom look exactly. Unlike
 * resetChannel the base is deliberately kept — a hand-scaled clip stays at its
 * size, only the animated zoom goes away. One undo step.
 */
export function removeZoom(clipId: string): void {
  mapClip(clipId, 'Remove zoom', (c) => withChannelKeyframes(c, 'scale', []))
}

/**
 * Toggle a clip's enabled flag (Shift+E). A disabled clip renders nothing, its
 * audio is muted, and export skips it — but it keeps its place, effects, and
 * keyframes, so it's the way to A/B an overlay without deleting it. Group-aware
 * so a linked A/V pair toggles together.
 */
export function toggleClipEnabled(clipId: string): void {
  const clip = findClip(clipId)
  if (!clip) return
  const next = !clip.enabled
  const group = new Set(clipGroupIds(activeSequence(useStore.getState().project), clipId))
  updateActiveSequence(next ? 'Enable clip' : 'Disable clip', (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) =>
      t.locked
        ? t
        : { ...t, clips: t.clips.map((c) => (group.has(c.id) ? { ...c, enabled: next } : c)) },
    ),
  }))
}

/** Reset a specific set of channels (one Inspector section) in one undo step. */
export function resetChannels(clipId: string, channels: AnimChannel[]): void {
  mapClip(clipId, 'Reset', (c) =>
    channels.reduce<Clip>(
      (acc, ch) => withChannelValue(withChannelKeyframes(acc, ch, []), ch, channelDefault(ch)),
      c,
    ),
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

/**
 * Apply an effect to a clip. Returns silently for unknown types, and for clips
 * on an AUDIO track: effects only composite on video tracks (resolveFrame skips
 * audio), so a grade/key/blur dropped on an audio clip would sit dead and render
 * nothing — the "why did nothing happen?" confusion. Titles and adjustment
 * layers DO render, so they stay eligible.
 */
export function applyEffect(clipId: string, type: string): void {
  const seq = activeSequence(useStore.getState().project)
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  if (!track || track.kind === 'audio') return
  const label = getEffect(type)?.label ?? type
  const id = newId()
  mapClip(clipId, `Add ${label}`, (c) => ops.addEffect(c, type, id))
}

/**
 * Set a clip's noise-reduction strength (0..1); undefined/0 turns it off.
 * Non-destructive — flips which samples the mixers read (clipAudioBuffer),
 * the recording itself is never touched. One undo step, like any edit.
 */
export function setClipDenoise(clipId: string, strength: number | undefined): void {
  const s = strength !== undefined && strength > 0 ? Math.min(1, strength) : undefined
  // No-op guard BEFORE dispatch: mapClip rebuilds the sequence object even for
  // an unchanged clip, so a same-value commit (ScrubField blur re-commit) would
  // otherwise land a do-nothing entry on the undo stack.
  const cur = activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
  if (!cur || cur.denoise === s) return
  mapClip(clipId, s === undefined ? 'Noise reduction off' : 'Reduce noise', (c) => {
    const next = { ...c }
    if (s === undefined) delete next.denoise
    else next.denoise = s
    return next
  })
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
  durationS?: number,
): void {
  // Per-kind envelope: whiteFlash defaults to its 200 ms hit and lives in
  // 100–500 ms; everything else keeps the classic 1 s default. Enforced HERE —
  // the one write path for drops, the Inspector select, and duration commits.
  // A duration outside the new kind's envelope (e.g. a 1 s dissolve switched
  // to White Flash) snaps to the kind's DEFAULT, not the clamp edge: the
  // carried value was tuned for a different verb, so the envelope edge would
  // be an arbitrary landing spot. In-envelope values are kept as-is.
  const spec = transitionDurationSpec(kind)
  const d =
    durationS !== undefined && durationS >= spec.min && durationS <= spec.max ? durationS : spec.def
  mapClip(clipId, `Add ${edge} transition`, (c) => ({
    ...c,
    [edge === 'in' ? 'transitionIn' : 'transitionOut']: { type: kind, durationS: d },
  }))
}

export function removeClipTransition(clipId: string, edge: 'in' | 'out'): void {
  mapClip(clipId, `Remove ${edge} transition`, (c) => ({
    ...c,
    [edge === 'in' ? 'transitionIn' : 'transitionOut']: undefined,
  }))
}

export function setClipBlendMode(clipId: string, mode: BlendMode): void {
  mapClip(clipId, 'Set blend mode', (c) => ({ ...c, blendMode: mode }))
}

/** Set or clear (undefined) the clip's shape mask. */
export function setClipMask(clipId: string, mask: ClipMask | undefined): void {
  mapClip(clipId, mask ? 'Edit mask' : 'Remove mask', (c) => ({ ...c, mask }))
}

/**
 * Commit a gizmo drag on a KEYFRAMED clip: each changed channel upserts a
 * keyframe at the playhead when animated, or updates its base when static —
 * all in ONE undo step. This is what lets the monitor gizmo stay alive on
 * animated clips instead of hiding (Premiere behavior: drag = keyframe).
 */
export function setClipTransformAtPlayhead(
  clipId: string,
  changes: Partial<{ x: number; y: number; scale: number; rotationDeg: number }>,
): void {
  const vals: [AnimChannel, number][] = []
  if (changes.x !== undefined) vals.push(['posX', changes.x])
  if (changes.y !== undefined) vals.push(['posY', changes.y])
  if (changes.scale !== undefined) vals.push(['scale', changes.scale])
  if (changes.rotationDeg !== undefined) vals.push(['rotation', changes.rotationDeg])
  if (vals.length === 0) return
  mapClip(clipId, 'Transform at playhead', (c) => {
    const localT = playheadLocalT(c)
    let next = c
    for (const [channel, value] of vals) {
      const kfs = channelKeyframes(next, channel)
      next =
        kfs.length > 0
          ? withChannelKeyframes(next, channel, upsertKeyframe(kfs, { t: localT, value, ease: 'linear' }))
          : withChannelValue(next, channel, value)
    }
    return next
  })
}

// ---------------------------------------------------------------------------
// Audio (Phase 6): per-clip gain + fades and a simple crossfade.

const clampFade = (s: number, dur: number): number => (s < 0 ? 0 : s > dur ? dur : s)

/** Change a clip's playback speed (negative = reverse); ripples the tail. */
export function setClipSpeed(clipId: string, speed: number): void {
  updateActiveSequence('Set speed', (seq) =>
    // Speed edits bypass mapClip (they ripple neighbours), so lock-check here.
    unlockedClipIds(seq, [clipId]).length === 0 ? seq : setClipSpeedT(seq, clipId, speed),
  )
}

/** Set position + scale together in ONE undo step (the Monitor drag-gizmo commit). */
export function setClipTransform(
  clipId: string,
  patch: { x?: number; y?: number; scale?: number; rotationDeg?: number },
): void {
  const seq = activeSequence(useStore.getState().project)
  mapClip(clipId, 'Transform clip', (c) => {
    const moved: Clip = {
      ...c,
      transform: {
        ...c.transform,
        x: patch.x ?? c.transform.x,
        y: patch.y ?? c.transform.y,
        scale: patch.scale ?? c.transform.scale,
        rotationDeg: patch.rotationDeg ?? c.transform.rotationDeg,
      },
    }
    // A clip with an entrance/exit animation re-derives its keyframes from the
    // NEW base, so dragging it in the preview moves/scales the SETTLED clip and
    // the animation follows — instead of the baked keyframes fighting the drag.
    return moved.appearance ? applyAppearanceToClip(moved, moved.appearance, seq.width, seq.height) : moved
  })
}

/**
 * Set a clip's gain in dB. Keyframe-aware: while the volume channel is
 * animated a non-empty keyframe list OVERRIDES audioGainDb everywhere (the
 * envelope never reads the base), so writing the base would be a silent no-op
 * — instead the write upserts a keyframe at the playhead, exactly like the
 * volume ScrubField.
 */
export function setClipGainDb(clipId: string, db: number): void {
  mapClip(clipId, 'Set clip gain', (c) => {
    const kfs = channelKeyframes(c, 'volume')
    if (kfs.length > 0) {
      return withChannelKeyframes(c, 'volume', upsertKeyframe(kfs, { t: playheadLocalT(c), value: db, ease: 'linear' }))
    }
    return c.audioGainDb === db ? c : { ...c, audioGainDb: db }
  })
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

/**
 * Q / W: top-and-tail. Ripple-trim the head ('in') or tail ('out') of the
 * clip under the playhead — a selected clip under the playhead wins, else the
 * topmost unlocked one. Shared by the keymap and the clip context menu.
 */
/**
 * Delete the selection (ripple or not). Shared by the Del / Shift+Del keys AND
 * the clip context menu — the menu used to reimplement this inline and skipped
 * the lock filter, so right-click Delete removed clips the Del key refused.
 */
export function deleteSelected(ripple: boolean): void {
  const s = useStore.getState()
  const selection = s.ui.selection
  if (selection.length === 0) return
  // Selection may legitimately include locked-track clips; deleting them never may.
  const ids = unlockedClipIds(activeSequence(s.project), selection)
  if (ids.length === 0) {
    useToasts.getState().show('Those clips are on a locked track', 'danger')
    return
  }
  // Selection-scoped: an audio half deletes alone, everything else takes its
  // linked partner along (deleteScoped). Ripple stays group-wide - rippling
  // one half of a pair would slide its track out of sync with the partner.
  updateActiveSequence(ripple ? 'Ripple delete' : 'Delete clip', (sq) => {
    let next = sq
    for (const id of ids) next = ripple ? rippleDeleteGroup(next, id) : deleteScoped(next, id)
    return next
  })
  s.setUI({ selection: [] })
}

/**
 * Split at the playhead. Three explicit verbs (David, 2026-07-18 - the earlier
 * selection-scoped C was "way too confusing"):
 *   C          → split the clip(s): a linked pair always splits TOGETHER.
 *   Shift+C    → split only the AUDIO half (kind: 'audio').
 *   Alt+C      → split only the VIDEO half (kind: 'video').
 * A selection still narrows WHICH clips are considered (multi-track editing),
 * but never changes what a verb splits.
 *
 * Shared with the clip context menu, which used to split only the clip you
 * right-clicked while the Delete item one row below it said "Delete 5 clips".
 */
export function splitAtPlayhead(allTracks = false, kind?: 'video' | 'audio'): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Cut on the frame grid: a mid-frame playhead (playback, fine scrubs) would
  // otherwise land off-grid cuts that leave sliver fragments.
  const t = quantizeToFrame(s.ui.playheadS, seq.fps)
  const sel = allTracks ? [] : s.ui.selection
  const targets = seq.tracks.flatMap((tr) =>
    tr.locked || (kind && tr.kind !== kind)
      ? []
      : tr.clips
          .filter((c) => (sel.length === 0 || sel.includes(c.id)) && t > c.startS && t < clipEndS(c))
          .map((c) => c.id),
  )
  if (targets.length === 0) {
    // The usual cause is a stale selection narrowing the cut to a clip the
    // playhead is nowhere near — invisible unless we say it.
    useToasts
      .getState()
      .show(
        sel.length > 0
          ? "Playhead isn't over a selected clip"
          : 'Put the playhead over a clip to split it',
        'danger',
      )
    return
  }
  const label = kind === 'audio' ? 'Split audio' : kind === 'video' ? 'Split video' : 'Split at playhead'
  updateActiveSequence(label, (sq) => {
    let next = sq
    // De-dupe linked partners so a group isn't split twice.
    const done = new Set<string>()
    for (const id of targets) {
      if (done.has(id)) continue
      if (kind) {
        done.add(id)
        next = splitClipOnly(next, id, t)
        continue
      }
      for (const gid of clipGroupIds(next, id)) done.add(gid)
      next = splitGroup(next, id, t)
    }
    return next
  })
}
export function topAndTail(edge: 'in' | 'out'): void {
  const s = useStore.getState()
  const t = s.ui.playheadS
  const assets = s.project.assets
  const seq = activeSequence(s.project)
  const sel = new Set(s.ui.selection)
  const under = seq.tracks
    .filter((tr) => !tr.locked)
    .flatMap((tr) => tr.clips)
    .filter((c) => t > c.startS && t < clipEndS(c))
  if (under.length === 0) {
    useToasts.getState().show('Put the playhead inside a clip first', 'danger')
    return
  }
  const target = under.find((c) => sel.has(c.id)) ?? under[under.length - 1]
  updateActiveSequence(edge === 'in' ? 'Trim head to playhead' : 'Trim tail to playhead', (sq) =>
    rippleTrimGroup(sq, assets, target.id, edge, t),
  )
}
