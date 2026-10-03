// Where a kept voice take lands on the timeline, as pure functions of what was
// measured while he recorded it. The recorder (voiceRecorder.ts) does the
// measuring and the dispatch; nothing here touches a clock, the store or a file.
//
// ⛔ HIS ANSWER, 2026-09-30: *"Yes, place it for me."* The question was whether
// a kept take should land on the timeline by itself, right where he started,
// lined up to the frame so his voice matches the picture. Before this a take
// only went to the library, and dropped where he began it his voice sat about
// 135 to 165 ms late against his own edit (MIC-4): the preview starts after the
// recorder does and reaches his ears later still. And every Space pause while
// dubbing pushed the rest of the take another 45 to 62 ms later (MIC-5).
//
// THE MODEL. The recorder never pauses, so file position is wall time: the
// sample delivered at `recorderStartMs + p` sits at p, and it was captured
// `inputLatencyS` earlier. The transport reports every stretch of the timeline
// he heard (engine/playback.ts HeardSpan): timeline T reached his ears at a
// known moment. He speaks in time with what he hears, so the voice for T went
// into the mic at that moment. Each stretch becomes one clip, placed at its own
// timeline spot and cut from its own part of the file, so nothing accumulates:
// a pause costs nothing, and the paused audio simply is not placed.

import { canPlace, addTrack, freeTrackFor, recomputeDuration } from '../engine/timeline'
import { defaultTransform, newId, type Clip, type Id, type MediaAsset, type Sequence } from '../engine/types'

/** One stretch of preview heard during the take. `endedAtMs` null: still going when the take stopped. */
export interface HeardDuringTake {
  timelineS: number
  heardAtMs: number
  endedAtMs: number | null
  /** The sound was rebuilt mid-play: this stretch carries on the one before it (engine/playback.ts). */
  continues?: boolean
  /** 'end': the preview ran off the end of his edit, and he may have kept talking. */
  endedBy?: 'end'
}

/** Everything measured while he recorded, enough to place the take. */
export interface TakeTiming {
  /** performance.now() as MediaRecorder.start() returned. File position 0 was delivered then. */
  recorderStartMs: number
  /** The mic's own capture delay in seconds, as the track reports it (0 when it does not). */
  inputLatencyS: number
  /** Every stretch of the timeline he heard while recording, in order. */
  heard: HeardDuringTake[]
  /** The playhead when he pressed record: where a take with no preview goes. */
  startPlayheadS: number
}

/** One clip to lay down: timeline start, and the part of the take file it plays. */
export interface TakeClipSpan {
  startS: number
  inS: number
  outS: number
}

/** A stretch shorter than this (a Space tapped twice) is not worth a clip. */
export const MIN_TAKE_SPAN_S = 0.02

/**
 * Two stretches of one take that overlap by less than this are one join, not a
 * collision: the clocks behind the numbers disagree by a fraction of a
 * millisecond. Measured in the real app, 0.2 to 1.3 ms, and with no allowance
 * every other stretch of a dub went to a line of its own. Going back over
 * something during a pause overlaps by far more and still gets its own line.
 */
export const TAKE_JOIN_S = 0.005

/**
 * The clips a take becomes. With no preview heard at all (play while recording
 * off, and he never pressed Space) the whole take goes where he started, less
 * the mic's own delay at the head. Otherwise one clip per stretch heard.
 */
