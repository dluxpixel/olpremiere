// Cutting by the words. The transcript is the timeline read out loud: every
// spoken word knows where it sits, so deleting words is deleting time.
//
// Premiere's text based editing, which editors called "a game changer" in the
// community research of 2026-09-15 (vault projects/ol-premiere/
// ol-premiere-what-editors-love-in-premiere-and-vegas.md). The words come from
// the listening this app already does for captions; here they are kept on the
// media in SOURCE seconds (MediaAsset.words), and each clip lays its own slice
// onto the timeline through its in point and speed. Pure: no store, no DOM.

import { clipEmitsAudioOn } from './audio'
import { correctWordLag } from './captions/wordTiming'
import { findClip, recomputeDuration, splitClipOnly, splitGroup } from './timeline'
import { clipEndS, type Clip, type Id, type MediaAsset, type Sequence, type SpokenWord } from './types'

const EPS = 1e-6

export interface TimelineWord extends SpokenWord {
  /** Where the word plays on the timeline. */
  atS: number
  endAtS: number
  clipId: Id
}

export interface ClipWords {
  clip: Clip
  asset: MediaAsset
  /** Empty when the media has not been listened to yet, or says nothing here. */
  words: TimelineWord[]
}

/**
 * Source time to timeline time for `clip`, the same line captions use. A
 * reversed clip walks its source BACKWARDS from outS (timeline.ts,
 * rescaleKeyframesForSpeed), so its words come out in the order they play.
 */
export const toTimeline = (clip: Clip, sourceS: number): number => {
  const rate = Math.abs(clip.speed) || 1
  return clip.speed < 0 ? clip.startS + (clip.outS - sourceS) / rate : clip.startS + (sourceS - clip.inS) / rate
}

/** Timeline time to source time for `clip`, the inverse of toTimeline. */
export const toSource = (clip: Clip, timelineS: number): number => {
  const rate = Math.abs(clip.speed) || 1
  return clip.speed < 0 ? clip.outS - (timelineS - clip.startS) * rate : clip.inS + (timelineS - clip.startS) * rate
}

/**
 * Every clip that plays sound, in timeline order, with the words it says. A
 * clip on a muted or locked track, or one that is disabled, still lists: the
 * panel is for reading the edit, not only the part that is audible right now.
 */
export function wordsOnTimeline(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  /** The recogniser's lag, taken off words kept before they were stored on time. */
  legacyLagS = 0,
): ClipWords[] {
  const out: ClipWords[] = []
  const said = new Map<Id, readonly SpokenWord[]>()
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      if (!clipEmitsAudioOn(track.kind, clip)) continue
      const asset = assets[clip.assetId]
      if (!asset?.hasAudio) continue
      if (!said.has(asset.id)) said.set(asset.id, wordsAsSaid(asset, legacyLagS))
      const words: TimelineWord[] = []
      for (const w of said.get(asset.id)!) {
        // A word that starts inside the clip's source span is a word this clip says.
        if (w.startS < clip.inS - EPS || w.startS >= clip.outS - EPS) continue
        const a = toTimeline(clip, w.startS)
        const b = toTimeline(clip, w.endS)
        // Reversed, the word's end plays before its start; the span is still the span.
        words.push({ ...w, atS: Math.min(a, b), endAtS: Math.max(a, b), clipId: clip.id })
      }
      words.sort((x, y) => x.atS - y.atS)
      out.push({ clip, asset, words })
    }
  }
  return out.sort((a, b) => a.clip.startS - b.clip.startS)
}

/**
 * The media's words where he said them. Words kept before the lag was taken
 * off (no `wordsOnVoice` mark) are shifted earlier by it here, once, so a cut
 * starts on the word and not a fifth of a second into it.
 */
export function wordsAsSaid(asset: MediaAsset, legacyLagS: number): SpokenWord[] {
  const words = asset.words ?? []
  return asset.wordsOnVoice || !(legacyLagS > 0) ? [...words] : correctWordLag(words, legacyLagS)
}

/**
 * The media with a fresh listening kept on it: what was heard over [fromS, toS)
 * replaces what was there, the rest stays, and old unmarked words are put on
 * time first so the whole list is on one clock.
 */
export function keepHeardWords(asset: MediaAsset, heard: readonly SpokenWord[], fromS: number, toS: number, legacyLagS: number): MediaAsset {
  return { ...asset, words: mergeWords(wordsAsSaid(asset, legacyLagS), heard, fromS, toS), wordsOnVoice: true }
}

