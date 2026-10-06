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
import { FRAME_FITS, frameFitDims, withFrameFit, type FrameFit } from '../engine/frameFit'
import { getEffect } from '../engine/effects/registry'
import { upsertKeyframe, upsertKeyframeValue } from '../engine/keyframes'
import { MOTION_CURVES } from '../engine/motion'
import { clipDurationS, clipEndS } from '../engine/timeline'
import { TRANSITION_LABELS, type TransitionKind } from '../engine/render/types'
import { activeSequence, newId, type AnimChannel, type Clip, type Curve, type Keyframe } from '../engine/types'
// isClipArmed comes from the SINGLE-clip module on purpose: the multi-select
// align has to ask the exact question the gizmo asks, off the exact same code,
// or the two paths drift the way they did when one read a global preference.
import { isAppearanceOwned, isClipArmed, playheadLocalT, transitionFor, withOwnedBase } from './clipEdits'
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
 * Mirror every given picture left to right, ONE undo. His ask, 2026-10-01:
 * "flip the video (I don't know if you know what I mean, like flip from right
 * to left)". They all go the same way: flipped, unless every one already is,
 * then all back. Clips on audio tracks and titles have no picture to mirror
 * and are left alone (mirrored words would just be unreadable).
 */
export function toggleClipsFlip(ids: Iterable<string>): void {
  const idSet = new Set(ids)
  const seq = activeSequence(useStore.getState().project)
  const pictures = seq.tracks
    .filter((t) => t.kind === 'video' && !t.locked)
    .flatMap((t) => t.clips.filter((c) => idSet.has(c.id) && !c.title))
  if (pictures.length === 0) return
  const flip = !pictures.every((c) => c.transform.flipH === true)
  const n = pictures.length
  const label = `${flip ? 'Flip' : 'Unflip'} ${n === 1 ? 'clip' : `${n} clips`}`
  mapClips(
    pictures.map((c) => c.id),
    label,
    (c) => {
      // Unflipped is written by leaving the key out, so a clip flipped and
      // flipped back is the same clip it was.
      const transform = { ...c.transform }
      if (flip) transform.flipH = true
      else delete transform.flipH
      return { ...c, transform }
    },
  )
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
  const seq = activeSequence(useStore.getState().project)
  mapClips(
    ids,
    `Set ${channel}`,
    (c) => {
      // A caption's pop or fade owns this channel: the number is its new base
      // and the animation follows (withOwnedBase says what this used to break).
      if (isAppearanceOwned(c, channel)) return withOwnedBase(c, channel, value, seq.width, seq.height)
      const kfs = channelKeyframes(c, channel)
      if (kfs.length === 0) return withChannelValue(c, channel, value)
      const localT = playheadLocalT(c)
      // upsertKeyframeValue, not upsertKeyframe: a keyframe he shaped by hand keeps
      // its curve, and only a NEW one takes the shelf's current preference.
      return withChannelKeyframes(c, channel, upsertKeyframeValue(kfs, localT, value, commit))
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

/**
 * The clips a monitor drag to align moves: the selected clips of the PRIMARY's
 * kind (the one the box is drawn on). Captions with captions, pictures with
 * pictures; the sound never.
 *
 * ⛔ It used to move the whole selection: drag the captions of a selected Short
 * 600 px down and the footage jumped 600 px down with them. His rule for exactly
 * this case is in MultiInspector: footage wins a mixed selection, and "a caption
 * that zooms along with the shot underneath it is not what he asked for".
 */
export function alignTargets(
  seq: { tracks: readonly { kind: string; clips: readonly Clip[] }[] },
  selection: readonly string[],
  primaryId: string,
): string[] {
  const picked = new Set(selection)
  const kindOf = (c: Clip) => (c.title ? 'text' : 'picture')
  const visual = seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips)
  const primary = visual.find((c) => c.id === primaryId)
  if (!primary) return [...selection]
  return visual.filter((c) => picked.has(c.id) && kindOf(c) === kindOf(primary)).map((c) => c.id)
}

/** What one effect run did to the clips it was handed. */
interface EffectRun {
  /** Clips asked for. */
  requested: number
  /** Of those, the ones a picture effect means anything on: not sound. */
  visual: number
  /** Of those, the ones on a locked track, which stay as they are. */
  locked: number
  /** Of those, the ones that already carried this effect and were skipped. */
  already: number
  /** Clips that really got the effect. */
  changed: number
}

/** "1 clip is on a locked track and was left out": what to say about the ones a lock held back. */
export function lockedLeftOut(n: number): string {
  return n === 1
    ? '1 clip is on a locked track and was left out'
    : `${n} clips are on a locked track and were left out`
}

/** Footage: a picture of its own, not a title and not an adjustment layer. */
export const isFootage = (c: Clip): boolean => !c.title && !c.adjustment

/**
 * FOOTAGE WINS A MIXED SELECTION, for effects and looks too. Select a whole
 * Short and the captions come with it: Saturation -1 turned the yellow highlight
 * words grey, a Blur blurred the words, a second grade went on the adjustment
 * layer on top of the footage it already grades. The punch grade has always
 * left titles clean ("the caption style owns them", lookActions.ts) and the
 * Move shelf does the same (MultiInspector). A selection with NO footage in it
 * (only captions) still takes the effect, so a Glow on the captions works.
 */
export function effectTargets<T extends Clip>(clips: readonly T[]): T[] {
  const footage = clips.filter(isFootage)
  return footage.length > 0 ? footage : [...clips]
}

/**
 * Put one fresh instance of an effect on every clip it can go on, in ONE undo
 * step, and count what happened. No words: the callers say them, because the
 * browser row, the drop and "every clip" each have their own.
 *
 * Skips audio clips the way the single-clip applyEffect does (clipEdits.ts): a
 * visual effect on an audio clip stores a card, costs an undo and renders
 * nothing. A mixed selection applies to its footage only (effectTargets).
 * Locked tracks are skipped by mapClips; they are counted here so they can be
 * named.
 *
 * ⛔ NEVER A SECOND COPY ON A SELECTION. Selecting the whole Short again and
 * adding Auto Color "to make sure every clip has it" gave the clips that had it a
 * doubled look, and the "On all N clips" card then edited only the first copy.
 * So when more than one clip was asked for, a clip already carrying the effect
 * is skipped and counted. One clip on its own may still stack a copy on purpose.
 */
function runEffect(ids: Iterable<string>, type: string): EffectRun {
  const where = new Map<string, { clip: Clip; kind: string; locked: boolean }>()
  for (const t of activeSequence(useStore.getState().project).tracks) {
    for (const c of t.clips) where.set(c.id, { clip: c, kind: t.kind, locked: t.locked })
  }
  const requested = [...ids]
  const visual = requested.flatMap((id) => {
    const w = where.get(id)
    return w && w.kind !== 'audio' ? [w.clip] : []
  })
  const targets = effectTargets(visual)
  const unlocked = targets.filter((c) => !where.get(c.id)?.locked)
  const open = visual.length > 1 ? unlocked.filter((c) => !c.effects.some((e) => e.type === type)) : unlocked
  const run: EffectRun = {
    requested: requested.length,
    visual: visual.length,
    locked: targets.length - unlocked.length,
    already: unlocked.length - open.length,
    changed: 0,
  }
  if (open.length === 0) return run
  const label = getEffect(type)?.label ?? type
  mapClips(open.map((c) => c.id), `Add ${label}`, (c) => {
    const next = addEffect(c, type, newId())
    if (next !== c) run.changed++
    return next
  })
  // The browser's double-click, its right-click menu, the drop, the clip menu and
  // the Inspector's search all arrive here, so this is where most of his real
  // usage gets remembered.
  if (run.changed > 0) noteRecentEffect(type)
  return run
}

/** ". 5 already had it": the clips a run skipped because they carry it already. */
const alreadyHad = (n: number): string => (n === 0 ? '' : `. ${n} already had it`)

/**
 * Add one fresh instance of an effect to every selected clip (own id each), and
 * say how many it changed. Returns that number.
 *
 * His words, 2026-10-04: *"selecting multiple images and putting effects on them
 * that actually apply to all of them."* Every door to an effect ends here, so a
 * selection of pictures takes it whole, in ONE undo step, whichever door he used.
 * A lone clip says nothing, because the effect shows up in the Inspector; more
 * than one clip, or any clip a lock held back, is told in a sentence.
 */
export function applyEffectToClips(ids: Iterable<string>, type: string): number {
  const label = getEffect(type)?.label ?? type
  const show = useToasts.getState().show
  const run = runEffect(ids, type)
  // Double-clicking an effect with nothing (or only audio) selected used to do
  // absolutely nothing, silently. The browser row is always usable, so the
  // reason it did not land has to be said out loud.
  if (run.visual === 0) {
    show(run.requested === 0 ? 'Select a clip first' : 'Effects don’t apply to audio clips', 'danger')
    return 0
  }
  if (run.changed === 0) {
    if (run.locked > 0) show(run.locked === 1 ? 'That clip is on a locked track' : 'Those clips are on a locked track', 'danger')
    else if (run.already > 0) show(`Every one of those clips already has ${label}`, 'info')
    return 0
  }
  if (run.changed > 1 || run.locked > 0 || run.already > 0) {
    const left = run.locked > 0 ? `. ${lockedLeftOut(run.locked)}` : ''
    show(`Added ${label} to ${run.changed} clip${run.changed === 1 ? '' : 's'}${alreadyHad(run.already)}${left}`, 'success')
  }
  return run.changed
}

/**
 * Add one fresh instance of an effect to EVERY video clip in the active
 * sequence, all in ONE undo step, no selection needed. Audio clips are skipped
 * (a visual effect means nothing on them) and locked tracks are skipped by
 * mapClips. The footage takes it and the captions stay clean, and a clip that
 * already has it is not given a second copy (runEffect). Mirrors
 * applyPresetToAllClips in library.ts.
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
  const { changed, already } = runEffect(ids, type)
  if (changed === 0 && already > 0) {
    show(`Every clip already has ${label}`, 'info')
    return
  }
  show(`Applied "${label}" to ${changed} clip${changed === 1 ? '' : 's'}${alreadyHad(already)}`, 'success')
}

/**
 * Shift+B on the WHOLE selection: every effect off on every selected clip, or
 * all back on, in ONE undo step.
 *
 * It used to switch only the first clip he had picked: three pictures with Auto
 * Color selected, Shift+B, one went off (measured 2026-10-06). With the linked
 * sound picked first it did nothing at all and never said why. Shift+E was fixed
 * for exactly this on 2026-10-01 and this key was missed.
 *
 * The rule is toggleClipsEnabled's: if any picked clip still has an effect on,
 * they ALL go off; only when every one is already off do they all come back.
 * Sound clips carry no picture effects and are left out; a lock is named.
 */
export function toggleEffectsForClips(ids: Iterable<string>): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  const show = useToasts.getState().show
  let locked = 0
  const open: Clip[] = []
  for (const t of activeSequence(useStore.getState().project).tracks) {
    if (t.kind === 'audio') continue
    for (const c of t.clips) {
      if (!idSet.has(c.id) || c.effects.length === 0) continue
      if (t.locked) locked++
      else open.push(c)
    }
  }
  if (open.length === 0) {
    show(locked > 0 ? lockedLeftOut(locked) : 'No effects on the selected clips', 'info')
    return
  }
  const enabled = !open.some((c) => c.effects.some((e) => e.enabled))
  const n = open.length
  const label = n === 1
    ? enabled ? 'Turn every effect on' : 'Turn every effect off'
    : enabled ? `Effects back on for ${n} clips` : `Effects off on ${n} clips`
  mapClips(
    open.map((c) => c.id),
    label,
    (c) =>
      c.effects.every((e) => e.enabled === enabled)
        ? c
        : { ...c, effects: c.effects.map((e) => (e.enabled === enabled ? e : { ...e, enabled })) },
  )
  // One clip says nothing, like the effect search: its eye and the monitor show it.
  if (n > 1 || locked > 0) {
    show(locked > 0 ? `${label}. ${lockedLeftOut(locked)}` : label, 'success')
  }
}

/**
 * The ONE clip a single clip key (P, Shift+P, Alt+P, D, F) should act on when
 * several are selected: the selected PICTURE the playhead is inside.
 *
 * Those keys read `selection[0]`, which in a Short is as often a caption or the
 * linked sound as the footage, so P said "Put the playhead inside the clip
 * first" while the footage under the playhead sat selected. Order: a selected
 * picture under the playhead, then any selected clip under it, then the first.
 */
export function keyTargetClipId(
  seq: { tracks: readonly { kind: string; clips: readonly Clip[] }[] },
  selection: readonly string[],
  playheadS: number,
): string | undefined {
  if (selection.length <= 1) return selection[0]
  const picked = new Set(selection)
  const under: { clip: Clip; picture: boolean }[] = []
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      if (!picked.has(c.id) || playheadS < c.startS || playheadS >= clipEndS(c)) continue
      under.push({ clip: c, picture: t.kind === 'video' && !c.title && !c.adjustment })
    }
  }
  const order = (id: string) => selection.indexOf(id)
  under.sort((a, b) => order(a.clip.id) - order(b.clip.id))
  return (under.find((u) => u.picture) ?? under[0])?.clip.id ?? selection[0]
}

