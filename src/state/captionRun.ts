// Captioning what he points at: one clip, every clip he selected, or the
// voiceover when nothing is selected.
//
// His words, 2026-10-03: *"right-clicking and selecting multiple clips just
// says 'Caption this clip,' and it captions only one."* Two things made that
// true. The Captions window's button captioned the FIRST selected clip and
// ignored the rest. And the right click only offered captions on an AUDIO clip,
// so a selection made on the pictures of linked footage, which is how footage
// with sound arrives, had no caption entry at all.
//
// So a selection is resolved here, once, for every door: each picture brings its
// sound partner, and what is left is asked of `audibleClips`, the same rule the
// sweep itself uses, so the count on the label is the count that gets captioned.
// Two or more go through the whole timeline path with an id filter: one pass,
// one caption track, one undo step, "clip 2 of 3" while it works.

import type { CaptionStyle } from '../engine/captions/captionStyle'
import { clipEndS } from '../engine/timeline'
import { activeSequence, type Sequence } from '../engine/types'
import { useStore } from './store'
import { audibleClips, autoCaptionEveryClip, autoCaptionFromClip, type TranscribeStatus } from './transcribeActions'

/** The ids, plus every clip linked to one of them: a picture's sound comes with it. */
export function withSoundPartners(seq: Sequence, ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const links = new Set<string>()
  for (const t of seq.tracks) for (const c of t.clips) if (out.has(c.id) && c.linkId !== undefined) links.add(c.linkId)
  if (links.size > 0) {
    for (const t of seq.tracks) for (const c of t.clips) if (c.linkId !== undefined && links.has(c.linkId)) out.add(c.id)
  }
  return out
}

/** The clips a caption run on these would actually listen to, in time order. */
export function captionTargets(ids: Iterable<string>): string[] {
  const seq = activeSequence(useStore.getState().project)
  return audibleClips(withSoundPartners(seq, ids)).targets.map((t) => t.clip.id)
}

/** The words on the button: one clip, or how many. */
export const captionLabel = (n: number): string => (n > 1 ? `Caption ${n} clips` : 'Caption this clip')

/** True when this clip's own media has sound, whatever track it sits on. */
function hasSound(clipId: string): boolean {
  const s = useStore.getState()
  const clip = activeSequence(s.project).tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  return !!clip && !clip.title && !!s.project.assets[clip.assetId]?.hasAudio
}

/**
 * Caption these clips: all of them, in one pass and one undo step when there
 * are several, through the single clip door when there is one.
 *
 * A clip the sweep would pass over (a music bed, a locked track) still goes
 * through the single door when it is the only one he pointed at, because that
 * door captions it on purpose and says why. Nothing to hear at all goes to the
 * sweep, which says which reason it was.
 */
export function captionTheseClips(ids: readonly string[], style?: CaptionStyle): Promise<void> {
  const targets = captionTargets(ids)
  if (targets.length >= 2) return autoCaptionEveryClip(style, new Set(targets))
  if (targets.length === 1) return autoCaptionFromClip(targets[0]!, style)
  const seq = activeSequence(useStore.getState().project)
  const sounding = [...withSoundPartners(seq, ids)].filter(hasSound)
  const own = sounding.filter((id) => seq.tracks.some((t) => t.kind === 'audio' && t.clips.some((c) => c.id === id)))
  const pick = own.length === 1 ? own : sounding
  if (pick.length === 1) return autoCaptionFromClip(pick[0]!, style)
  return autoCaptionEveryClip(style, withSoundPartners(seq, ids))
}

/**
 * The voiceover to caption when he has not pointed at anything: the clip
 * under the playhead on a voice track, then the first voice clip, then the first
 * clip with sound that is NOT on a marked music track, and a music clip only as
 * the very last resort, so a timeline whose only sound is that track still
 * captions something.
 */
export function voiceoverClipId(): string | null {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const t = s.ui.playheadS
  const audible = seq.tracks
    .filter((tr) => tr.kind === 'audio' && !tr.locked)
    .flatMap((tr) =>
      tr.clips
        .filter((c) => s.project.assets[c.assetId]?.hasAudio)
        .map((c) => ({ c, voice: tr.audioRole === 'voice', music: tr.audioRole === 'music' })),
    )
  if (audible.length === 0) return null
  const under = audible.find(({ c, voice }) => voice && t >= c.startS && t < clipEndS(c))
  return (under ?? audible.find(({ voice }) => voice) ?? audible.find(({ music }) => !music) ?? audible[0]!).c.id
}

/**
 * What a running caption job is doing right now, in his words. One copy, read
 * by the progress pill and by the Captions tab, so the two never say different
 * things about the same moment.
 *
 * "Downloading (once)" was a lie every time after the first: the model lives in
 * the local cache, and loading it from there still reports progress. And
 * "Listening for words" was said while the app was still deciding whether
 * anybody was talking at all. His words, 2026-08-19: *"I think when it says
 * 'listening for words,' it also listens to video clips. It's kinda weird."*
 * Each step says what it is really doing now.
 */
export function captionJobLabel(status: TranscribeStatus, downloading: boolean): string {
  return status === 'reading'
    ? 'Reading the clip’s audio…'
    : status === 'screening'
      ? 'Checking if anyone is talking…'
      : status === 'model'
        ? downloading
          ? 'Downloading Whisper (first time only)'
          : 'Loading Whisper…'
        : 'Listening for words…'
}

/**
 * How far through the job is, 0 to 1, or null when there is no honest number.
 * A sweep moves one clip at a time, so "clip 2 of 3" is most of the answer; the
 * step inside the clip only nudges it along, and never past the next clip.
 */
export function captionJobProgress(
  status: TranscribeStatus,
  pct: number | null,
  queue: { index: number; total: number } | null,
): number | null {
  const step =
    status === 'reading' ? 0.05 : status === 'screening' ? 0.15 : status === 'model' ? 0.2 + 0.3 * ((pct ?? 0) / 100) : status === 'listening' ? 0.6 : 0
  if (queue && queue.total > 0) return Math.min(1, (queue.index - 1 + step) / queue.total)
  return status === 'model' && pct != null ? step : null
}
