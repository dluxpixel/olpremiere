// Caption actions: turn a title's text (manual mode) or a timed word list
// (auto-caption / transcription) into a run of word-caption title clips.
// Each action is ONE dispatch — a 40-clip caption pass undoes atomically.

import { applyAppearanceToClip } from '../engine/anim/appearance'
import {
  captionClips,
  chunkWords,
  spreadWords,
  type CaptionWord,
} from '../engine/captions/captions'
import { addTrack, clipDurationS, recomputeDuration, resolveStart } from '../engine/timeline'
import { activeSequence, videoTracks, type Clip, type Track } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import type { TextStylePreset } from './textPresets'
import { useToasts } from './toasts'

/** One word per caption — the brief's hard-cut house style. */
const AUTO_CAPTION_MAX_WORDS = 1

/** Place clips one by one so each lands in a real gap (never overlapping). */
function withClips(track: Track, clips: Clip[]): Track {
  let next = track
  for (const clip of clips) {
    const startS = resolveStart(next, clip.startS, clipDurationS(clip))
    const placed = { ...clip, startS }
    next = { ...next, clips: [...next.clips, placed].sort((a, b) => a.startS - b.startS) }
  }
  return next
}

/**
 * Replace a title clip with one caption clip per word, spread across its
 * duration and styled like the original — the manual path to word-by-word
 * captions when there is no transcript. One undo step restores the original.
 */
export function splitTitleIntoWordCaptions(clipId: string): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!track || !clip?.title) return
  if (track.locked) {
    useToasts.getState().show('Track is locked', 'danger')
    return
  }
  const endS = clip.startS + clipDurationS(clip)
  const words = spreadWords(clip.title.text, clip.startS, endS - clip.startS)
  if (words.length < 2) {
    useToasts.getState().show('Type at least two words first', 'danger')
    return
  }
  // holdS 0: the words are contiguous, so captions still hand off seamlessly —
  // but the run must not outgrow the window the original clip occupied.
  const chunks = chunkWords(words, { maxWords: 1, holdS: 0 }).map((c) => ({
    ...c,
    endS: Math.min(c.endS, endS),
  }))
  const pieces = captionClips(chunks, {
    seqWidth: seq.width,
    seqHeight: seq.height,
    baseDef: clip.title,
  })
  updateActiveSequence('Split into word captions', (sq) => {
    const t = sq.tracks.find((x) => x.id === track.id)
    if (!t || !t.clips.some((c) => c.id === clipId)) return sq
    const cleared = { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
    const filled = withClips(cleared, pieces)
    return recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((x) => (x.id === t.id ? filled : x)),
    })
  })
  s.setUI({ selection: pieces.map((c) => c.id) })
  useToasts.getState().show(`Split into ${pieces.length} word captions`)
}

/**
 * Lay a full caption run (Jettism house style) onto a NEW top video track from
 * absolute-timed words — the landing point for the transcriber. One undo step.
 */
export function addCaptionsFromWords(
  words: CaptionWord[],
  options: { label?: string; maxWords?: number; preset?: TextStylePreset } = {},
): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const chunks = chunkWords(words, { maxWords: options.maxWords ?? AUTO_CAPTION_MAX_WORDS })
  if (chunks.length === 0) {
    useToasts.getState().show('No words to caption', 'danger')
    return
  }
  let clips = captionClips(chunks, { seqWidth: seq.width, seqHeight: seq.height })
  // Apply the chosen caption STYLE preset (case/outline/colour/position) + its
  // entrance/exit animation to every word, so the whole run lands pre-styled.
  const preset = options.preset
  if (preset) {
    clips = clips.map((c) => {
      if (!c.title) return c
      let nc: Clip = { ...c, title: { ...c.title, ...preset.style } }
      if (preset.appearance) nc = applyAppearanceToClip(nc, preset.appearance, seq.width, seq.height)
      return nc
    })
  }
  updateActiveSequence(options.label ?? 'Auto-caption', (sq) => {
    const grown = addTrack(sq, 'video')
    const target = videoTracks(grown)[videoTracks(grown).length - 1]
    const filled = withClips(target, clips)
    return recomputeDuration({
      ...grown,
      tracks: grown.tracks.map((t) => (t.id === target.id ? filled : t)),
    })
  })
  s.setUI({ selection: clips.map((c) => c.id) })
  useToasts.getState().show(`${clips.length} captions added`)
}
