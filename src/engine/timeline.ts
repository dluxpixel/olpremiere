// Pure timeline engine: clip math, placement, trim/split/delete, snapping.
// No React, no DOM, no store — only types. Every function takes and returns
// immutable data; when nothing changes the input reference comes back as-is.

import {
  defaultTransform,
  newClipFromAsset,
  newId,
  newTrack,
  type Clip,
  type Id,
  type Marker,
  type MediaAsset,
  type Sequence,
  type Track,
} from './types'

// Float tolerance so clip edges that touch (end == next start) never read as
// overlapping after speed/trim arithmetic.
const EPS = 1e-9

const absSpeed = (clip: Clip): number => Math.abs(clip.speed || 1)

export const clipDurationS = (clip: Clip): number => (clip.outS - clip.inS) / absSpeed(clip)

export const clipEndS = (clip: Clip): number => clip.startS + clipDurationS(clip)

export function sequenceDurationS(seq: Sequence): number {
  let max = 0
  for (const track of seq.tracks) {
    for (const clip of track.clips) max = Math.max(max, clipEndS(clip))
  }
  return max
}

export function recomputeDuration(seq: Sequence): Sequence {
  const durationS = sequenceDurationS(seq)
  return durationS === seq.durationS ? seq : { ...seq, durationS }
}

/**
 * Scale a clip to COVER (fill) a frame of frameW×frameH, cropping the overflow
 * and centering it — the "make it a Short" refit. `transform.scale=1` is the
 * renderer's contain-fit; cover needs scale = cover/contain. Skips titles
 * (frame-relative already) and clips that animate scale/position (don't fight
 * an author's animation). Returns the same clip when nothing changes.
 */
export function refitClipToFill(
  clip: Clip,
  assets: Record<Id, MediaAsset>,
  frameW: number,
  frameH: number,
): Clip {
  if (clip.title) return clip
  if (
    clip.keyframes?.scale?.length ||
    clip.keyframes?.posX?.length ||
    clip.keyframes?.posY?.length
  )
    return clip
  const asset = assets[clip.assetId]
  const sw = asset?.width ?? 0
  const sh = asset?.height ?? 0
  if (sw <= 0 || sh <= 0) return clip
  const contain = Math.min(frameW / sw, frameH / sh)
  if (contain <= 0) return clip
  const scale = Math.max(frameW / sw, frameH / sh) / contain
  const tf = clip.transform
  if (Math.abs(tf.scale - scale) < 1e-6 && tf.x === 0 && tf.y === 0) return clip
  return { ...clip, transform: { ...tf, scale, x: 0, y: 0 } }
}

/**
 * Reformat a sequence to width×height (e.g. 9:16 Shorts). When `refit`, every
 * clip is scaled to fill the new frame. Export follows the sequence dimensions.
 */
export function setSequenceFormat(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  width: number,
  height: number,
  refit = true,
): Sequence {
  if (width <= 0 || height <= 0) return seq
  const sameDims = seq.width === width && seq.height === height
  const tracks = refit
    ? seq.tracks.map((t) => {
        const clips = t.clips.map((c) => refitClipToFill(c, assets, width, height))
        return clips.some((c, i) => c !== t.clips[i]) ? { ...t, clips } : t
      })
    : seq.tracks
  if (sameDims && tracks === seq.tracks) return seq
  return recomputeDuration({ ...seq, width, height, tracks })
}

/**
 * Add a new empty track. Video tracks join the video block (stacking above the
 * existing ones); audio tracks append below the audio block. Named V(n+1)/A(n+1)
 * from the highest existing number so a name never collides.
 */
export function addTrack(seq: Sequence, kind: 'video' | 'audio'): Sequence {
  const prefix = kind === 'video' ? 'V' : 'A'
  let maxN = 0
  for (const t of seq.tracks) {
    if (t.kind !== kind) continue
    const n = Number(t.name.slice(prefix.length))
    if (Number.isFinite(n) && n > maxN) maxN = n
  }
  const track = newTrack(kind, `${prefix}${maxN + 1}`)
  if (kind === 'audio') return { ...seq, tracks: [...seq.tracks, track] }
  // Video: insert just before the first audio track (stays in the video block).
  const firstAudio = seq.tracks.findIndex((t) => t.kind === 'audio')
  if (firstAudio === -1) return { ...seq, tracks: [...seq.tracks, track] }
  const tracks = seq.tracks.slice()
  tracks.splice(firstAudio, 0, track)
  return { ...seq, tracks }
}

export const MIN_SPEED = 0.1
export const MAX_SPEED = 8

