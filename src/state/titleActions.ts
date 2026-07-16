// Title clip creation + editing. A title lives entirely on the clip (no bin
// asset) and rasterizes to a texture at render time.

import { isEmptyAppearance } from '../engine/anim/appearance'
import { clipDurationS, recomputeDuration, resolveStart } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newTitleClip,
  videoTracks,
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

/** Patch the selected title clip's definition (one undo step per change). */
export function updateTitle(clipId: string, patch: Partial<TitleDef>): void {
  updateActiveSequence('Edit title', (seq) => ({
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
  }))
}

/**
 * Patch the SAME field(s) on every selected title clip in ONE undo step —
 * bold/italic, family, size, colour across a whole multi-selection. Non-title
 * clips and locked tracks are skipped; nothing changing records no undo step.
 */
export function updateTitles(ids: Iterable<string>, patch: Partial<TitleDef>): void {
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
  })
}