/**
 * Fold a fresh listening into what the media already knows. `heard` is in
 * source seconds and covers exactly [fromS, toS): anything the media had inside
 * that span is replaced, anything outside it is kept, and the result stays
 * sorted. Listening to the same clip twice therefore never doubles its words.
 */
export function mergeWords(existing: readonly SpokenWord[] | undefined, heard: readonly SpokenWord[], fromS: number, toS: number): SpokenWord[] {
  const kept = (existing ?? []).filter((w) => w.startS < fromS - EPS || w.startS >= toS - EPS)
  return [...kept, ...heard.map((w) => ({ text: w.text, startS: w.startS, endS: w.endS }))].sort((a, b) => a.startS - b.startS)
}

/**
 * The word under the playhead, so the Words tab follows playback, or -1 when he
 * is between words. A word stays current a moment past its end, so the mark
 * does not blink off in the gap between two words.
 *
 * Read by a store selector, so it runs on every store write, playback frames
 * included; its answer changes a few times a second, and only then does the
 * tab draw again.
 */
export function wordIndexAt(words: readonly TimelineWord[], t: number): number {
  let found = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i].atS <= t + 1e-6) found = i
    else break
  }
  return found >= 0 && t < words[found].endAtS + 0.35 ? found : -1
}

/**
 * The stretch of timeline a run of selected words occupies, on frame edges.
 * It runs from the first word's start to the start of the word that follows
 * the last one in the same clip, so the pause before the next word goes with
 * the words that came before it and the next word keeps its own attack. At the
 * end of a clip's words it stops at the last word's end.
 */
export function wordSpan(words: readonly TimelineWord[], from: number, to: number, fps: number): { startS: number; endS: number } | null {
  if (words.length === 0) return null
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(words.length - 1, Math.max(from, to))
  const first = words[lo]
  const last = words[hi]
  const next = words[hi + 1]
  const endS = next && next.clipId === last.clipId ? next.atS : last.endAtS
  // Both edges FLOOR to the frame: a start rounded up would leave the first
  // word's opening frame on the timeline and the word itself in the panel, and
  // an end rounded up would take the next word's attack with it.
  const floorToFrame = (t: number): number => Math.floor(t * fps + 1e-6) / fps
  const startS = floorToFrame(first.atS)
  const end = Math.max(startS + 1 / fps, floorToFrame(endS))
  return { startS, endS: end }
}

const spans = (clip: Clip, tS: number): boolean => clip.startS < tS - EPS && clipEndS(clip) > tS + EPS

/**
 * Take [startS, endS) out of the timeline and close the gap on every unlocked
 * track: cut at both ends, drop whatever lies wholly inside, and move everything
 * after it up by the time removed. The same seconds leave every track, which is
 * what keeps the tracks in step; a per clip ripple would move a track with a
 * gap in the range by less than its neighbours. Locked tracks are left alone,
 * as every other edit leaves them.
 */
export function cutRange(seq: Sequence, startS: number, endS: number): Sequence {
  if (!(endS > startS + EPS)) return seq
  let next = seq
  for (const tS of [startS, endS]) {
    // Ids are read fresh each time: splitting a linked pair through one member
    // cuts its partner too, and that partner must not be split a second time.
    const ids = next.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.filter((c) => spans(c, tS)).map((c) => c.id))
    for (const id of ids) {
      const f = findClip(next, id)
      if (!f || !spans(f.clip, tS)) continue
      // A locked track is untouchable, partner or not: a linked half on a
      // locked track stays whole and only the unlocked half is cut.
      const partnerLocked = next.tracks.some(
        (t) => t.locked && f.clip.linkId !== undefined && t.clips.some((c) => c.linkId === f.clip.linkId),
      )
      next = partnerLocked ? splitClipOnly(next, id, tS) : splitGroup(next, id, tS)
    }
  }
  const removedS = endS - startS
  const tracks = next.tracks.map((t) => {
    if (t.locked) return t
    const clips = t.clips
      .filter((c) => !(c.startS >= startS - EPS && clipEndS(c) <= endS + EPS))
      .map((c) => (c.startS >= endS - EPS ? { ...c, startS: c.startS - removedS } : c))
    return { ...t, clips }
  })
  return recomputeDuration({ ...next, tracks })
}