/** Clamp a speed to a sane magnitude, preserving sign (negative = reverse). */
export function clampSpeed(s: number): number {
  const mag = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.abs(s) || 1))
  return s < 0 ? -mag : mag
}

/**
 * Change a clip's playback speed (negative = reverse). The clip's linked A/V
 * partner gets the SAME speed so they stay synced. When a clip grows (slows
 * down) the following clips on its track ripple right so nothing overlaps;
 * speeding up simply leaves a gap (predictable, no data loss).
 */
/**
 * Rate stretch (Premiere's R tool as an Alt+edge-drag): move a clip's edge to
 * `tS` by CHANGING ITS SPEED, never its source window. The same source frames
 * play faster (shorter clip) or slower (longer clip); in/out stay put — that is
 * the whole difference from a trim.
 *
 * In place, like a plain trim: the opposite edge is fixed, and the new length
 * clamps against the neighbour on the dragged side, one output frame minimum,
 * and the engine's speed range. A linked A/V group stretches together to the
 * same duration (each member's own source span sets its own speed, so a pair
 * whose spans match stays sample-aligned). Reverse clips keep their direction.
 *
 * Returns the sequence unchanged when there is no room at all rather than
 * producing an overlap.
 */
export function rateStretchGroup(seq: Sequence, clipId: Id, edge: 'in' | 'out', tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const grabbed = found.clip

  const groupIds = new Set<Id>([clipId])
  if (grabbed.linkId !== undefined) {
    for (const t of seq.tracks) for (const c of t.clips) if (c.linkId === grabbed.linkId) groupIds.add(c.id)
  }

  // Desired new duration, from where the grabbed clip's edge was dragged to.
  const desiredDur = edge === 'out' ? tS - grabbed.startS : clipEndS(grabbed) - tS

  // Intersect every member's allowed range: the speed clamp bounds duration via
  // its own source span, and the neighbour on the dragged side bounds it on the
  // member's own track (clips are kept sorted by startS).
  let minDur = 1 / (seq.fps || 30) // never stretch below one output frame
  let maxDur = Infinity
  for (const track of seq.tracks) {
    const i = track.clips.findIndex((c) => groupIds.has(c.id))
    if (i < 0) continue
    const member = track.clips[i]
    const span = member.outS - member.inS
    minDur = Math.max(minDur, span / MAX_SPEED)
    maxDur = Math.min(maxDur, span / MIN_SPEED)
    if (edge === 'out') {
      const next = track.clips[i + 1]
      if (next) maxDur = Math.min(maxDur, next.startS - member.startS)
    } else {
      const prev = track.clips[i - 1]
      maxDur = Math.min(maxDur, clipEndS(member) - (prev ? clipEndS(prev) : 0))
    }
  }
  if (maxDur < minDur) return seq

  const newDur = Math.min(maxDur, Math.max(minDur, desiredDur))
  if (newDur <= 0 || Math.abs(newDur - clipDurationS(grabbed)) < EPS) return seq

  const tracks = seq.tracks.map((track) => {
    if (!track.clips.some((c) => groupIds.has(c.id))) return track
    const clips = track.clips.map((c) => {
      if (!groupIds.has(c.id)) return c
      const span = c.outS - c.inS
      const sign = c.speed < 0 ? -1 : 1
      const speed = sign * (span / newDur)
      // Out-edge: start fixed. In-edge: END fixed, so the start moves.
      const startS = edge === 'out' ? c.startS : clipEndS(c) - newDur
      return { ...c, speed, startS }
    })
    return { ...track, clips }
  })
  return recomputeDuration({ ...seq, tracks })
}

export function setClipSpeed(seq: Sequence, clipId: Id, speed: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const s = clampSpeed(speed)
  if (s === found.clip.speed) return seq

  const groupIds = new Set<Id>([clipId])
  const linkId = found.clip.linkId
  if (linkId !== undefined) {
    for (const t of seq.tracks) for (const c of t.clips) if (c.linkId === linkId) groupIds.add(c.id)
  }

  const tracks = seq.tracks.map((track) => {
    const member = track.clips.find((c) => groupIds.has(c.id))
    if (!member) return track
    const oldEnd = clipEndS(member)
    const newDur = (member.outS - member.inS) / Math.abs(s)
    const delta = member.startS + newDur - oldEnd
    const clips = track.clips.map((c) => {
      if (groupIds.has(c.id)) return { ...c, speed: s }
      // Ripple the tail only when the member grew, to clear the overlap.
      if (delta > EPS && c.startS >= oldEnd - EPS) return { ...c, startS: c.startS + delta }
      return c
    })
    return { ...track, clips }
  })
  return recomputeDuration({ ...seq, tracks })
}

