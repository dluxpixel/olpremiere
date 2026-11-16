// Title clip creation + editing. A title lives entirely on the clip (no bin
// asset) and rasterizes to a texture at render time.

import { isEmptyAppearance } from '../engine/anim/appearance'
import { safeRect } from '../engine/safeSnap'
import { clipDurationS, recomputeDuration, resolveStart } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newAdjustmentClip,
  newTitleClip,
  videoTracks,
  withTitleFontSize,
  type AppearanceSpec,
  type Clip,
  type TitleDef,
  type Track,
} from '../engine/types'
import { startTextEdit } from '../components/MonitorTextEdit'
import { applyAppearanceToClip, getDefaultTextAppearance } from './appearanceActions'
import { useSettings } from './settings'
import { updateActiveSequence, useStore } from './store'
import { titleLookById } from './titleShelf'
import { useToasts } from './toasts'

const DEFAULT_TITLE_S = 5

/** Topmost unlocked video track (titles overlay footage below them). */
function titleTargetTrack(tracks: Track[]): Track | undefined {
  const vids = videoTracks({ tracks } as never)
  return [...vids].reverse().find((t) => !t.locked)
}

/**
 * A new title at the playhead (the T key and the toolbar button). In TikTok text mode it is the
 * tiktok-plain look, at the middle of the SAFE area rather than the frame, empty, and straight
 * into typing on the video. Out of the mode it is the plain default title, exactly as before.
 */
export function addTitleClip(text?: string): void {
  if (!useSettings.getState().tiktokMode) {
    addTitle(defaultTitleDef(text ?? 'Title'), getDefaultTextAppearance() ?? undefined, DEFAULT_TITLE_S, 'Add title')
    return
  }
  const look = titleLookById('tiktok-plain')
  if (!look) return
  addTitle(
    { ...defaultTitleDef(text ?? ''), ...look.style },
    look.appearance,
    look.durationS,
    'Add title',
    undefined,
    { centreOnSafeArea: true, typeNow: true },
  )
}

/**
 * A ready made title off the shelf (titleShelf.ts): its own style, entrance,
 * exit and starting text, at the playhead or at `atS` when it was dropped.
 */
export function addTitleFromShelf(lookId: string, atS?: number): void {
  const look = titleLookById(lookId)
  if (!look) return
  addTitle({ ...defaultTitleDef(look.text), ...look.style }, look.appearance, look.durationS, `Add ${look.name}`, atS)
}

interface TikTokPlacement {
  /** Move the title to the middle of TikTok's safe area (the frame minus the app's buttons and caption). */
  centreOnSafeArea: boolean
  /** Go straight into typing on the video. */
  typeNow: boolean
}

function addTitle(
  def: TitleDef,
  appearance: AppearanceSpec | undefined,
  durationS: number,
  label: string,
  atS?: number,
  tiktok?: TikTokPlacement,
): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const target = titleTargetTrack(seq.tracks)
  if (!target) {
    useToasts.getState().show('No unlocked video track for the title', 'danger')
    return
  }
  const wantS = atS ?? s.ui.playheadS
  let clip = newTitleClip(def, wantS, durationS)
  if (tiktok?.centreOnSafeArea) {
    // A title sits on the frame's middle, so its framing offset is how far the safe area's middle
    // is from it. Set before the entrance is compiled, which is relative to this base.
    const safe = safeRect(seq.width, seq.height, 'tiktok')
    clip = {
      ...clip,
      transform: {
        ...clip.transform,
        x: safe.x + safe.w / 2 - seq.width / 2,
        y: safe.y + safe.h / 2 - seq.height / 2,
      },
    }
  }
  // New titles inherit the saved default entrance/exit, so a chosen "how it
  // appears" applies every time (compiled to keyframes up front).
  if (appearance && !isEmptyAppearance(appearance)) clip = applyAppearanceToClip(clip, appearance, seq.width, seq.height)
  updateActiveSequence(label, (sq) => {
    const track = sq.tracks.find((t) => t.id === target.id)
    if (!track) return sq
    const startS = resolveStart(track, wantS, clipDurationS(clip))
    const placed: Clip = { ...clip, startS }
    const tracks = sq.tracks.map((t) =>
      t.id === track.id
        ? { ...t, clips: [...t.clips, placed].sort((a, b) => a.startS - b.startS) }
        : t,
    )
    return recomputeDuration({ ...sq, tracks })
  })
  s.setUI({ selection: [clip.id] })
  // Not while the video plays: the field only shows on a paused picture.
  if (tiktok?.typeNow && !s.ui.playing) startTextEdit(clip.id)
}