/**
 * The selected clips a transition can go on: pictures on an unlocked video
 * track. Titles are left out, as the clip menu always has; the linked sound has
 * no picture to blend. Locked ones are counted so they can be named.
 */
function transitionTargets(ids: Iterable<string>): { open: string[]; locked: number } {
  const idSet = new Set(ids)
  const open: string[] = []
  let locked = 0
  for (const t of activeSequence(useStore.getState().project).tracks) {
    if (t.kind !== 'video') continue
    for (const c of t.clips) {
      if (!idSet.has(c.id) || c.title) continue
      if (t.locked) locked++
      else open.push(c.id)
    }
  }
  return { open, locked }
}

/**
 * The same transition on the same edge of EVERY selected picture, in ONE undo
 * step, each with the per kind length setClipTransition would give it.
 *
 * His standing ask (2026-10-04) on every path: a gym montage is twenty cuts,
 * and selecting all twenty and picking White Flash put it on ONE of them from
 * every door (the clip menu, the Effects tab, a drop). Returns how many changed.
 */
export function setClipsTransition(
  ids: Iterable<string>,
  edge: 'in' | 'out',
  kind: TransitionKind,
  durationS?: number,
  /** False for a duration scrub, which commits on every arrow press. */
  say = true,
): number {
  const { open, locked } = transitionTargets(ids)
  const show = useToasts.getState().show
  if (open.length === 0) {
    if (locked > 0) show(locked === 1 ? 'That clip is on a locked track' : 'Those clips are on a locked track', 'danger')
    return 0
  }
  const key = edge === 'in' ? 'transitionIn' : 'transitionOut'
  let changed = 0
  mapClips(open, `Add ${edge} transition`, (c) => {
    const next = transitionFor(c[key], kind, durationS)
    if (c[key]?.type === next.type && c[key]?.durationS === next.durationS) return c
    changed++
    return { ...c, [key]: next }
  })
  if (say && (open.length > 1 || locked > 0)) {
    const where = edge === 'in' ? 'start' : 'end'
    const left = locked > 0 ? `. ${lockedLeftOut(locked)}` : ''
    show(`${TRANSITION_LABELS[kind]} at the ${where} of ${open.length} clip${open.length === 1 ? '' : 's'}${left}`, 'success')
  }
  return changed
}