export function findClip(
  seq: Sequence,
  clipId: Id,
): { track: Track; clip: Clip; trackIndex: number; clipIndex: number } | null {
  for (let trackIndex = 0; trackIndex < seq.tracks.length; trackIndex++) {
    const track = seq.tracks[trackIndex]
    const clipIndex = track.clips.findIndex((c) => c.id === clipId)
    if (clipIndex !== -1) return { track, clip: track.clips[clipIndex], trackIndex, clipIndex }
  }
  return null
}

export function canPlace(track: Track, startS: number, durationS: number, ignoreClipId?: Id): boolean {
  const endS = startS + durationS
  for (const c of track.clips) {
    if (c.id === ignoreClipId) continue
    if (startS < clipEndS(c) - EPS && endS > c.startS + EPS) return false
  }
  return true
}

export function resolveStart(
  track: Track,
  desiredStartS: number,
  durationS: number,
  ignoreClipId?: Id,
): number {
  const desired = Math.max(0, desiredStartS)
  const clips = track.clips.filter((c) => c.id !== ignoreClipId)
  if (clips.length === 0) return desired

  let best = 0
  let bestDist = Infinity
  let gapStart = 0
  // Clips are sorted by startS; walk every gap plus the open end after the
  // last clip. Earlier candidates win exact ties (strict < below).
  for (let i = 0; i <= clips.length; i++) {
    const gapEnd = i < clips.length ? clips[i].startS : Infinity
    if (gapEnd - gapStart >= durationS - EPS) {
      const hi = gapEnd === Infinity ? Infinity : gapEnd - durationS
      const candidate = Math.min(Math.max(desired, gapStart), hi)
      const dist = Math.abs(candidate - desired)
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
    if (i < clips.length) gapStart = Math.max(gapStart, clipEndS(clips[i]))
  }
  return best
}

const insertSorted = (clips: Clip[], clip: Clip): Clip[] => {
  const idx = clips.findIndex((c) => c.startS > clip.startS)
  return idx === -1 ? [...clips, clip] : [...clips.slice(0, idx), clip, ...clips.slice(idx)]
}

const withTrackClips = (seq: Sequence, trackIndex: number, clips: Clip[]): Sequence =>
  recomputeDuration({
    ...seq,
    tracks: seq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips } : t)),
  })

