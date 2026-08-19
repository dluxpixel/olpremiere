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
import { candidateFixFor, wordFixFor, type StyleProfile } from '../engine/captions/styleProfile'
import { learnedProfile } from '../engine/captions/styleStore'
import { addTrack, clipDurationS, clipEndS, recomputeDuration, resolveStart } from '../engine/timeline'
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

/** Tracks keep their clips sorted by startS and non-overlapping. Same 1e-9 as the engine. */
const EPS = 1e-9

/**
 * True when the whole run can be dropped in exactly where it already sits: it is
 * ascending and non-overlapping in itself, the track is too, and the two do not
 * collide. One walk of each list, so asking is far cheaper than the placement it
 * saves. A caption run out of `chunkWords` always answers yes.
 */
function runFitsAsIs(track: Track, run: Clip[]): boolean {
  const ascending = (list: Clip[]): boolean => {
    for (let i = 1; i < list.length; i++) {
      if (list[i].startS < clipEndS(list[i - 1]) - EPS) return false
    }
    return true
  }
  if (!ascending(run) || !ascending(track.clips)) return false
  if (run[0].startS < -EPS) return false
  // Both lists ascend, so one merge walk decides every collision.
  let i = 0
  for (const clip of run) {
    while (i < track.clips.length && clipEndS(track.clips[i]) <= clip.startS + EPS) i++
    if (i < track.clips.length && track.clips[i].startS < clipEndS(clip) - EPS) return false
  }
  return true
}

/**
 * Place a run of caption clips on a track, keeping it sorted and non-overlapping.
 *
 * The slow path below is the honest general answer: ask `resolveStart` where each
 * clip actually fits, one at a time. It is also O(N^2 log N), because every clip
 * allocates a filtered copy of the track, walks every gap, then spreads and
 * re-sorts the whole array. Every caption is one word, and "caption every clip"
 * pools the words of the WHOLE project into a single run, so N is the word count
 * of everything he said. Measured: 750 words 21.6ms, 1500 words 60.6ms, 3000
 * words 168.9ms, 6000 words 540.9ms, all inside ONE synchronous dispatch with the
 * UI locked. Twenty minutes of talking is where it starts to be seen.
 *
 * `chunkWords` already guarantees ascending, non-overlapping chunks, and the auto
 * path lays them on a brand new empty track, so all that work re-derives an answer
 * the caller already had. Check the invariant ONCE instead of enforcing it N
 * times, and when it holds, merge and sort once.
 */
