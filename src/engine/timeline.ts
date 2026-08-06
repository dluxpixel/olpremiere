// Pure timeline engine: clip math, placement, trim/split/delete, snapping.
// No React, no DOM, no store: only types. Every function takes and returns
// immutable data; when nothing changes the input reference comes back as-is.

import { refitAppearanceToFrame, retimeAppearance, splitAppearanceAcrossCut } from './anim/appearance'
import { withChannelKeyframes, withChannelValue } from './effects/channels'
import { evalChannel } from './keyframes'
import {
  clipDurationS,
  clipEndS,
  defaultTransform,
  newClipFromAsset,
  newId,
  newTrack,
  scaleTitleDef,
  type AnimChannel,
  type Clip,
  type Id,
  type Keyframe,
  type Keyframeable,
  type Marker,
  type MediaAsset,
  type Sequence,
  type Track,
} from './types'

// The duration math itself lives in ./types (so engine/anim can share it without
// importing this module back); it is re-exported here because every caller in the
// app addresses it as part of the timeline engine.
export { clipDurationS, clipEndS }

// Float tolerance so clip edges that touch (end == next start) never read as
// overlapping after speed/trim arithmetic.
const EPS = 1e-9

const absSpeed = (clip: Clip): number => Math.abs(clip.speed || 1)

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
 * and centering it, the "make it a Short" refit. `transform.scale=1` is the
 * renderer's contain-fit; cover needs scale = cover/contain. Titles take the
 * separate title path below (their metrics are sequence px, not frame-relative);
 * this skips clips that animate position, and clips the author
 * has manually moved or scaled (don't fight a hand-placed transform). Only
 * identity transforms and the exact cover-fit a previous refit produced for
 * the prevW×prevH frame are refit. A punch-in zoom (scale keyframes only, no
 * position animation, clip never moved) is refit too, by the same "only touch
 * our own work" rule applied to its resting baseline (the MIN keyframe value):
 * when that baseline is 1 or the previous frame's cover ratio, every scale
 * keyframe is multiplied by newCover/baseline, so the zoom rides along and
 * the switch stays reversible. Any other baseline is hand-authored and stays
 * sacred. Returns the same clip when nothing changes.
 */
/**
 * Scale a title's SEQUENCE-pixel fields with the frame. Vertical measurements
 * (type size, outline, shadow, box padding, the y offset) follow the height
 * ratio because that is what every title metric is authored against; only the x
 * offset follows the width. Returns the same clip when the ratio is 1.
 */
function refitTitleToFrame(clip: Clip, frameW: number, frameH: number, prevW: number, prevH: number): Clip {
  const title = clip.title
  if (!title) return clip
  const ry = frameH / prevH
  // scaleTitleDef is the ONE place these metrics are scaled. It is shared with the
  // preview (which draws smaller) and the export (which draws larger), so the
  // three cannot drift apart. Height drives it: every title metric is authored
  // against the frame height.
  const next = scaleTitleDef(title, ry)
  if (next === title) return clip
  // The x offset is the one measurement that follows the WIDTH.
  const rx = frameW / prevW
  const scaledX = Math.round(title.offsetXPx * rx)
  return { ...clip, title: scaledX === next.offsetXPx ? next : { ...next, offsetXPx: scaledX } }
}

export function refitClipToFill(
  clip: Clip,
  assets: Record<Id, MediaAsset>,
  frameW: number,
  frameH: number,
  prevW = 0,
  prevH = 0,
): Clip {
  // Titles carry SEQUENCE pixels, not frame-relative ones: jettismCaptionDef
  // bakes fontSizePx/outline/offset off the sequence HEIGHT at the moment the
  // caption is made. So captioning a 1920x1080 project and THEN switching to
  // 9:16 (the natural order, since the Look is the "make it a Short" button you
  // press last) left every caption at roughly half size, thin-outlined and at
  // the wrong height, with forty clips to fix by hand. Rescale them with the
  // frame instead. (Needs a known previous size; without one there is no ratio.)
  if (clip.title) return prevW > 0 && prevH > 0 ? refitTitleToFrame(clip, frameW, frameH, prevW, prevH) : clip
  if (clip.keyframes?.posX?.length || clip.keyframes?.posY?.length) return clip
  const asset = assets[clip.assetId]
  const sw = asset?.width ?? 0
  const sh = asset?.height ?? 0
  if (sw <= 0 || sh <= 0) return clip
  const contain = Math.min(frameW / sw, frameH / sh)
  if (contain <= 0) return clip
  const tf = clip.transform
  if (tf.x !== 0 || tf.y !== 0) return clip
  const cover = Math.max(frameW / sw, frameH / sh) / contain
  // Is this scale value our own work? Identity (never touched) or the exact
  // cover-fit a previous refit produced for the prevW×prevH frame.
  const isOwnWork = (v: number): boolean => {
    if (Math.abs(v - 1) < 1e-6) return true
    if (prevW > 0 && prevH > 0) {
      const prevContain = Math.min(prevW / sw, prevH / sh)
      if (prevContain > 0) {
        const prevCover = Math.max(prevW / sw, prevH / sh)
        return Math.abs(v - prevCover / prevContain) < 1e-6
      }
    }
    return false
  }
  const scaleKfs = clip.keyframes?.scale
  if (scaleKfs?.length) {
    let m = Infinity
    for (const k of scaleKfs) m = Math.min(m, k.value)
    if (!isOwnWork(m)) return clip
    const factor = cover / m
    if (Math.abs(factor - 1) < 1e-6 && Math.abs(tf.scale - cover) < 1e-6) return clip
    const scale = scaleKfs.map((k) => ({ ...k, value: k.value * factor }))
    return {
      ...clip,
      keyframes: { ...clip.keyframes, scale },
      transform: { ...tf, scale: cover, x: 0, y: 0 },
    }
  }
  if (!isOwnWork(tf.scale)) return clip
  if (Math.abs(tf.scale - cover) < 1e-6) return clip
  return { ...clip, transform: { ...tf, scale: cover, x: 0, y: 0 } }
}

/**
 * Reformat a sequence to width×height (e.g. 9:16 Shorts). When `refit`, every
 * untouched clip is scaled to fill the new frame (hand-placed transforms are
 * left alone; see refitClipToFill). Export follows the sequence dimensions.
 */
/**
 * Land a NEWLY created clip filling the sequence frame.
 *
 * Switching format already refits every clip to fill (setSequenceFormat), so
 * "switch to 9:16, then add a clip" and "add a clip, then switch to 9:16" used
 * to give different results: the second filled the frame, the first left the new
 * clip pillarboxed with bars down both sides. Same two actions, same intent,
 * two answers. His words: the clip should insert as 9:16, not 16:9 in a 9:16
 * window.
 *
 * Same math as the format switch, so the two can never drift. A source that
 * already matches the frame gets cover === contain and is returned untouched,
 * which is why this is a no-op for an ordinary 16:9 edit.
 */
export function fitNewClipToFrame(clip: Clip, asset: MediaAsset, seq: Sequence): Clip {
  return refitClipToFill(clip, { [asset.id]: asset }, seq.width, seq.height)
}

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
        const clips = t.clips.map((c) =>
          // The appearance rebake runs AFTER the fill refit so it settles to the
          // base that refit just chose, and it is what keeps the four
          // frame-relative presets honest across a format switch.
          refitAppearanceToFrame(
            refitClipToFill(c, assets, width, height, seq.width, seq.height),
            width,
            height,
            seq.width,
            seq.height,
          ),
        )
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
 * play faster (shorter clip) or slower (longer clip); in/out stay put, and that
 * is the whole difference from a trim.
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
      return retimeAppearance(c, { ...c, speed, startS }, seq.width, seq.height)
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
      if (groupIds.has(c.id)) return retimeAppearance(c, { ...c, speed: s }, seq.width, seq.height)
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

/**
 * Clear `[startS, endS)` on one track so something can be laid straight over
 * whatever was there. The overwrite edit every real NLE has, and the thing this
 * app had no way to do at all.
 *
 * Without it every placement went through resolveStart, which hunts for the
 * nearest gap that FITS. On a packed, cut-heavy timeline no interior gap fits,
 * so the only candidate left is the open end after the last clip: a dragged clip
 * snapped back where it started and a fresh drop landed at the end of the
 * sequence. That reads as the timeline refusing to be edited.
 *
 * Method: split at the FAR edge, then the NEAR edge, then delete what is wholly
 * inside. The splits reuse splitClip, so fades, transitions, keyframes and
 * effects divide exactly as they do for a razor cut rather than by a second,
 * hand-rolled copy of that logic. Far edge first, because splitting at `startS`
 * leaves the `endS` straddler as the RIGHT piece under a new id.
 *
 * `ignoreClipIds` is the moving clip's own link group: a clip must never
 * overwrite itself.
 */
export function clearSpan(
  seq: Sequence,
  trackId: Id,
  startS: number,
  endS: number,
  ignoreClipIds: readonly Id[] = [],
): Sequence {
  if (!(endS > startS + EPS)) return seq
  const ignore = new Set(ignoreClipIds)
  const trackOf = (s: Sequence): Track | undefined => s.tracks.find((t) => t.id === trackId)
  if (!trackOf(seq)) return seq

  let next = seq
  // Straddlers first. A sub-frame straddle is refused by splitClip's min-piece
  // guard and is handled by the trim pass below instead.
  for (const edge of [endS, startS]) {
    const straddler = trackOf(next)!.clips.find(
      (c) => !ignore.has(c.id) && c.startS < edge - EPS && clipEndS(c) > edge + EPS,
    )
    if (straddler) next = splitClip(next, straddler.id, edge)
  }

  const track = trackOf(next)!
  const kept: Clip[] = []
  for (const c of track.clips) {
    if (ignore.has(c.id)) {
      kept.push(c)
      continue
    }
    const cs = c.startS
    const ce = clipEndS(c)
    if (ce <= startS + EPS || cs >= endS - EPS) {
      kept.push(c) // no overlap
      continue
    }
    if (cs >= startS - EPS && ce <= endS + EPS) continue // wholly inside, drop it

    // Only a sub-frame sliver can reach here, because both edges were split
    // above and only splitClip's min-piece guard could have refused. Trim the
    // sliver off so no overlap survives: an overlap would break the sorted,
    // non-overlapping invariant the resolver depends on.
    const speed = Math.abs(c.speed) || 1
    if (cs < startS) {
      kept.push({ ...c, outS: c.inS + (startS - cs) * speed, transitionOut: undefined, fadeOutS: 0 })
    } else {
      kept.push({ ...c, startS: endS, inS: c.inS + (endS - cs) * speed, transitionIn: undefined, fadeInS: 0 })
    }
  }

  return {
    ...next,
    tracks: next.tracks.map((t) => (t.id === trackId ? { ...t, clips: kept } : t)),
  }
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
  seq0: Sequence,
  trackId: Id,
  asset: MediaAsset,
  desiredStartS: number,
  opts: { overwrite?: boolean } = {},
): { seq: Sequence; clipId: Id } {
  // The first video onto an empty timeline sets its frame rate. See adoptFrameRate.
  const seq = adoptFrameRate(seq0, asset)
  const trackIndex0 = seq.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex0 === -1) return { seq, clipId: '' }
  const track0 = seq.tracks[trackIndex0]
  const wantKind = asset.kind === 'audio' ? 'audio' : 'video'
  if (track0.kind !== wantKind || track0.locked) return { seq, clipId: '' }

  const outS = asset.durationS || 5 // images have durationS 0 → default 5s
  // Overwrite lays the clip exactly where he dropped it and clears what was
  // under it. Otherwise resolveStart hunts the nearest gap that FITS, and on a
  // packed timeline the only one is the open end, so the drop silently landed
  // at the end of the sequence instead of where he aimed.
  const startS = opts.overwrite ? Math.max(0, desiredStartS) : resolveStart(track0, desiredStartS, outS)
  const base = opts.overwrite ? clearSpan(seq, trackId, startS, startS + outS) : seq
  const trackIndex = base.tracks.findIndex((t) => t.id === trackId)
  const track = base.tracks[trackIndex]

  const clip: Clip = {
    id: newId(),
    assetId: asset.id,
    startS,
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
  const fitted = fitNewClipToFrame(clip, asset, seq)
  return { seq: withTrackClips(base, trackIndex, insertSorted(track.clips, fitted)), clipId: fitted.id }
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
  next = retimeAppearance(clip, next, seq.width, seq.height)

  return withTrackClips(
    seq,
    trackIndex,
    track.clips.map((c, i) => (i === clipIndex ? next : c)),
  )
}

// Keyframe times are within-tolerance-equal when closer than this (matches the
// clipEdits keyframe tolerance).
const KF_EPS = 1e-4

/**
 * Split one channel's keyframes at clip-local time `cutT`. Both sides get a
 * boundary keyframe holding the RESOLVED value at the cut (an existing
 * keyframe at the cut is reused verbatim), so left ends and right begins on
 * the exact same value. Eased segments spanning the cut are resampled
 * linearly at the boundary: exact for linear/hold, near for eases.
 */
export function splitKeyframeList(
  kfs: readonly Keyframe[],
  cutT: number,
): { left: Keyframe[]; right: Keyframe[] } {
  const atCut = kfs.find((k) => Math.abs(k.t - cutT) <= KF_EPS)
  // fallback is unreachable for a non-empty list; first value keeps it honest.
  const v = atCut ? atCut.value : evalChannel(kfs, cutT, kfs[0]?.value ?? 0)
  const before = kfs.filter((k) => k.t < cutT - KF_EPS)
  const after = kfs.filter((k) => k.t > cutT + KF_EPS).map((k) => ({ ...k, t: k.t - cutT }))
  return {
    left: [...before, atCut ? { ...atCut, t: cutT } : { t: cutT, value: v, ease: 'linear' as const }],
    right: [atCut ? { ...atCut, t: 0 } : { t: 0, value: v, ease: 'linear' as const }, ...after],
  }
}

/**
 * Whether a cut at `tS` would actually divide this clip into two usable pieces.
 * A piece shorter than one frame can never render a full frame, and a cut that
 * close to an edge is playhead jitter (cutting during playback, double-taps),
 * so honoring it would litter the timeline with unusable slivers.
 *
 * One source of truth, because splitGroup has to ask the SAME question of every
 * member before it commits to splitting any of them.
 */
export function canSplitClipAt(clip: Clip, fps: number, tS: number): boolean {
  const minPieceS = 1 / (fps || 30)
  return tS >= clip.startS + minPieceS && tS <= clipEndS(clip) - minPieceS
}

export function splitClip(seq: Sequence, clipId: Id, tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { track, clip, trackIndex, clipIndex } = found
  if (!canSplitClipAt(clip, seq.fps, tS)) return seq

  const cutSource = clip.inS + (tS - clip.startS) * absSpeed(clip)
  const cutLocal = tS - clip.startS
  // Edge-owned decorations split with their edge: the LEFT half keeps only the
  // fade-in/transition-in (its out edge is now a hard cut), the RIGHT half only
  // the fade-out/transition-out. Copying both to both halves put a fade-out+
  // fade-in bump at every cut point.
  let left: Clip = { ...clip, outS: cutSource, transitionOut: undefined, fadeOutS: 0 }
  let right: Clip = {
    ...clip,
    id: newId(),
    startS: tS,
    inS: cutSource,
    transform: { ...clip.transform, crop: { ...clip.transform.crop } },
    effects: clip.effects.map((e) => ({ ...e, id: newId(), params: { ...e.params } })),
    transitionIn: undefined,
    fadeInS: 0,
  }
  // Animation splits by TIME, like the fades above: each half keeps only its
  // own slice of the keyframes (the right half's shifted to its new zero), and
  // both get a boundary keyframe carrying the resolved value at the cut so the
  // motion continues seamlessly across it. Copying the full set to both halves
  // made a punch zoom REPLAY from the start on the right piece. A side left
  // with a single boundary keyframe (its half of the animation is constant)
  // collapses to a static base, so no phantom "animated" stopwatch on it.
  for (const [ch, kfs] of Object.entries(clip.keyframes ?? {}) as [AnimChannel, Keyframe[]][]) {
    if (!kfs?.length) continue
    const s = splitKeyframeList(kfs, cutLocal)
    left =
      s.left.length <= 1
        ? withChannelValue(withChannelKeyframes(left, ch, []), ch, s.left[0]!.value)
        : withChannelKeyframes(left, ch, s.left)
    right =
      s.right.length <= 1
        ? withChannelValue(withChannelKeyframes(right, ch, []), ch, s.right[0]!.value)
        : withChannelKeyframes(right, ch, s.right)
  }
  const splitParamsSide = (effects: Clip['effects'], side: 'left' | 'right'): Clip['effects'] =>
    effects.map((e) => ({
      ...e,
      params: Object.fromEntries(
        Object.entries(e.params).map(([k, p]): [string, Keyframeable] => {
          if (typeof p === 'number' || !p.keyframes?.length) return [k, p]
          const s = splitKeyframeList(p.keyframes, cutLocal)[side]
          return [k, s.length <= 1 ? s[0]!.value : { value: p.value, keyframes: s }]
        }),
      ),
    }))
  left = { ...left, effects: splitParamsSide(left.effects, 'left') }
  right = { ...right, effects: splitParamsSide(right.effects, 'right') }
  // An entrance/exit animation is edge-owned like the fades above: the left half
  // keeps only the entrance, the right half only the exit, and each is recompiled
  // for its own new length so a later trim can retime it.
  ;({ left, right } = splitAppearanceAcrossCut(clip, left, right, seq.width, seq.height))
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

/** Seconds of empty space immediately before a clip on its track (0 if none). */
export function gapBefore(seq: Sequence, clipId: Id): number {
  const found = findClip(seq, clipId)
  if (!found) return 0
  const prev = found.track.clips[found.clipIndex - 1]
  const target = prev ? clipEndS(prev) : 0
  return Math.max(0, found.clip.startS - target)
}

/** Shift a set of clip ids by −delta[id] across ALL tracks, then re-sort + recompute. */
function shiftClipsBy(seq: Sequence, deltaById: Map<Id, number>): Sequence {
  if (deltaById.size === 0) return seq
  const tracks = seq.tracks.map((t) => {
    if (!t.clips.some((c) => deltaById.has(c.id))) return t
    const clips = t.clips
      .map((c) => (deltaById.has(c.id) ? { ...c, startS: c.startS - deltaById.get(c.id)! } : c))
      .sort((a, b) => a.startS - b.startS)
    return { ...t, clips }
  })
  return recomputeDuration({ ...seq, tracks })
}

/**
 * Close the gap immediately BEFORE a clip: slide it (and every clip after it on
 * the same track) left to butt against the previous clip, or to 0 if it's the
 * first. LINK-GROUP AWARE: each moved clip's linked audio partner moves the same
 * distance, so a video and its split-off audio never drift apart. Preserves
 * spacing among the rippled clips. No-op when there's no gap.
 */
export function closeGapBefore(seq: Sequence, clipId: Id): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const delta = gapBefore(seq, clipId)
  if (delta <= EPS) return seq
  const deltaById = new Map<Id, number>()
  const byLink = linkGroupIndex(seq)
  for (let i = found.clipIndex; i < found.track.clips.length; i++) {
    for (const gid of groupIdsOf(found.track.clips[i], byLink)) deltaById.set(gid, delta)
  }
  return shiftClipsBy(seq, deltaById)
}

/**
 * Remove every gap on a track: butt each clip against the previous, keeping the
 * FIRST clip where it is (its lead-in is intentional). LINK-GROUP AWARE: each
 * clip's linked partner shifts by that clip's own delta, so linked audio repacks
 * in lockstep. One tidy pass.
 */
export function closeAllGaps(seq: Sequence, trackId: Id): Sequence {
  const ti = seq.tracks.findIndex((t) => t.id === trackId)
  if (ti < 0) return seq
  const sorted = [...seq.tracks[ti].clips].sort((a, b) => a.startS - b.startS)
  if (sorted.length === 0) return seq
  const deltaById = new Map<Id, number>()
  const byLink = linkGroupIndex(seq)
  let cursor = sorted[0].startS
  for (const c of sorted) {
    const d = c.startS - cursor
    if (Math.abs(d) > EPS) for (const gid of groupIdsOf(c, byLink)) deltaById.set(gid, d)
    cursor += clipDurationS(c)
  }
  return shiftClipsBy(seq, deltaById)
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
 * audio alike; cross-track alignment is the point), markers, t=0, and the
 * playhead.
 *
 * `excludeClipIds` must be the dragged clip's whole LINK GROUP, not just the
 * grabbed clip. A linked A/V pair otherwise leaves its partner's stale edges in
 * the set, and the drag magnetizes back to its own origin instead of to its
 * neighbours, which reads as "snapping doesn't work across lanes".
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

/**
 * The subset of `ids` whose clips sit on UNLOCKED tracks. A locked track
 * rejects every mutation, but selection stays allowed (inspecting a locked
 * clip's values is legitimate), so every destructive VERB filters through
 * this instead of trusting the selection.
 */
export function unlockedClipIds(seq: Sequence, ids: readonly Id[]): Id[] {
  const locked = new Set<Id>()
  for (const t of seq.tracks) {
    if (!t.locked) continue
    for (const c of t.clips) locked.add(c.id)
  }
  return ids.filter((id) => !locked.has(id))
}

export const timeToPx = (tS: number, pxPerS: number): number => tS * pxPerS

export const pxToTime = (px: number, pxPerS: number): number => px / pxPerS

// ---------------------------------------------------------------------------
// Linked A/V groups (Vegas-style). Clips sharing a linkId move/trim/split/
// delete together. A linked video clip is video-only; its audio-track partner
// carries the sound (see clipEmitsAudio in engine/audio.ts).

/**
 * linkId -> every clip id in that group, built in ONE pass over the sequence.
 * clipGroupIds is O(n) on its own (a findClip scan plus a full two-level scan),
 * so calling it once per clip made closing gaps O(n^2): on a cut-heavy track the
 * tidy-up crawled. Any loop that needs the group of MANY clips builds this once
 * and reads it instead.
 */
export function linkGroupIndex(seq: Sequence): Map<Id, Id[]> {
  const byLink = new Map<Id, Id[]>()
  for (const track of seq.tracks) {
    for (const c of track.clips) {
      if (!c.linkId) continue
      const ids = byLink.get(c.linkId)
      if (ids) ids.push(c.id)
      else byLink.set(c.linkId, [c.id])
    }
  }
  return byLink
}

/** The group of one clip we ALREADY hold, read off a prebuilt linkGroupIndex. */
function groupIdsOf(clip: Clip, byLink: Map<Id, Id[]>): Id[] {
  if (!clip.linkId) return [clip.id]
  return byLink.get(clip.linkId) ?? [clip.id]
}

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
 * The FIRST video onto an empty timeline sets the timeline's frame rate.
 *
 * A sequence was born at 30 and there was no way, anywhere in the app, to
 * change it. So a 60 fps recording was edited at 30 and EXPORTED at 30: half
 * his frames thrown away, silently, on footage most phones and every screen
 * recorder produce by default. Every other editor matches the sequence to the
 * first clip for exactly this reason.
 *
 * Only while the timeline is EMPTY. Once there is work on it the rate is part
 * of that work: changing it under him would move every frame-quantised edit he
 * has already made, which is a far worse surprise than a mixed-rate timeline
 * (which the engine handles anyway, by sampling each source at its own rate).
 */
export function adoptFrameRate(seq: Sequence, asset: MediaAsset): Sequence {
  const fps = asset.fps
  if (asset.kind !== 'video' || !fps || fps <= 0 || fps === seq.fps) return seq
  if (seq.tracks.some((t) => t.clips.length > 0)) return seq
  return { ...seq, fps }
}

/**
 * Add a video asset AND split its audio to a linked clip on an audio track.
 * The video clip (video-only, linked) lands on videoTrackId; the audio clip
 * (same asset, linked) lands on audioTrackId at the same start. Falls back to
 * a standalone video clip (its own audio) when no audio track is available.
 */
export function addClipWithLinkedAudio(
  seq0: Sequence,
  videoTrackId: Id,
  audioTrackId: Id | null,
  asset: MediaAsset,
  desiredStartS: number,
  opts: { overwrite?: boolean } = {},
): { seq: Sequence; videoClipId: Id; audioClipId: Id } {
  const seq = adoptFrameRate(seq0, asset)
  const vIndex0 = seq.tracks.findIndex((t) => t.id === videoTrackId)
  if (vIndex0 === -1) return { seq, videoClipId: '', audioClipId: '' }
  if (seq.tracks[vIndex0].kind !== 'video' || seq.tracks[vIndex0].locked) {
    return { seq, videoClipId: '', audioClipId: '' }
  }

  const aIndex0 = audioTrackId ? seq.tracks.findIndex((t) => t.id === audioTrackId) : -1
  const aTrack0 = aIndex0 === -1 ? null : seq.tracks[aIndex0]
  const canLink = !!aTrack0 && aTrack0.kind === 'audio' && !aTrack0.locked

  const dur = clipDurationS(newClipFromAsset(asset, 0))
  // Overwrite drops the pair exactly where he aimed and clears BOTH lanes under
  // it. Otherwise resolveStart looks for a start free on both tracks at once,
  // and on a packed timeline that is only ever the open end.
  let startS: number
  let base = seq
  if (opts.overwrite) {
    startS = Math.max(0, desiredStartS)
    base = clearSpan(base, videoTrackId, startS, startS + dur)
    if (canLink) base = clearSpan(base, audioTrackId!, startS, startS + dur)
  } else {
    // Place at a start free on BOTH tracks so the pair stays aligned.
    const obstacles: Track = {
      ...seq.tracks[vIndex0],
      clips: [...seq.tracks[vIndex0].clips, ...(canLink ? aTrack0!.clips : [])],
    }
    startS = resolveStart(obstacles, desiredStartS, dur)
  }

  const seqB = base
  const vIndex = seqB.tracks.findIndex((t) => t.id === videoTrackId)
  const vTrack = seqB.tracks[vIndex]
  const aIndex = audioTrackId ? seqB.tracks.findIndex((t) => t.id === audioTrackId) : -1

  if (!canLink) {
    // No audio track: standalone video clip keeps its own audio (no linkId).
    const clip = fitNewClipToFrame(newClipFromAsset(asset, startS), asset, seq)
    return {
      seq: withTrackClips(seqB, vIndex, insertSorted(vTrack.clips, clip)),
      videoClipId: clip.id,
      audioClipId: '',
    }
  }

  const linkId = newId()
  const videoClip: Clip = { ...fitNewClipToFrame(newClipFromAsset(asset, startS), asset, seq), linkId }
  const audioClip: Clip = { ...newClipFromAsset(asset, startS), linkId }
  const tracks = seqB.tracks.map((t, i) => {
    if (i === vIndex) return { ...t, clips: insertSorted(t.clips, videoClip) }
    if (i === aIndex) return { ...t, clips: insertSorted(t.clips, audioClip) }
    return t
  })
  return {
    seq: recomputeDuration({ ...seqB, tracks }),
    videoClipId: videoClip.id,
    audioClipId: audioClip.id,
  }
}

/**
 * Move a clip and shift every linked group member by the same time delta.
 *
 * ALL-OR-NOTHING: if any partner cannot take that exact delta on its own track,
 * the whole move is refused (same contract as rateStretchGroup). moveClip alone
 * would forward the partner's desired start through resolveStart, whose job is
 * to find the NEAREST free gap. So a busy audio track silently relocated the
 * voice seconds away from its picture, permanently out of sync, after one
 * ordinary drag.
 */
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

  const members = group
    .filter((id) => id !== clipId)
    .map((id) => findClip(next, id))
    .filter((m): m is NonNullable<typeof m> => m !== null)
  const targetStart = (m: (typeof members)[number]): number => Math.max(0, m.clip.startS + delta)
  // Every partner must land exactly where the delta puts it, or nobody moves.
  const allFit = members.every(
    (m) =>
      Math.abs(targetStart(m) - (m.clip.startS + delta)) < EPS &&
      canPlace(m.track, targetStart(m), clipDurationS(m.clip), m.clip.id),
  )
  if (!allFit) return seq

  for (const m of members) next = moveClip(next, m.clip.id, m.track.id, targetStart(m))
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

/**
 * Selection-scoped delete: ONE Delete verb instead of three menu entries.
 * The selection already says what to remove: the AUDIO half of a linked pair
 * → just that clip (the video partner survives and stays silent because its linkId
 * remains, so clipEmitsAudio keeps treating it as video-only); a VIDEO clip
 * or anything unlinked → the whole link group, exactly like before. This
 * replaced the enumerated "Delete audio only (keep video)" / "Delete video
 * only (keep audio)" menu items (2026-07-18 de-bloat). Video-only deletion
 * (rare) remains reachable by unlinking first.
 */
export function deleteScoped(seq: Sequence, clipId: Id): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  if (found.clip.linkId !== undefined && found.track.kind === 'audio') return deleteClip(seq, clipId)
  return deleteGroup(seq, clipId)
}