export function addClipFromAsset(
  seq: Sequence,
  trackId: Id,
  asset: MediaAsset,
  desiredStartS: number,
): { seq: Sequence; clipId: Id } {
  const trackIndex = seq.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return { seq, clipId: '' }
  const track = seq.tracks[trackIndex]
  const wantKind = asset.kind === 'audio' ? 'audio' : 'video'
  if (track.kind !== wantKind || track.locked) return { seq, clipId: '' }

  const outS = asset.durationS || 5 // images have durationS 0 → default 5s
  const clip: Clip = {
    id: newId(),
    assetId: asset.id,
    startS: resolveStart(track, desiredStartS, outS),
    inS: 0,
    outS,
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
  return { seq: withTrackClips(seq, trackIndex, insertSorted(track.clips, clip)), clipId: clip.id }
}

export function moveClip(seq: Sequence, clipId: Id, targetTrackId: Id, desiredStartS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const targetIndex = seq.tracks.findIndex((t) => t.id === targetTrackId)
  if (targetIndex === -1) return seq
  const target = seq.tracks[targetIndex]
  if (found.track.kind !== target.kind || found.track.locked || target.locked) return seq

  const startS = resolveStart(target, desiredStartS, clipDurationS(found.clip), clipId)
  if (found.trackIndex === targetIndex && startS === found.clip.startS) return seq

  const moved: Clip = { ...found.clip, startS }
  const tracks = seq.tracks.map((t, i) => {
    const without = i === found.trackIndex ? t.clips.filter((c) => c.id !== clipId) : t.clips
    const clips = i === targetIndex ? insertSorted(without, moved) : without
    return clips === t.clips ? t : { ...t, clips }
  })
  return recomputeDuration({ ...seq, tracks })
}

export function trimClipTo(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { track, clip, trackIndex, clipIndex } = found
  const sp = absSpeed(clip)
  const minDurS = 1 / seq.fps
  const endS = clipEndS(clip)
  const asset = assets[clip.assetId] as MediaAsset | undefined
  // Missing assets get image semantics (no source bounds) rather than a throw.
  const boundless = !asset || asset.kind === 'image'

  let next: Clip
  if (edge === 'in') {
    const prev = track.clips[clipIndex - 1] as Clip | undefined
    let lo = Math.max(0, prev ? clipEndS(prev) : 0)
    if (!boundless) lo = Math.max(lo, clip.startS - clip.inS / sp)
    const startS = Math.min(endS - minDurS, Math.max(lo, tS))
    if (startS === clip.startS) return seq
    const inS = clip.inS + (startS - clip.startS) * sp
    next =
      inS >= 0
        ? { ...clip, startS, inS }
        : // Image extended left past source zero: floor inS, grow outS so the
          // out edge stays fixed at endS.
          { ...clip, startS, inS: 0, outS: (endS - startS) * sp }
  } else {
    const nextClip = track.clips[clipIndex + 1] as Clip | undefined
    let hi = nextClip ? nextClip.startS : Infinity
    if (!boundless) hi = Math.min(hi, clip.startS + (asset.durationS - clip.inS) / sp)
    const newEndS = Math.min(hi, Math.max(clip.startS + minDurS, tS))
    if (newEndS === endS) return seq
    next = { ...clip, outS: clip.inS + (newEndS - clip.startS) * sp }
  }

  return withTrackClips(
    seq,
    trackIndex,
    track.clips.map((c, i) => (i === clipIndex ? next : c)),
  )
}

export function splitClip(seq: Sequence, clipId: Id, tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { track, clip, trackIndex, clipIndex } = found
  if (tS <= clip.startS || tS >= clipEndS(clip)) return seq

  const cutSource = clip.inS + (tS - clip.startS) * absSpeed(clip)
  const left: Clip = { ...clip, outS: cutSource, transitionOut: undefined }
  const right: Clip = {
    ...clip,
    id: newId(),
    startS: tS,
    inS: cutSource,
    transform: { ...clip.transform, crop: { ...clip.transform.crop } },
    effects: clip.effects.map((e) => ({ ...e, id: newId(), params: { ...e.params } })),
    transitionIn: undefined,
  }
  const clips = [...track.clips.slice(0, clipIndex), left, right, ...track.clips.slice(clipIndex + 1)]
  return withTrackClips(seq, trackIndex, clips)
}

export function deleteClip(seq: Sequence, clipId: Id): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  return withTrackClips(
    seq,
    found.trackIndex,
    found.track.clips.filter((c) => c.id !== clipId),
  )
}

export function rippleDelete(seq: Sequence, clipId: Id): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const removedS = clipDurationS(found.clip)
  const clips = found.track.clips
    .filter((c) => c.id !== clipId)
    .map((c, i) => (i >= found.clipIndex ? { ...c, startS: c.startS - removedS } : c))
  return withTrackClips(seq, found.trackIndex, clips)
}

export function snapTime(
  tS: number,
  points: number[],
  thresholdS: number,
): { t: number; snapped: boolean } {
  let best = tS
  let bestDist = Infinity
  for (const p of points) {
    const dist = Math.abs(p - tS)
    // Strict < keeps the earliest point on an exact tie.
    if (dist < bestDist) {
      bestDist = dist
      best = p
    }
  }
  return bestDist <= thresholdS ? { t: best, snapped: true } : { t: tS, snapped: false }
}

/**
 * Every edge a drag can magnet to: clip starts/ends on EVERY lane (video and
 * audio alike — cross-track alignment is the point), markers, t=0, and the
 * playhead.
 *
 * `excludeClipIds` must be the dragged clip's whole LINK GROUP, not just the
 * grabbed clip. A linked A/V pair otherwise leaves its partner's stale edges in
 * the set, and the drag magnetizes back to its own origin instead of to its
 * neighbours — which reads as "snapping doesn't work across lanes".
 */
export function collectSnapPoints(
  seq: Sequence,
  opts?: { excludeClipIds?: readonly Id[]; playheadS?: number },
): number[] {
  const excluded = new Set(opts?.excludeClipIds ?? [])
  const points = new Set<number>([0])
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      if (excluded.has(clip.id)) continue
      points.add(clip.startS)
      points.add(clipEndS(clip))
    }
  }
  for (const m of seq.markers) points.add(m.t)
  if (opts?.playheadS !== undefined) points.add(opts.playheadS)
  return [...points].sort((a, b) => a - b)
}

export const timeToPx = (tS: number, pxPerS: number): number => tS * pxPerS

export const pxToTime = (px: number, pxPerS: number): number => px / pxPerS