function withClips(track: Track, clips: Clip[]): Track {
  if (clips.length === 0) return track
  if (runFitsAsIs(track, clips)) {
    return { ...track, clips: [...track.clips, ...clips].sort((a, b) => a.startS - b.startS) }
  }
  // Something overlaps, so fall back to placing them one at a time. Correctness
  // first: a caption must never land on top of another clip.
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
 * What the caption track is called, and how the next run finds it.
 *
 * Also just better to look at: the header used to read "V3" for the one track
 * whose contents are obvious.
 */
export const CAPTION_TRACK_NAME = 'Captions'

/**
 * Lay a full caption run (Jettism house style) onto the caption track from
 * absolute-timed words: the landing point for the transcriber. One undo step.
 *
 * A run REPLACES the previous one rather than stacking a second track over it.
 */
export function addCaptionsFromWords(
  words: CaptionWord[],
  options: { label?: string; preset?: TextStylePreset; model?: string } = {},
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
  // What he has taught the captions, for THIS model only. Null until he has
  // archived a project captioned by it, which is the honest first-run state:
  // nothing has been learned yet, so nothing is changed.
  const profile = options.model ? learnedProfile(options.model) : null
  const relearned = profile ? chunks.filter((c) => wordFixFor(c.text, profile)).length : 0
  let clips = captionClips(chunks, {
    seqWidth: seq.width,
    seqHeight: seq.height,
    // Stamped here because this is the ONE place every caption door lands, so
    // no route can produce captions the learning cannot later read.
    model: options.model,
    profile,
  })
  // Apply the saved caption STYLE (case/outline/colour/position), its entrance
  // and exit animation, AND its effect stack to every word, so the whole run
  // lands looking exactly like the one he built and saved.
  const preset = options.preset
  if (preset) {
    clips = clips.map((c, i) => {
      if (!c.title) return c
      // ⛔ THE HIGHLIGHT COLOUR SURVIVES THE STYLE. captionClips paints the
      // emphasised word in the highlight colour, and a saved style ALWAYS
      // carries a colour of its own, so spreading it over the top repainted the
      // one word that had earned the highlight back to the ordinary colour. The
      // dialog still showed the highlight switched on, so it read as the feature
      // simply not working. One clip per chunk, in order, is what captionClips
      // returns, which is what makes the index safe to read here.
      const style = chunks[i]?.emphasis ? { ...preset.style, color: c.title.color } : preset.style
      let nc: Clip = { ...c, title: { ...c.title, ...style } }
      if (preset.effects?.length) nc = { ...nc, effects: preset.effects.map((e) => ({ ...e })) }
      if (preset.appearance) nc = applyAppearanceToClip(nc, preset.appearance, seq.width, seq.height)
      return nc
    })
  }
  // ⛔ A SECOND RUN REPLACES THE FIRST INSTEAD OF STACKING ON TOP OF IT.
  //
  // Every run used to call `addTrack` unconditionally with nothing anywhere
  // checking for a previous one. Captioning, noticing the language was wrong,
  // and captioning again left TWO full runs at the same timecodes in the same
  // style, so on screen it looked almost right and was drawing every word twice:
  // fatter, darker text from the doubled outline, text that would not go away
  // when he deleted "the" caption track, and two undo steps to get back with no
  // reason to expect a second. The toast said "N captions added" either way.
  //
  // The track is NAMED so the next run can find it. `addTrack` numbers V1, V2
  // by reading digits off the name and skips anything that does not parse, so a
  // named track cannot disturb the numbering of the others.
  let replaced = 0
  /** Set when his Captions track is locked, so the run says so instead of going quiet. */
  let lockedOut = false
  updateActiveSequence(options.label ?? 'Auto-caption', (sq) => {
    const existing = videoTracks(sq).filter((t) => t.name === CAPTION_TRACK_NAME)
    const reuse = existing[existing.length - 1]
    // ⛔ A LOCKED CAPTIONS TRACK IS NOT EMPTIED. Reuse below clears the track and
    // refills it, which is exactly the edit a lock exists to refuse, and it went
    // through silently: he would lock the captions he had hand corrected, run the
    // verb again, and every correction was gone with the toast reading as normal.
    if (reuse?.locked) {
      lockedOut = true
      return sq
    }
    if (reuse) {
      replaced = reuse.clips.length
      // EMPTIED first. `withClips` MERGES into whatever is already on the track,
      // so reusing it without clearing would have interleaved the new run with
      // the old one, which is the doubling this exists to stop wearing a hat.
      const filled = withClips({ ...reuse, clips: [] }, clips)
      return recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.id === reuse.id ? filled : t)) })
    }
    const grown = addTrack(sq, 'video')
    const target = videoTracks(grown)[videoTracks(grown).length - 1]
    const filled = { ...withClips(target, clips), name: CAPTION_TRACK_NAME }
    return recomputeDuration({
      ...grown,
      tracks: grown.tracks.map((t) => (t.id === target.id ? filled : t)),
    })
  })
  if (lockedOut) {
    useToasts.getState().show('Your Captions track is locked, so nothing was changed', 'danger')
    return
  }
  s.setUI({ selection: clips.map((c) => c.id) })

  // ⛔ THE SUGGESTION IS OFFERED, NEVER APPLIED. His words, 2026-08-19:
  // *"Sometimes, even suggest improvements... Maybe I'll apply them."* A
  // candidate is a word he retyped ONCE, which is real evidence and not yet a
  // habit, so putting it in his video unasked would be the app inventing a
  // spelling off a single sample. The button is the whole difference.
  const suggested = profile ? chunks.filter((c) => candidateFixFor(c.text, profile)).length : 0

  useToasts
    .getState()
    .show(
      // He asked to be told when it used what it learned, and told nothing
      // otherwise. A run that changed no words says exactly what it always said.
      [
        replaced > 0 ? `${clips.length} captions, replacing the last run` : `${clips.length} captions added`,
        relearned > 0 ? `${relearned} spelled your way` : '',
      ]
        .filter(Boolean)
        .join(', '),
      'info',
      suggested > 0 && profile
        ? {
            label: `Spell ${suggested} more your way`,
            onClick: () => applyCandidateSpellings(profile),
          }
        : undefined,
    )
}

/**
 * Rewrite the captions of the last run that match a candidate, on his say so.
 *
 * ⛔ IT READS `captionOrigin`, NOT THE TEXT ON SCREEN. The visible text has been
 * through the house casing and his saved preset, so matching against it would
 * miss every caption whose look he had changed. The origin is what the machine
 * wrote, which is the key the whole profile is built on, and it is stamped on
 * the clip rather than kept in a side log for exactly this reason.
 *
 * One undo step for the lot: he pressed one button.
 */
export function applyCandidateSpellings(profile: StyleProfile): void {
  let changed = 0
  updateActiveSequence('Spell captions his way', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) => {
      if (t.name !== CAPTION_TRACK_NAME) return t
      return {
        ...t,
        clips: t.clips.map((c) => {
          if (!c.title || !c.captionOrigin) return c
          const hit = candidateFixFor(c.captionOrigin.text, profile)
          if (!hit || c.title.text === hit.to) return c
          changed++
          return { ...c, title: { ...c.title, text: hit.to } }
        }),
      }
    }),
  }))
  useToasts.getState().show(changed > 0 ? `${changed} spelled your way` : 'Nothing left to change')
}