export function rippleDeleteGroup(seq: Sequence, clipId: Id): Sequence {
  let next = seq
  for (const id of clipGroupIds(seq, clipId)) next = rippleDelete(next, id)
  return next
}

/**
 * Split ONE clip at tS and leave its linked A/V partner untouched: "cut just
 * this clip", the verb behind an explicit selection (splitGroup cuts the pair).
 *
 * Each half gets its OWN fresh link group rather than dropping linkId, because
 * a video clip WITHOUT a linkId plays its own audio, which would double against
 * the partner audio clip still sitting on the timeline. A group of one keeps
 * each half video-only (the sound keeps coming from the untouched partner)
 * while letting the halves move, trim and delete independently.
 */
export function splitClipOnly(seq: Sequence, clipId: Id, tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  if (!found.clip.linkId) return splitClip(seq, clipId, tS)
  const next = splitClip(seq, clipId, tS)
  if (next === seq) return seq // the min-piece guard declined the cut
  const after = findClip(next, clipId)
  if (!after) return next
  const { track, trackIndex, clipIndex } = after
  // clipIndex is the left half; the right half is the clip directly after it.
  return withTrackClips(
    next,
    trackIndex,
    track.clips.map((c, i) => (i === clipIndex || i === clipIndex + 1 ? { ...c, linkId: newId() } : c)),
  )
}