// ---------------------------------------------------------------------------
// Linked A/V groups (Vegas-style). Clips sharing a linkId move/trim/split/
// delete together. A linked video clip is video-only; its audio-track partner
// carries the sound (see clipEmitsAudio in engine/audio.ts).

/** All clip ids sharing clipId's link group (just [clipId] when unlinked). */
export function clipGroupIds(seq: Sequence, clipId: Id): Id[] {
  const found = findClip(seq, clipId)
  if (!found) return []
  const link = found.clip.linkId
  if (!link) return [clipId]
  const ids: Id[] = []
  for (const track of seq.tracks) for (const c of track.clips) if (c.linkId === link) ids.push(c.id)
  return ids
}

/**
 * Add a video asset AND split its audio to a linked clip on an audio track.
 * The video clip (video-only, linked) lands on videoTrackId; the audio clip
 * (same asset, linked) lands on audioTrackId at the same start. Falls back to
 * a standalone video clip (its own audio) when no audio track is available.
 */
export function addClipWithLinkedAudio(
  seq: Sequence,
  videoTrackId: Id,
  audioTrackId: Id | null,
  asset: MediaAsset,
  desiredStartS: number,
): { seq: Sequence; videoClipId: Id; audioClipId: Id } {
  const vIndex = seq.tracks.findIndex((t) => t.id === videoTrackId)
  if (vIndex === -1) return { seq, videoClipId: '', audioClipId: '' }
  const vTrack = seq.tracks[vIndex]
  if (vTrack.kind !== 'video' || vTrack.locked) return { seq, videoClipId: '', audioClipId: '' }

  const aIndex = audioTrackId ? seq.tracks.findIndex((t) => t.id === audioTrackId) : -1
  const aTrack = aIndex === -1 ? null : seq.tracks[aIndex]
  const canLink = !!aTrack && aTrack.kind === 'audio' && !aTrack.locked

  const dur = clipDurationS(newClipFromAsset(asset, 0))
  // Place at a start free on BOTH tracks so the pair stays aligned.
  const obstacles: Track = {
    ...vTrack,
    clips: [...vTrack.clips, ...(canLink ? aTrack!.clips : [])],
  }
  const startS = resolveStart(obstacles, desiredStartS, dur)

  if (!canLink) {
    // No audio track — standalone video clip keeps its own audio (no linkId).
    const clip = { ...newClipFromAsset(asset, startS) }
    return {
      seq: withTrackClips(seq, vIndex, insertSorted(vTrack.clips, clip)),
      videoClipId: clip.id,
      audioClipId: '',
    }
  }

  const linkId = newId()
  const videoClip: Clip = { ...newClipFromAsset(asset, startS), linkId }
  const audioClip: Clip = { ...newClipFromAsset(asset, startS), linkId }
  const tracks = seq.tracks.map((t, i) => {
    if (i === vIndex) return { ...t, clips: insertSorted(t.clips, videoClip) }
    if (i === aIndex) return { ...t, clips: insertSorted(t.clips, audioClip) }
    return t
  })
  return {
    seq: recomputeDuration({ ...seq, tracks }),
    videoClipId: videoClip.id,
    audioClipId: audioClip.id,
  }
}

/** Move a clip and shift every linked group member by the same time delta. */
export function moveGroup(seq: Sequence, clipId: Id, targetTrackId: Id, desiredStartS: number): Sequence {
  const group = clipGroupIds(seq, clipId)
  if (group.length <= 1) return moveClip(seq, clipId, targetTrackId, desiredStartS)
  const before = findClip(seq, clipId)
  if (!before) return seq
  let next = moveClip(seq, clipId, targetTrackId, desiredStartS)
  const after = findClip(next, clipId)
  if (!after) return next
  const delta = after.clip.startS - before.clip.startS
  if (delta === 0) return next
  for (const id of group) {
    if (id === clipId) continue
    const m = findClip(next, id)
    if (!m) continue
    next = moveClip(next, id, m.track.id, m.clip.startS + delta)
  }
  return next
}

/** Trim a clip's edge and apply the same absolute edge to every linked member. */
export function trimGroup(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
): Sequence {
  let next = seq
  for (const id of clipGroupIds(seq, clipId)) next = trimClipTo(next, assets, id, edge, tS)
  return next
}

export function rippleTrimGroup(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
): Sequence {
  let next = seq
  for (const id of clipGroupIds(seq, clipId)) next = rippleTrimTo(next, assets, id, edge, tS)
  return next
}

export function deleteGroup(seq: Sequence, clipId: Id): Sequence {
  let next = seq
  for (const id of clipGroupIds(seq, clipId)) next = deleteClip(next, id)
  return next
}

