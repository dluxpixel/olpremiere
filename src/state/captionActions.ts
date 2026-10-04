// Caption actions: turn a title's text (manual mode) or a timed word list
// (auto-caption / transcription) into a run of word-caption title clips.
// Each action is ONE dispatch, so a 40-clip caption pass undoes atomically.

import { captionClips, chunkWords, spreadWords, type CaptionWord } from '../engine/captions/captions'
import {
  AUTO_SHAPE,
  BUILTIN_CAPTION_STYLES,
  breakLines,
  chunkOptionsFor,
  dressCaption,
  recutCaptions,
  sameShape,
  type CaptionStyle,
} from '../engine/captions/captionStyle'
import { candidateFixFor, wordFixFor, type StyleProfile } from '../engine/captions/styleProfile'
import { learnedProfile } from '../engine/captions/styleStore'
import { addTrack, clipDurationS, clipEndS, recomputeDuration, resolveStart } from '../engine/timeline'
import { activeSequence, videoTracks, type Clip, type Sequence, type Track } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'
import { plural } from '../engine/plural'

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
  useToasts.getState().show(`Split into ${plural(pieces.length, 'word caption')}`)
}

/**
 * What the caption track is called, and how the next run finds it.
 *
 * Also just better to look at: the header used to read "V3" for the one track
 * whose contents are obvious.
 */
export const CAPTION_TRACK_NAME = 'Captions'

/**
 * Lay a full caption run onto the caption track from absolute-timed words: the
 * landing point for the transcriber, the paste and the tap timer. One undo step.
 *
 * The run is cut and dressed by ONE caption style: its length decides where
 * each caption ends, its look what every word looks like. No style is the house
 * style, which is exactly what a run without one has always made.
 *
 * A run REPLACES the previous one rather than stacking a second track over it.
 */
export function addCaptionsFromWords(
  words: CaptionWord[],
  options: {
    label?: string
    style?: CaptionStyle
    model?: string
    /**
     * The exact stretches this run actually listened to, e.g. one per source
     * clip in a pooled "caption every clip" sweep. When given, only a previous
     * caption overlapping one of THESE spans is replaced. Omit it (a single
     * clip, or manual text split into words) and the run falls back to the one
     * bounding box its own words cover, same as before.
     *
     * ⛔ WITHOUT THIS, A POOLED MULTI-CLIP RUN DELETED CAPTIONS BETWEEN THE
     * CLIPS IT COVERS. "Caption every clip" and "caption selected clips" pool
     * every target clip's words into ONE flat array and make ONE call here, so
     * with no clip boundaries the old code took the single min/max span of
     * every word in the whole run: two captioned clips ten seconds apart wiped
     * anything sitting in the nine seconds between them, including a caption he
     * had hand corrected on a clip this run never touched. "Only the stretch
     * this run covers is replaced" meant the stretch each clip covers, not the
     * bounding box around clips this run happened to skip.
     */
    coveredSpans?: { startS: number; endS: number }[]
  } = {},
): void {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const style = options.style ?? BUILTIN_CAPTION_STYLES[0]!
  // Every door lands here, so every door cuts the same way: the style's length.
  // Its auto length is AUTO_CAPTION_OPTIONS untouched, the measured cut every
  // run made before styles had a length at all.
  const chunks = chunkWords(words, chunkOptionsFor(style.shape, seq.fps))
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
  // Dress every word in the style (look, entrance, effects), so the whole run
  // lands looking exactly like the one he built and saved, and set two line
  // captions on their two lines.
  //
  // ⛔ THE HIGHLIGHT COLOUR SURVIVES THE STYLE. A saved style always carries a
  // colour of its own, and spreading it over the word the highlight picked
  // repainted that word back to the ordinary colour while the switch still read
  // on. dressCaption reads `captionEmphasis`, which captionClips stamps on that
  // word, and paints it in the style's highlight colour instead.
  clips = clips.map((c) => {
    if (!c.title) return c
    const lined = breakLines(c.title.text, style.shape)
    const withLines = lined === c.title.text ? c : { ...c, title: { ...c.title, text: lined } }
    return dressCaption(withLines, style, seq.width, seq.height)
  })
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
      // ⛔ ONLY THE STRETCH THIS RUN COVERS IS REPLACED. THE REST IS HIS.
      //
      // His words, 2026-08-24: *"every time I start the caption thing, it
      // deletes the last caption, so I can't caption them one by one, which
      // fucking sucks."* The track was EMPTIED here on every run, so captioning
      // his second clip threw away the captions he had just made, and often
      // hand-corrected, for his first. Captioning a video a clip at a time was
      // impossible, and that is how he actually works.
      //
      // Emptying was there to stop a re-run of the SAME stretch interleaving
      // with the old one, which is a real fault and stays fixed: anything
      // overlapping this run's span still goes. Outside the span nothing is
      // touched, so a second clip ADDS and a repeat of the same clip REPLACES.
      // Captioning the whole timeline still clears the lot, because its span is
      // the lot.
      //
      // The span is per COVERED STRETCH, not one box around all of them: a
      // pooled sweep passes one per source clip, so a stretch it never touched
      // (a skipped clip between two captioned ones) is not "inside the run"
      // just because it sits between two spans this run does cover.
      const spans =
        options.coveredSpans && options.coveredSpans.length > 0
          ? options.coveredSpans
          : [{ startS: Math.min(...clips.map((c) => c.startS)), endS: Math.max(...clips.map((c) => clipEndS(c))) }]
      const overlapsRun = (c: Clip): boolean =>
        spans.some((span) => clipEndS(c) > span.startS + EPS && c.startS < span.endS - EPS)
      const kept = reuse.clips.filter((c) => !overlapsRun(c))
      replaced = reuse.clips.length - kept.length
      const filled = { ...withClips({ ...reuse, clips: kept }, clips), captionShape: style.shape }
      return recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.id === reuse.id ? filled : t)) })
    }
    const grown = addTrack(sq, 'video')
    const target = videoTracks(grown)[videoTracks(grown).length - 1]
    const filled = { ...withClips(target, clips), name: CAPTION_TRACK_NAME, captionShape: style.shape }
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
        // "over this part" and not "the last run": captioning a second clip now
        // keeps the first clip's captions, so the old wording would have claimed
        // it threw away work it did not touch.
        replaced > 0
          ? `${plural(clips.length, 'caption')}, replacing ${replaced} over this part`
          : `${plural(clips.length, 'caption')} added`,
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

