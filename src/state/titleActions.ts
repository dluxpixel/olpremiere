// Title clip creation + editing. A title lives entirely on the clip (no bin
// asset) and rasterizes to a texture at render time.

import { isEmptyAppearance } from '../engine/anim/appearance'
import { computeQuad, subQuad } from '../engine/render/mat'
import { titleInkBoxUV } from '../engine/render/titleRaster'
import type { ResolvedTransform } from '../engine/render/types'
import { alignShiftX, safeRect } from '../engine/safeSnap'
import { boxFromQuad } from '../engine/snapTransform'
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
  // Marked FRESH: typing that ends with it still empty takes it away again (dropEmptyFreshTitle).
  if (tiktok?.typeNow && !s.ui.playing) startTextEdit(clip.id, true)
}

function findClip(clipId: string): Clip | undefined {
  return activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
}

/**
 * A title the TikTok text mode just made, whose typing has ended with nothing in it (or only
 * spaces and new lines): take it off the timeline, so no invisible title is left behind. Called by
 * endTextEdit for a FRESH typing session only, never for a title that was already there.
 *
 * If nothing has been done since the title was added, the add itself is taken back out of the
 * history (undo, then the redo it leaves is dropped), so no pointless step remains. If he typed
 * and deleted, or styled it, that work is real history, so the removal is one 'Delete clip' step
 * that undo brings back.
 */
export function dropEmptyFreshTitle(clipId: string): void {
  const s = useStore.getState()
  const clip = findClip(clipId)
  if (!clip?.title || clip.title.text.trim() !== '') return
  const top = s.history.undo[s.history.undo.length - 1]
  if (top && top.label === 'Add title' && top.after === s.project) {
    s.undo()
    // Adding a command emptied the redo list, so it was empty before the undo made it hold the add.
    useStore.setState((st) => ({ history: { ...st.history, redo: [] } }))
    return
  }
  updateActiveSequence('Delete clip', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })) }),
  )
  const sel = useStore.getState().ui.selection
  if (sel.includes(clipId)) useStore.getState().setUI({ selection: sel.filter((id) => id !== clipId) })
}

/**
 * How far, in sequence px, a title must move sideways for its drawn box (highlight padding
 * included) to sit where `align` puts it in TikTok's safe area. Measured at the title's framing
 * as it stands, with the NEW alignment, because the alignment is what moves the box.
 * 0 where nothing is drawn yet (an empty title has no box to place).
 */
function alignShiftFor(clip: Clip, align: TitleDef['align'], seq: { width: number; height: number }): number {
  const uv = titleInkBoxUV({ ...clip.title!, align }, seq.width, seq.height)
  if (!uv) return 0
  const t = clip.transform
  const rt: ResolvedTransform = {
    x: t.x,
    y: t.y,
    scale: t.scale,
    rotationDeg: t.rotationDeg,
    anchorX: t.anchorX,
    anchorY: t.anchorY,
    cropT: t.crop.t,
    cropR: t.crop.r,
    cropB: t.crop.b,
    cropL: t.crop.l,
    ...(t.fit === 'stretch' ? { fit: 'stretch' as const } : {}),
  }
  const { corners } = computeQuad({ frameW: seq.width, frameH: seq.height, texW: seq.width, texH: seq.height, transform: rt })
  const box = boxFromQuad(subQuad(corners, uv))
  return alignShiftX(box, safeRect(seq.width, seq.height, 'tiktok'), align, seq.width)
}

/**
 * The TikTok bar's align button. In TikTok text mode the title is also moved sideways, in the
 * SAME edit (one undo step), so its drawn box stays inside the safe area with a side margin: left
 * at the safe left, right at the safe right (clear of TikTok's Buttons column), centre on the safe
 * centre. Its height is not changed. With the mode off it is just the alignment.
 */
export function setTitleAlign(clipId: string, align: TitleDef['align']): void {
  const clip = findClip(clipId)
  if (!clip?.title) return
  const seq = activeSequence(useStore.getState().project)
  const dx = useSettings.getState().tiktokMode ? alignShiftFor(clip, align, seq) : 0
  updateActiveSequence('Edit title', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId)
        ? {
            ...t,
            clips: t.clips.map((c) => {
              if (c.id !== clipId || !c.title) return c
              const moved: Clip = { ...c, title: { ...c.title, align }, transform: { ...c.transform, x: c.transform.x + dx } }
              // An entrance/exit is compiled from the base framing, so it follows the new base (as setClipTransform does).
              return dx !== 0 && moved.appearance ? applyAppearanceToClip(moved, moved.appearance, sq.width, sq.height) : moved
            }),
          }
        : t,
    ),
  }))
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