export function rippleDeleteGroup(seq: Sequence, clipId: Id): Sequence {
  let next = seq
  for (const id of clipGroupIds(seq, clipId)) next = rippleDelete(next, id)
  return next
}

/** Split every linked member at tS; the right halves form a fresh link group. */
export function splitGroup(seq: Sequence, clipId: Id, tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const link = found.clip.linkId
  if (!link) return splitClip(seq, clipId, tS)
  const groupBefore = new Set(clipGroupIds(seq, clipId))
  let next = seq
  for (const id of groupBefore) next = splitClip(next, id, tS)
  // splitClip copies linkId onto both halves; the left halves keep the original
  // ids (in groupBefore). Re-link the right halves (same link, new ids) so the
  // two sides are independent groups.
  const newLink = newId()
  return {
    ...next,
    tracks: next.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((c) =>
        c.linkId === link && !groupBefore.has(c.id) ? { ...c, linkId: newLink } : c,
      ),
    })),
  }
}

// ---------------------------------------------------------------------------
// Phase 3: ripple/roll/slip/slide, markers, clipboard ops

// Coarser than EPS: adjacency and marker-dedup checks compare user-visible
// times that have been through px→time round-trips.
const ADJ_EPS = 1e-6

const DEFAULT_MARKER_COLOR = '#6f6bff'

export function rippleTrimTo(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { track, clip, trackIndex, clipIndex } = found
  const sp = absSpeed(clip)
  const minDurS = 1 / seq.fps
  const endS = clipEndS(clip)
  const asset = assets[clip.assetId] as MediaAsset | undefined
  const boundless = !asset || asset.kind === 'image'

  let next: Clip
  let deltaS: number
  if (edge === 'out') {
    // No next-neighbor clamp: every later clip shifts by the same delta, so
    // relative gaps are preserved and overlap is impossible.
    let hi = Infinity
    if (!boundless) hi = clip.startS + (asset.durationS - clip.inS) / sp
    const newEndS = Math.min(hi, Math.max(clip.startS + minDurS, tS))
    if (newEndS === endS) return seq
    deltaS = newEndS - endS
    next = { ...clip, outS: clip.inS + (newEndS - clip.startS) * sp }
  } else {
    // Ripple-in keeps startS fixed — content slides under the head — so the
    // previous clip never constrains it: only the source head + min duration.
    const lo = boundless ? -Infinity : clip.startS - clip.inS / sp
    const t = Math.min(endS - minDurS, Math.max(lo, tS))
    if (t === clip.startS) return seq
    deltaS = clip.startS - t
    const inS = clip.inS + (t - clip.startS) * sp
    next =
      inS >= 0
        ? { ...clip, inS }
        : // Image grown past source zero: floor inS, widen outS to keep the
          // implied duration delta.
          { ...clip, inS: 0, outS: (clipDurationS(clip) + deltaS) * sp }
  }

  const clips = track.clips.map((c, i) =>
    i === clipIndex ? next : i > clipIndex ? { ...c, startS: c.startS + deltaS } : c,
  )
  return withTrackClips(seq, trackIndex, clips)
}

export function rollEditTo(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  leftClipId: Id,
  rightClipId: Id,
  tS: number,
): Sequence {
  const left = findClip(seq, leftClipId)
  const right = findClip(seq, rightClipId)
  if (!left || !right || left.trackIndex !== right.trackIndex) return seq
  if (Math.abs(clipEndS(left.clip) - right.clip.startS) >= ADJ_EPS) return seq

  const spL = absSpeed(left.clip)
  const spR = absSpeed(right.clip)
  const minDurS = 1 / seq.fps
  const rightEndS = clipEndS(right.clip)
  const assetL = assets[left.clip.assetId] as MediaAsset | undefined
  const assetR = assets[right.clip.assetId] as MediaAsset | undefined
  const boundlessL = !assetL || assetL.kind === 'image'
  const boundlessR = !assetR || assetR.kind === 'image'

  let lo = left.clip.startS + minDurS
  if (!boundlessR) lo = Math.max(lo, right.clip.startS - right.clip.inS / spR)
  let hi = rightEndS - minDurS
  if (!boundlessL) hi = Math.min(hi, left.clip.startS + (assetL.durationS - left.clip.inS) / spL)
  const t = Math.min(hi, Math.max(lo, tS))

  const newLeftOutS = left.clip.inS + (t - left.clip.startS) * spL
  if (newLeftOutS === left.clip.outS && t === right.clip.startS) return seq

  const newLeft: Clip = { ...left.clip, outS: newLeftOutS }
  const rInS = right.clip.inS + (t - right.clip.startS) * spR
  const newRight: Clip =
    rInS >= 0
      ? { ...right.clip, startS: t, inS: rInS }
      : // Right image pulled left past source zero: floor inS, keep its end
        // fixed by widening outS.
        { ...right.clip, startS: t, inS: 0, outS: (rightEndS - t) * spR }

  const clips = right.track.clips.map((c) =>
    c.id === leftClipId ? newLeft : c.id === rightClipId ? newRight : c,
  )
  return withTrackClips(seq, right.trackIndex, clips)
}

