// Caption actions: turn a title's text (manual mode) or a timed word list
// (auto-caption / transcription) into a run of word-caption title clips.
// Each action is ONE dispatch, so a 40-clip caption pass undoes atomically.

import { applyAppearanceToClip } from '../engine/anim/appearance'
import {
  AUTO_CAPTION_OPTIONS,
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

// Captions are AUTO, full stop. There is no words-per-caption dial any more.
//
// His call, 2026-07-28: "I want to make it only auto captions." The dial was the
// bug, not a feature: any word count welds words together across the pauses
// between them, so a caption ends up on screen while he is saying something else.
// AUTO_CAPTION_OPTIONS times every caption to the word it shows instead.

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
 * duration and styled like the original, the manual path to word-by-word
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
  // holdS/bridgeS 0: the words are contiguous, so captions still hand off
  // seamlessly, but the run must not outgrow the window the original clip held.
  const chunks = chunkWords(words, { maxWords: 1, holdS: 0, bridgeS: 0 }).map((c) => ({
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
 * absolute-timed words: the landing point for the transcriber. One undo step.
 */
export function addCaptionsFromWords(
  words: CaptionWord[],
  options: { label?: string; preset?: TextStylePreset } = {},
): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // AUTO, always, through every door: the dialog, the tap timer, the right-click
  // auto-caption and the caption-every-clip run all land here and all get one
  // word per caption, timed to the word.
  const chunks = chunkWords(words, AUTO_CAPTION_OPTIONS)
  if (chunks.length === 0) {
    useToasts.getState().show('No words to caption', 'danger')
    return
  }
  let clips = captionClips(chunks, { seqWidth: seq.width, seqHeight: seq.height })
  // Apply the saved caption STYLE (case/outline/colour/position), its entrance
  // and exit animation, AND its effect stack to every word, so the whole run
  // lands looking exactly like the one he built and saved.
  const preset = options.preset
  if (preset) {
    clips = clips.map((c) => {
      if (!c.title) return c
      let nc: Clip = { ...c, title: { ...c.title, ...preset.style } }
      if (preset.effects?.length) nc = { ...nc, effects: preset.effects.map((e) => ({ ...e })) }
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