export function takeClipSpans(t: TakeTiming, fileDurationS: number): TakeClipSpan[] {
  const latency = Math.max(0, t.inputLatencyS)
  if (t.heard.length === 0) {
    const inS = Math.min(latency, fileDurationS)
    return fileDurationS - inS >= MIN_TAKE_SPAN_S ? [{ startS: Math.max(0, t.startPlayheadS), inS, outS: fileDurationS }] : []
  }
  // Where in the file the sound that entered the mic at `ms` sits.
  const fileAt = (ms: number) => (ms - t.recorderStartMs) / 1000 + latency
  const spans: TakeClipSpan[] = []
  // The clip the stretch just before this one went into, if it made one.
  let previous: TakeClipSpan | null = null
  for (const [k, h] of t.heard.entries()) {
    let inS = fileAt(h.heardAtMs)
    let startS = h.timelineS
    // A preview already rolling when he pressed record: the take begins partway
    // into this stretch, at the timeline spot he was hearing as it began.
    if (inS < 0) {
      startS -= inS
      inS = 0
    }
    let outS = Math.min(fileDurationS, h.endedAtMs === null ? Infinity : fileAt(h.endedAtMs))
    // ⛔ THE PREVIEW RAN OFF THE END OF HIS EDIT AND HE KEPT TALKING (2026-10-01,
    // decided for him: never drop his words from the timeline). The rest of the
    // take runs on right after the end of the edit, on the same line, up to where
    // the next stretch he heard begins, or to the end of the take.
    if (h.endedBy === 'end') {
      const next = t.heard[k + 1]
      outS = Math.min(fileDurationS, next ? fileAt(next.heardAtMs) : Infinity)
    }
    // ⛔ A STRETCH THAT CARRIES ON THE ONE BEFORE IT IS THE SAME CLIP (MIC-4,
    // 2026-10-01). When the sound is rebuilt while play goes on (the first take
    // after opening a project, a resume onto a part not yet played, a clock
    // that starts late, a mix change), the transport opens a new stretch. Placed
    // as a clip of its own it landed on a second line with 80 to 125 ms of his
    // voice twice, or with 84 ms cut out. It extends the clip before it instead:
    // one clip, the file contiguous, mapped the way the rebuilt sound is heard,
    // which the transport keeps on the picture (rescheduleAudio).
    if (h.continues && previous) {
      let mergedStart = previous.startS
      let mergedIn = inS - (startS - previous.startS)
      if (mergedIn < 0) {
        mergedStart -= mergedIn
        mergedIn = 0
      }
      if (outS - mergedIn >= MIN_TAKE_SPAN_S) {
        previous.startS = mergedStart
        previous.inS = mergedIn
        previous.outS = outS
      }
      continue
    }
    if (outS - inS < MIN_TAKE_SPAN_S) {
      previous = null
      continue
    }
    // A hair over the start of the next stretch: end exactly where it begins.
    const prev = spans[spans.length - 1]
    if (prev) {
      const overlap = prev.startS + (prev.outS - prev.inS) - startS
      if (overlap > 0 && overlap <= TAKE_JOIN_S) prev.outS -= overlap
    }
    previous = { startS, inS, outS }
    spans.push(previous)
  }
  return spans
}

/**
 * The line a take starts looking from: his voice line if he has marked one,
 * else the top audio line. A locked line is skipped. -1 when there is none.
 */
export function voiceHomeTrackIndex(seq: Sequence): number {
  const audio = seq.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'audio' && !t.locked)
  return (audio.find(({ t }) => t.audioRole === 'voice') ?? audio[0])?.i ?? -1
}

/**
 * Lay the take's clips down in ONE sequence change, so one undo takes them all
 * back off and leaves the take in the library. Each lands at exactly its time
 * on the home line, or the next free line when something is already there:
 * nothing he has is covered, cut or moved (freeTrackFor, his rule 2026-09-28).
 */
export function placeTakeClips(seq0: Sequence, asset: MediaAsset, spans: readonly TakeClipSpan[]): { seq: Sequence; clipIds: Id[] } {
  if (spans.length === 0) return { seq: seq0, clipIds: [] }
  let seq = seq0
  if (voiceHomeTrackIndex(seq) === -1) seq = addTrack(seq, 'audio')
  const homeId = seq.tracks[voiceHomeTrackIndex(seq)]!.id
  const clipIds: Id[] = []
  for (const span of spans) {
    const durS = span.outS - span.inS
    const home = seq.tracks.findIndex((t) => t.id === homeId)
    const found = freeTrackFor(seq, 'audio', home, span.startS, durS)
    seq = found.seq
    const track = seq.tracks[found.trackIndex]!
    if (!canPlace(track, span.startS, durS)) continue
    const clip: Clip = {
      id: newId(),
      assetId: asset.id,
      startS: span.startS,
      inS: span.inS,
      outS: span.outS,
      speed: 1,
      enabled: true,
      transform: defaultTransform(),
      opacity: 1,
      blendMode: 'normal',
      audioGainDb: 0,
      fadeInS: 0,
      fadeOutS: 0,
      effects: [],
    }
    const clips = [...track.clips, clip].sort((a, b) => a.startS - b.startS)
    seq = { ...seq, tracks: seq.tracks.map((t, i) => (i === found.trackIndex ? { ...t, clips } : t)) }
    clipIds.push(clip.id)
  }
  return { seq: recomputeDuration(seq), clipIds }
}