export function slipClip(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  deltaS: number,
): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { clip } = found
  const asset = assets[clip.assetId] as MediaAsset | undefined
  // Slipping a still (or an asset we can't see) is meaningless.
  if (!asset || asset.kind === 'image') return seq
  const sp = absSpeed(clip)
  const d = Math.min(Math.max(deltaS * sp, -clip.inS), asset.durationS - clip.outS)
  if (d === 0) return seq
  return withTrackClips(
    seq,
    found.trackIndex,
    found.track.clips.map((c, i) =>
      i === found.clipIndex ? { ...c, inS: c.inS + d, outS: c.outS + d } : c,
    ),
  )
}

export function slideClip(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  tS: number,
): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { track, clip, trackIndex, clipIndex } = found
  const prev = track.clips[clipIndex - 1] as Clip | undefined
  const nextClip = track.clips[clipIndex + 1] as Clip | undefined
  if (!prev || !nextClip) return seq
  if (Math.abs(clipEndS(prev) - clip.startS) >= ADJ_EPS) return seq
  if (Math.abs(clipEndS(clip) - nextClip.startS) >= ADJ_EPS) return seq

  const durS = clipDurationS(clip)
  const minDurS = 1 / seq.fps
  const spP = absSpeed(prev)
  const spN = absSpeed(nextClip)
  const nextEndS = clipEndS(nextClip)
  const assetP = assets[prev.assetId] as MediaAsset | undefined
  const assetN = assets[nextClip.assetId] as MediaAsset | undefined
  const boundlessP = !assetP || assetP.kind === 'image'
  const boundlessN = !assetN || assetN.kind === 'image'

  let lo = prev.startS + minDurS
  if (!boundlessN) lo = Math.max(lo, nextClip.startS - nextClip.inS / spN - durS)
  let hi = nextEndS - minDurS - durS
  if (!boundlessP) hi = Math.min(hi, prev.startS + (assetP.durationS - prev.inS) / spP)
  const t = Math.min(hi, Math.max(lo, tS))
  if (t === clip.startS) return seq

  const newPrev: Clip = { ...prev, outS: prev.inS + (t - prev.startS) * spP }
  const newStartN = t + durS
  const nInS = nextClip.inS + (newStartN - nextClip.startS) * spN
  const newNext: Clip =
    nInS >= 0
      ? { ...nextClip, startS: newStartN, inS: nInS }
      : // Image next pulled left past source zero: floor inS, keep its end
        // fixed by widening outS.
        { ...nextClip, startS: newStartN, inS: 0, outS: (nextEndS - newStartN) * spN }

  const clips = track.clips.map((c, i) =>
    i === clipIndex - 1
      ? newPrev
      : i === clipIndex
        ? { ...clip, startS: t }
        : i === clipIndex + 1
          ? newNext
          : c,
  )
  return withTrackClips(seq, trackIndex, clips)
}

// ---------------------------------------------------------------------------
// Markers

export function addMarker(
  seq: Sequence,
  tS: number,
  label = '',
  color = DEFAULT_MARKER_COLOR,
): { seq: Sequence; markerId: Id } {
  const t = Math.max(0, tS)
  // Duplicates are allowed except at the exact same frame time.
  const existing = seq.markers.find((m) => Math.abs(m.t - t) < ADJ_EPS)
  if (existing) return { seq, markerId: existing.id }
  const marker: Marker = { id: newId(), t, label, color }
  const idx = seq.markers.findIndex((m) => m.t > t)
  const markers =
    idx === -1
      ? [...seq.markers, marker]
      : [...seq.markers.slice(0, idx), marker, ...seq.markers.slice(idx)]
  return { seq: { ...seq, markers }, markerId: marker.id }
}

export function removeMarker(seq: Sequence, markerId: Id): Sequence {
  const markers = seq.markers.filter((m) => m.id !== markerId)
  return markers.length === seq.markers.length ? seq : { ...seq, markers }
}