/**
 * Add an ADJUSTMENT layer at the playhead on the topmost unlocked video track
 * (same placement rule as titles, since it must sit ABOVE the footage it grades).
 * Effects added to it in the Inspector apply to everything below its span.
 */
export function addAdjustmentClip(): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const target = titleTargetTrack(seq.tracks)
  if (!target) {
    useToasts.getState().show('No unlocked video track for the adjustment layer', 'danger')
    return
  }
  const clip = newAdjustmentClip(s.ui.playheadS, DEFAULT_TITLE_S)
  updateActiveSequence('Add adjustment layer', (sq) => {
    const track = sq.tracks.find((t) => t.id === target.id)
    if (!track) return sq
    const startS = resolveStart(track, s.ui.playheadS, clipDurationS(clip))
    const placed: Clip = { ...clip, startS }
    const tracks = sq.tracks.map((t) =>
      t.id === track.id
        ? { ...t, clips: [...t.clips, placed].sort((a, b) => a.startS - b.startS) }
        : t,
    )
    return recomputeDuration({ ...sq, tracks })
  })
  s.setUI({ selection: [clip.id] })
}

/**
 * Patch the selected title clip's definition (one undo step per change).
 *
 * `mergeField` names a field being edited CONTINUOUSLY (typing into the text
 * box, dragging a slider) so the run folds into a single undo step instead of
 * one step per keystroke. Without it a typed sentence cost thirty undo steps and
 * a couple of paragraphs pushed the whole session off the end of the history.
 */
export function updateTitle(
  clipId: string,
  patch: Partial<TitleDef>,
  mergeField?: keyof TitleDef,
): void {
  updateActiveSequence(
    'Edit title',
    (seq) => ({
      ...seq,
      tracks: seq.tracks.map((t) =>
        t.clips.some((c) => c.id === clipId)
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId && c.title ? { ...c, title: { ...c.title, ...patch } } : c,
              ),
            }
          : t,
      ),
    }),
    mergeField === undefined ? undefined : `title:${mergeField}:${clipId}`,
  )
}

/**
 * The key that folds a run of edits to ONE field across the SAME selection into
 * a single undo step. Sorted, so a selection built by shift-clicking backwards
 * is still the same gesture and not a second step.
 */
function titlesMergeKey(idSet: Set<string>, mergeField: keyof TitleDef | undefined): string | undefined {
  return mergeField === undefined
    ? undefined
    : `titles:${mergeField}:${[...idSet].sort().join(',')}`
}

/**
 * Resize the type on every selected title, bringing each one's outline, shadow
 * and box padding with it. Not expressible as a patch: the scale factor depends
 * on the clip's CURRENT size, which differs across a selection.
 *
 * `mergeField` marks a CONTINUOUS run (holding an arrow key on the size field)
 * so it costs one undo step, exactly as in updateTitle. The size presets in the
 * clip menu pass nothing and stay one step each.
 */
export function setTitlesFontSize(
  ids: Iterable<string>,
  fontSizePx: number,
  mergeField?: keyof TitleDef,
): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  updateActiveSequence('Set text size', (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id) && c.title)) return t
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id) || !c.title) return c
        const title = withTitleFontSize(c.title, fontSizePx)
        if (title === c.title) return c
        changed = true
        return { ...c, title }
      })
      return changed ? { ...t, clips } : t
    })
    return changed ? { ...seq, tracks } : seq
  }, titlesMergeKey(idSet, mergeField))
}

/**
 * Patch the SAME field(s) on every selected title clip in ONE undo step:
 * bold/italic, family, size, colour across a whole multi-selection. Non-title
 * clips and locked tracks are skipped; nothing changing records no undo step.
 */
export function updateTitles(
  ids: Iterable<string>,
  patch: Partial<TitleDef>,
  mergeField?: keyof TitleDef,
): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  updateActiveSequence('Edit titles', (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id) && c.title)) return t
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id) || !c.title) return c
        changed = true
        return { ...c, title: { ...c.title, ...patch } }
      })
      return changed ? { ...t, clips } : t
    })
    return changed ? { ...seq, tracks } : seq
  }, titlesMergeKey(idSet, mergeField))
}
