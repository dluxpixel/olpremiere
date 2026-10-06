// Looks: one double click applies a whole channel style. The Jettism look = the
// genre-standard punchy grade on every video clip + a tall frame (9:16, or Phone kept) + pop
// entrances for new text. The project edit is ONE dispatch (one undo step); the
// default-appearance side effect lives outside the undo stack by design.

import { aspectKeyFor, FORMATS } from '../components/frameFormats'
import { CAPTION_POP_DUR_S } from '../engine/captions/captions'
import { setSequenceFormat } from '../engine/timeline'
import { newId, type Clip, type EffectInstance, type Sequence } from '../engine/types'
import { setDefaultTextAppearance } from './appearanceActions'
import { useStore } from './store'
import { useToasts } from './toasts'

/** Shorts frame. */
const LOOK_W = 1080
const LOOK_H = 1920

/**
 * The frame the look leaves the video in.
 *
 * ⛔ A PHONE VIDEO STAYS PHONE. His ask, 2026-10-05, made Phone (1080x2112) the
 * frame for TikTok and Reels. The look always set 1080x1920, so it switched a
 * Phone video back to 9:16, said "9:16" while doing it, and rewrote the project
 * default so his next video started at 9:16 too. Anything else still becomes
 * 9:16, as before.
 */
function lookFrame(seq: Sequence): { w: number; h: number; words: string } {
  const phone = FORMATS.find((f) => f.key === 'phone')
  if (phone && aspectKeyFor(seq.width, seq.height) === 'phone') {
    return { w: phone.w, h: phone.h, words: 'kept the Phone frame' }
  }
  return { w: LOOK_W, h: LOOK_H, words: '9:16' }
}

/**
 * The grade, straight from the channel spec: +13% saturation, +10% contrast,
 * +0.1 stops. Fresh instance ids per call (instances live on clips).
 *
 * The contrast used to ride on `brightnessContrast { brightness: 0, contrast:
 * 0.1 }`. It is the standalone `contrast` effect now, and the two render
 * identically because the new shader IS the old one's contrast line. This
 * signature is load-bearing: `hasJettismGrade` below matches on it, and
 * migrate.ts rewrites the old instance to this exact shape on load so clips
 * graded before the split still read as graded. Change one without the other
 * and a second click double-grades every old clip.
 */
export function jettismGradeEffects(): EffectInstance[] {
  return [
    { id: newId(), type: 'exposure', enabled: true, params: { exposure: 0.1 } },
    { id: newId(), type: 'contrast', enabled: true, params: { contrast: 0.1 } },
    { id: newId(), type: 'saturation', enabled: true, params: { saturation: 0.13 } },
  ]
}

/** Signature match so a second click doesn't stack the grade twice. */
function hasJettismGrade(clip: Clip): boolean {
  const grade = jettismGradeEffects()
  return grade.every((g) =>
    clip.effects.some(
      (e) => e.type === g.type && JSON.stringify(e.params) === JSON.stringify(g.params),
    ),
  )
}

// There is deliberately NO third door to this grade. Applying the look used to
// deposit a "Jettism Punch" preset into the user's Library, sitting among the
// presets they actually saved, and that copy applied through applyPresetToSelection,
// which appends unconditionally. So the one door that looked identical to the other
// two was the only one that could grade an already-graded clip a second time and
// blow it out. The Effects tab tile and the Inspector button both route through
// applyPunchyGradeToClips, which dedupes.

/** Just the grade on one clip (no 9:16, no text defaults). */
export function applyPunchyGrade(clipId: string): void {
  applyPunchyGradeToClips([clipId])
}

/**
 * The punch grade on every selected clip in ONE undo step (the multi-select
 * "Punch grade" button). Title clips and already-graded clips are skipped, so a
 * second click never stacks the grade twice. It now SAYS so, instead of the
 * button flashing while nothing happens and nothing explains why.
 */
export function applyPunchyGradeToClips(ids: Iterable<string>): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) {
    // A double click that did nothing and said nothing looked broken.
    useToasts.getState().show('Select a clip first', 'info')
    return
  }
  let graded = 0
  useStore.getState().dispatch('Punchy grade', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    let changed = false
    // Sound is not graded: the audio that rides along in a selection is not a clip
    // this changed, and it is not one this counts.
    const tracks = seq.tracks.map((t) =>
      t.kind === 'audio' || t.locked || !t.clips.some((c) => idSet.has(c.id))
        ? t
        : {
            ...t,
            clips: t.clips.map((c) => {
              if (!idSet.has(c.id) || c.title || hasJettismGrade(c)) return c
              changed = true
              graded++
              return { ...c, effects: [...c.effects, ...jettismGradeEffects()] }
            }),
          },
    )
    return changed ? { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } } : p
  })
  useToasts
    .getState()
    .show(
      graded > 0 ? `Punch grade on ${graded} clip${graded === 1 ? '' : 's'}` : 'Those clips are already graded',
      graded > 0 ? 'success' : 'info',
    )
}

/**
 * Apply the Jettism look: a tall frame (9:16, or Phone kept as Phone) + punch
 * grade on every ungraded video clip (title clips stay clean, since the caption
 * style owns them) in one undo step, and pop as the default text entrance.
 *
 * Locked tracks are left alone, the way the Punchy Grade leaves them. A second
 * double click with nothing left to do adds no undo step: it used to rebuild
 * every video track, so Ctrl+Z then took back a step that changed nothing.
 */
export function applyJettismLook(): void {
  let graded = 0
  let words = '9:16'
  useStore.getState().dispatch('Apply Jettism look', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const frame = lookFrame(seq)
    words = frame.words
    const formatted = setSequenceFormat(seq, p.assets, frame.w, frame.h, true)
    // setSequenceFormat hands back a new sequence even when nothing in it moved.
    const refitted =
      formatted.width !== seq.width ||
      formatted.height !== seq.height ||
      formatted.tracks.some((t, i) => t !== seq.tracks[i])
    const tracks = formatted.tracks.map((t) => {
      if (t.kind !== 'video' || t.locked) return t
      let touched = false
      const clips = t.clips.map((c) => {
        if (c.title || hasJettismGrade(c)) return c
        touched = true
        graded++
        return { ...c, effects: [...c.effects, ...jettismGradeEffects()] }
      })
      return touched ? { ...t, clips } : t
    })
    const regraded = tracks.some((t, i) => t !== formatted.tracks[i])
    const sameDefault = p.settings.width === frame.w && p.settings.height === frame.h
    if (!refitted && !regraded && sameDefault) return p
    const sq = regraded ? { ...formatted, tracks } : formatted
    return {
      ...p,
      sequences: { ...p.sequences, [seq.id]: sq },
      settings: sameDefault ? p.settings : { ...p.settings, width: frame.w, height: frame.h },
    }
  })
  setDefaultTextAppearance({ in: 'pop', durS: CAPTION_POP_DUR_S })
  useToasts
    .getState()
    .show(
      graded > 0
        ? `Jettism look: ${words}, punch grade on ${graded} clip${graded === 1 ? '' : 's'}, pop titles`
        : `Jettism look: ${words}, clips already graded, pop titles`,
      'success',
    )
}