/** Split every linked member at tS; the right halves form a fresh link group. */
export function splitGroup(seq: Sequence, clipId: Id, tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const link = found.clip.linkId
  if (!link) return splitClip(seq, clipId, tS)
  const groupBefore = new Set(clipGroupIds(seq, clipId))
  // ALL OR NOTHING. Members can sit at different distances from the cut once one
  // of them has been trimmed on its own, so asking each in turn could split some
  // and refuse others. That leaves the group half divided: the accepted right
  // half gets a fresh linkId while the refused member keeps the old one, so the
  // two sides stop being a pair.
  for (const id of groupBefore) {
    const member = findClip(seq, id)
    if (!member || !canSplitClipAt(member.clip, seq.fps, tS)) return seq
  }
  let next = seq
  for (const id of groupBefore) next = splitClip(next, id, tS)
  // Nothing moved, so hand BACK the same object. Rebuilding it would push an
  // undo step labelled "Split clip" that changed nothing, and would hide the
  // refusal from the UI, which spots it by reference equality to report why.
  if (next === seq) return seq
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

const DEFAULT_MARKER_COLOR = '#ffa946'

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
    // Ripple-in keeps startS fixed (content slides under the head), so the
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
  next = retimeAppearance(clip, next, seq.width, seq.height)

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

  const newLeft: Clip = retimeAppearance(
    left.clip,
    { ...left.clip, outS: newLeftOutS },
    seq.width,
    seq.height,
  )
  const rInS = right.clip.inS + (t - right.clip.startS) * spR
  const newRight: Clip = retimeAppearance(
    right.clip,
    rInS >= 0
      ? { ...right.clip, startS: t, inS: rInS }
      : // Right image pulled left past source zero: floor inS, keep its end
        // fixed by widening outS.
        { ...right.clip, startS: t, inS: 0, outS: (rightEndS - t) * spR },
    seq.width,
    seq.height,
  )

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

/**
 * Slip every member of a linked group by ONE common delta.
 *
 * Slipping only the grabbed clip changed the video's source window while its
 * linked audio kept the old one. The picture ran ahead of the voice by exactly
 * the slip amount, permanently, and with no visual feedback at all (the clip
 * neither moves nor changes length). Every other pair-aware verb in this file
 * operates on the group; slip was the one that did not.
 *
 * The members' source headroom is INTERSECTED first, so a member that runs out
 * of handles clamps the whole group instead of the halves drifting apart.
 */
export function slipGroup(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  deltaS: number,
): Sequence {
  const ids = clipGroupIds(seq, clipId)
  if (ids.length <= 1) return slipClip(seq, assets, clipId, deltaS)

  let lo = -Infinity
  let hi = Infinity
  let slippable = 0
  for (const id of ids) {
    const found = findClip(seq, id)
    if (!found) continue
    const asset = assets[found.clip.assetId] as MediaAsset | undefined
    if (!asset || asset.kind === 'image') continue
    slippable++
    // slipClip clamps in SOURCE seconds; convert the headroom to timeline
    // seconds so one delta is comparable across members at any speed.
    const sp = absSpeed(found.clip)
    lo = Math.max(lo, -found.clip.inS / sp)
    hi = Math.min(hi, (asset.durationS - found.clip.outS) / sp)
  }
  if (slippable === 0) return seq

  const d = Math.min(Math.max(deltaS, lo), hi)
  if (d === 0) return seq
  let next = seq
  for (const id of ids) next = slipClip(next, assets, id, d)
  return next
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

  const newPrev: Clip = retimeAppearance(
    prev,
    { ...prev, outS: prev.inS + (t - prev.startS) * spP },
    seq.width,
    seq.height,
  )
  const newStartN = t + durS
  const nInS = nextClip.inS + (newStartN - nextClip.startS) * spN
  const newNext: Clip = retimeAppearance(
    nextClip,
    nInS >= 0
      ? { ...nextClip, startS: newStartN, inS: nInS }
      : // Image next pulled left past source zero: floor inS, keep its end
        // fixed by widening outS.
        { ...nextClip, startS: newStartN, inS: 0, outS: (nextEndS - newStartN) * spN },
    seq.width,
    seq.height,
  )

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
  // A link only survives when the payload carries the WHOLE pair. Copying just
  // the video half used to mint it a link group of one: a linked video clip
  // emits no audio of its own (its partner is supposed to), so the pasted clip
  // played and exported permanently silent while still showing the link badge.
  // Alone, it is a standalone clip and keeps its own audio.
  const linkCount = new Map<Id, number>()
  for (const item of payload) {
    const id = item.clip.linkId
    if (id) linkCount.set(id, (linkCount.get(id) ?? 0) + 1)
  }
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
    if (linkId && (linkCount.get(linkId) ?? 0) < 2) {
      linkId = undefined
    } else if (linkId) {
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
