// Title clip creation + editing. A title lives entirely on the clip (no bin
// asset) and rasterizes to a texture at render time.

import { isEmptyAppearance } from '../engine/anim/appearance'
import { clipDurationS, recomputeDuration, resolveStart } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newAdjustmentClip,
  newTitleClip,
  videoTracks,
  withTitleFontSize,
  type Clip,
  type TitleDef,
  type Track,
} from '../engine/types'
import { applyAppearanceToClip, getDefaultTextAppearance } from './appearanceActions'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

const DEFAULT_TITLE_S = 5

/** Topmost unlocked video track (titles overlay footage below them). */
function titleTargetTrack(tracks: Track[]): Track | undefined {
  const vids = videoTracks({ tracks } as never)
  return [...vids].reverse().find((t) => !t.locked)
}

export function addTitleClip(text = 'Title'): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const target = titleTargetTrack(seq.tracks)
  if (!target) {
    useToasts.getState().show('No unlocked video track for the title', 'danger')
    return
  }
  let clip = newTitleClip(defaultTitleDef(text), s.ui.playheadS, DEFAULT_TITLE_S)
  // New titles inherit the saved default entrance/exit, so a chosen "how it
  // appears" applies every time (compiled to keyframes up front).
  const def = getDefaultTextAppearance()
  if (def && !isEmptyAppearance(def)) clip = applyAppearanceToClip(clip, def, seq.width, seq.height)
  updateActiveSequence('Add title', (sq) => {
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