export function removeMarkerNear(seq: Sequence, tS: number, toleranceS: number): Sequence {
  let best: Marker | undefined
  let bestDist = Infinity
  for (const m of seq.markers) {
    const dist = Math.abs(m.t - tS)
    // Strict < keeps the earliest marker on an exact tie.
    if (dist < bestDist) {
      bestDist = dist
      best = m
    }
  }
  return best && bestDist <= toleranceS ? removeMarker(seq, best.id) : seq
}

export function moveMarker(seq: Sequence, markerId: Id, tS: number): Sequence {
  const idx = seq.markers.findIndex((m) => m.id === markerId)
  if (idx === -1) return seq
  const t = Math.max(0, tS)
  if (t === seq.markers[idx].t) return seq
  const markers = seq.markers
    .map((m, i) => (i === idx ? { ...m, t } : m))
    .sort((a, b) => a.t - b.t)
  return { ...seq, markers }
}

// ---------------------------------------------------------------------------
// Clipboard: serialize / paste / duplicate

export interface ClipPayload {
  assetId: Id
  trackKind: 'video' | 'audio'
  /** Index of the clip's track among same-kind tracks (V1=0, V2=1 / A1=0…). */
  trackOffset: number
  /** Start relative to the earliest selected clip. */
  offsetS: number
  clip: Omit<Clip, 'id' | 'startS'>
}

const clipPayloadBody = (clip: Clip): Omit<Clip, 'id' | 'startS'> => {
  const body = structuredClone(clip) as Partial<Clip>
  delete body.id
  delete body.startS
  return body as Omit<Clip, 'id' | 'startS'>
}

export function serializeClips(seq: Sequence, clipIds: Id[]): ClipPayload[] {
  const found: { clip: Clip; track: Track; trackIndex: number }[] = []
  for (const id of clipIds) {
    const f = findClip(seq, id)
    if (f) found.push(f)
  }
  if (found.length === 0) return []
  const earliest = Math.min(...found.map((f) => f.clip.startS))
  return found.map(({ clip, track, trackIndex }) => {
    let trackOffset = 0
    for (let i = 0; i < trackIndex; i++) if (seq.tracks[i].kind === track.kind) trackOffset++
    return {
      assetId: clip.assetId,
      trackKind: track.kind,
      trackOffset,
      offsetS: clip.startS - earliest,
      clip: clipPayloadBody(clip),
    }
  })
}

export function pasteClips(
  seq: Sequence,
  payload: ClipPayload[],
  atS: number,
): { seq: Sequence; newIds: Id[] } {
  const kindIdx: Record<'video' | 'audio', number[]> = { video: [], audio: [] }
  seq.tracks.forEach((t, i) => kindIdx[t.kind].push(i))

  const newIds: Id[] = []
  // Remap link groups to FRESH ids: clips linked in the payload stay linked to
  // each other, but never to the source clips (which would merge groups).
  const linkRemap = new Map<Id, Id>()
  let tracks = seq.tracks
  for (const item of payload) {
    const sameKind = kindIdx[item.trackKind]
    if (sameKind.length === 0) continue
    const ti = sameKind[Math.min(Math.max(0, item.trackOffset), sameKind.length - 1)]
    const track = tracks[ti]
    if (track.locked) continue
    // Clone so the payload stays reusable; fresh clip + effect-instance ids.
    const body = structuredClone(item.clip)
    const durS = (body.outS - body.inS) / Math.abs(body.speed || 1)
    let linkId = body.linkId
    if (linkId) {
      const mapped = linkRemap.get(linkId) ?? newId()
      linkRemap.set(linkId, mapped)
      linkId = mapped
    }
    const clip: Clip = {
      ...body,
      id: newId(),
      startS: resolveStart(track, atS + item.offsetS, durS),
      effects: body.effects.map((e) => ({ ...e, id: newId() })),
      linkId,
    }
    tracks = tracks.map((t, i) => (i === ti ? { ...t, clips: insertSorted(t.clips, clip) } : t))
    newIds.push(clip.id)
  }
  if (newIds.length === 0) return { seq, newIds }
  return { seq: recomputeDuration({ ...seq, tracks }), newIds }
}

export function duplicateClips(seq: Sequence, clipIds: Id[]): { seq: Sequence; newIds: Id[] } {
  const payload = serializeClips(seq, clipIds)
  if (payload.length === 0) return { seq, newIds: [] }
  let atS = 0
  for (const id of clipIds) {
    const f = findClip(seq, id)
    if (f) atS = Math.max(atS, clipEndS(f.clip))
  }
  return pasteClips(seq, payload, atS)
}