/** Is this one of the tracks caption runs write to? */
export const isCaptionTrack = (t: Track): boolean => t.kind === 'video' && t.name === CAPTION_TRACK_NAME

/** Every caption on the Captions track(s), in time order: what the Captions panel lists. */
export function captionsOn(seq: Sequence): { clip: Clip; track: Track }[] {
  return seq.tracks
    .filter(isCaptionTrack)
    .flatMap((track) => track.clips.filter((c) => c.title).map((clip) => ({ clip, track })))
    .sort((a, b) => a.clip.startS - b.clip.startS)
}

/**
 * Trim each new caption so it cannot run into a caption that stays: a caption
 * that bridges to the next word would otherwise reach across into one he did
 * not ask to change. One that ends up with no room left is dropped rather than
 * stacked, because a track never holds two clips at once.
 */
function fitAround(fresh: Clip[], kept: readonly Clip[]): Clip[] {
  const out: Clip[] = []
  for (const clip of fresh) {
    let startS = clip.startS
    let endS = clipEndS(clip)
    for (const k of kept) {
      const ks = k.startS
      const ke = clipEndS(k)
      if (ke <= startS + EPS || ks >= endS - EPS) continue
      if (ks > startS) endS = Math.min(endS, ks)
      else startS = Math.max(startS, ke)
    }
    if (endS - startS <= 1e-3) continue
    out.push(startS === clip.startS && endS === clipEndS(clip) ? clip : { ...clip, startS, inS: 0, outS: endS - startS, speed: 1 })
  }
  return out
}

/**
 * Put a caption style on captions that already exist, in ONE undo step.
 *
 * With `ids`, the titles among them; without, every caption on the Captions
 * track. The look always lands. The LENGTH lands too when it differs from what
 * those captions were cut to: they are cut again from the words on screen
 * (recutCaptions), so every correction he typed survives. Restyling with the
 * same length touches nothing but the look, so a caption he split or merged by
 * hand stays as he left it. A locked track is left alone and said so.
 */
export function applyCaptionStyle(
  style: CaptionStyle,
  ids?: Iterable<string>,
): { styled: number; recut: boolean; locked: number } {
  const idSet = ids ? new Set(ids) : null
  let styled = 0
  let recut = false
  let locked = 0
  const fresh: string[] = []
  updateActiveSequence(`Apply "${style.name}"`, (sq) => {
    let changed = false
    const tracks = sq.tracks.map((t) => {
      const targets = t.clips.filter((c) => c.title && (idSet ? idSet.has(c.id) : isCaptionTrack(t)))
      if (targets.length === 0) return t
      if (t.locked) {
        locked += targets.length
        return t
      }
      changed = true
      styled += targets.length
      const needsCut = isCaptionTrack(t) && !sameShape(t.captionShape ?? AUTO_SHAPE, style.shape)
      if (!needsCut) {
        const by = new Set(targets.map((c) => c.id))
        return { ...t, clips: t.clips.map((c) => (by.has(c.id) ? dressCaption(c, style, sq.width, sq.height) : c)) }
      }
      recut = true
      const by = new Set(targets.map((c) => c.id))
      const kept = t.clips.filter((c) => !by.has(c.id))
      const cut = fitAround(recutCaptions(targets, style, sq), kept)
      fresh.push(...cut.map((c) => c.id))
      const filled = withClips({ ...t, clips: kept }, cut)
      // The track says what its captions are cut to only when all of them are.
      const whole = t.clips.filter((c) => c.title).every((c) => by.has(c.id))
      return whole ? { ...filled, captionShape: style.shape } : filled
    })
    return changed ? recomputeDuration({ ...sq, tracks }) : sq
  })
  // The captions he had selected are gone after a cut; select what took their place.
  if (idSet && fresh.length > 0) useStore.getState().setUI({ selection: fresh })
  return { styled, recut, locked }
}

/**
 * Change what one caption says, from the Captions panel. One undo step per
 * edit, and the timing is untouched. A locked track refuses, out loud.
 */
export function setCaptionText(clipId: string, text: string): boolean {
  const typed = text.trim()
  if (!typed) return false
  const seq = activeSequence(useStore.getState().project)
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!track || !clip?.title) return false
  // The panel edits on one line. A caption that was set on two goes back on
  // two, balanced again around what he typed.
  const next = clip.title.text.includes('\n') && track.captionShape ? breakLines(typed, track.captionShape) : typed
  if (clip.title.text === next) return false
  if (track.locked) {
    useToasts.getState().show('That caption is on a locked track', 'danger')
    return false
  }
  updateActiveSequence('Edit caption', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) =>
      t.id !== track.id
        ? t
        : { ...t, clips: t.clips.map((c) => (c.id === clipId && c.title ? { ...c, title: { ...c.title, text: next } } : c)) },
    ),
  }))
  return true
}