/** Take the transition off that edge of every selected picture, ONE undo step. */
export function removeClipsTransition(ids: Iterable<string>, edge: 'in' | 'out'): void {
  const key = edge === 'in' ? 'transitionIn' : 'transitionOut'
  mapClips(transitionTargets(ids).open, `Remove ${edge} transition`, (c) => {
    if (!c[key]) return c
    const next = { ...c }
    delete next[key]
    return next
  })
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

/**
 * Fit inside, Fill and crop, or Stretch to fill, on every selected picture at
 * once, in ONE undo step. His ask, 2026-09-29, is one 4:3 clip, but a Short is
 * twenty of them, and a choice that has to be made twenty times is not made.
 *
 * Only clips on a VIDEO track take it: the linked sound of a selected clip
 * comes along in the selection and has no picture to fit. Titles and adjustment
 * layers are left alone by withFrameFit itself. Each clip is fitted against its
 * own media's size, so a mixed selection of 4:3 and 16:9 all fill correctly.
 */
export function setFrameFitForClips(ids: Iterable<string>, fit: FrameFit): void {
  const project = useStore.getState().project
  const seq = activeSequence(project)
  const pictures = new Set(seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips.map((c) => c.id)))
  const label = FRAME_FITS.find((f) => f.fit === fit)?.label ?? 'Frame'
  mapClips(
    [...ids].filter((id) => pictures.has(id)),
    label,
    (c) => withFrameFit(c, fit, frameFitDims(seq, project.assets[c.assetId])),
  )
}
