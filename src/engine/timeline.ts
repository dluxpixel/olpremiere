// Pure timeline engine: clip math, placement, trim/split/delete, snapping.
// No React, no DOM, no store: only types. Every function takes and returns
// immutable data; when nothing changes the input reference comes back as-is.

import { refitAppearanceToFrame, retimeAppearance, splitAppearanceAcrossCut } from './anim/appearance'
import { withChannelKeyframes, withChannelValue } from './effects/channels'
import { evalChannel, splitEaseAt } from './keyframes'
import { quantizeToFrame } from './timecode'
import {
  clipDurationS,
  clipEndS,
  defaultTransform,
  newClipFromAsset,
  newId,
  newTrack,
  ANIM_CHANNELS,
  scaleTitleDef,
  syncLockOf,
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
/** Within float noise of a frame instant, measured in frames. */
const FRAME_EPS = 1e-6

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
  // A STRETCHED clip already fills any shape of frame at its own scale: the
  // renderer lays it on the frame's corners. Growing it by the fill ratio here
  // would push it past every edge on the first switch to 9:16.
  if (clip.transform.fit === 'stretch') return clip
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
      // A rate stretch IS a speed change, so his keyframes follow the picture
      // here exactly as they do when he types a number into the speed box.
      // Fixing only setClipSpeed would leave this edge stranding them.
      const rescaled = rescaleKeyframesForSpeed(c, c.speed, speed)
      return retimeAppearance(c, { ...rescaled, speed, startS }, seq.width, seq.height)
    })
    return { ...track, clips }
  })
  return recomputeDuration({ ...seq, tracks })
}

/**
 * Slide every raw keyframe so it stays on the SOURCE FRAME it was authored on,
 * after a speed change has moved the picture under it.
 *
 * ⛔ WHY THIS EXISTS. Keyframe times are local to the clip's TIMELINE duration,
 * and speed changes that duration while the source range does not move.
 * `render/resolve.ts` reads source time as `inS + localT * rate` and hands the
 * SAME localT to `resolveChannel`, so doubling the speed leaves a keyframe
 * sitting on a frame twice as deep into the shot, and on a shortened clip it can
 * fall off the end entirely. `retimeAppearance` covers the compiled entrance and
 * exit presets and explicitly bails on anything touched by hand, so a move he
 * built himself was the one thing nothing carried. Keyframe audit item 3.
 *
 * Pinning a keyframe to its source frame gives `t' = t * rate/rate'`, and since
 * a clip's duration is `span/rate`, that is exactly `newDur/oldDur`. ⛔ A
 * REVERSED clip needs no separate case: the renderer walks `outS - localT * rate`
 * there, and the same substitution falls out unchanged.
 *
 * ⛔ SPEED ONLY, NEVER A TRIM. A trim changes the duration too, and there the
 * motion must stay anchored where he put it rather than stretch to fit.
 */
/**
 * Keep hand made keyframes on the SOURCE FRAMES they were authored on when the
 * clip's first frame moves: a head trim, a ripple trim at the head, the right
 * side of a roll. `deltaS` is how far the first frame moved, in clip local
 * seconds: positive means the clip now starts deeper into its media, negative
 * means earlier. Trimming the head used to leave every keyframe at its old
 * offset from the clip start, so a move authored on one picture slid onto
 * another. This is the same slice a split makes for its right half: keyframes
 * that now sit before the head fold into one boundary keyframe carrying the
 * value at the new first frame, and everything after it shifts with the media.
 * The compiled entrance and exit are rebuilt by retimeAppearance afterwards,
 * exactly as before.
 */
export function retimeKeyframesForHead(clip: Clip, deltaS: number): Clip {
  if (!clip.keyframes || Math.abs(deltaS) < KF_EPS) return clip
  let next = clip
  for (const channel of ANIM_CHANNELS) {
    const kfs = clip.keyframes[channel]
    if (!kfs || kfs.length === 0) continue
    const moved = deltaS > 0 ? splitKeyframeList(kfs, deltaS).right : kfs.map((k) => ({ ...k, t: k.t - deltaS }))
    next = withChannelKeyframes(next, channel, moved)
  }
  return next
}

export function rescaleKeyframesForSpeed(clip: Clip, oldRate: number, newRate: number): Clip {
  if (!clip.keyframes) return clip
  const from = Math.abs(oldRate) || 1
  const to = Math.abs(newRate) || 1
  const factor = from / to
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-9) return clip
  let next = clip
  for (const channel of ANIM_CHANNELS) {
    const kfs = clip.keyframes[channel]
    if (!kfs || kfs.length === 0) continue
    next = withChannelKeyframes(
      next,
      channel,
      kfs.map((k) => ({ ...k, t: k.t * factor })),
    )
  }
  return next
}

/**
 * ⛔ A NEW SPEED KEEPS THE CLIP A WHOLE NUMBER OF FRAMES LONG, 2026-10-03.
 *
 * Its length is (out - in) / speed, which a speed like 2.5x almost never leaves
 * on a frame: in his "strong until" project IMG_3080 at 2.5x ended at frame
 * 97.98, and the next clip, flush against it, and every edit after that sat off
 * the grid too (see canSplitClipAt for what that did to C). The tail gives up
 * at most one frame, the one its fractional end reached into, and never asks
 * the source for more than the clip already had.
 */
function lengthInWholeFrames(clip: Clip, fps: number): Clip {
  const rate = fps || 30
  const sp = absSpeed(clip)
  const frames = ((clip.outS - clip.inS) / sp) * rate
  const whole = Math.floor(frames + FRAME_EPS)
  if (whole < 1 || frames - whole < FRAME_EPS) return clip
  const spanS = (whole / rate) * sp
  // A reversed clip's tail is the START of its source span (reversedTailTo).
  return clip.speed < 0 ? { ...clip, inS: clip.outS - spanS } : { ...clip, outS: clip.inS + spanS }
}

/**
 * A source limit as an edit point: the nearest frame on the clip's side of it.
 * Dragging an edge out as far as the media goes, or Q / W / a roll stopped by
 * it, used to land the edge where the FILE ends, between two frames, and a
 * ripple then carried that fraction to every clip after it. Never past `edgeS`,
 * where the edge already is, so a clip that is off the grid itself can still be
 * pulled out as far as it already reaches.
 */
const headLimitOnFrame = (limitS: number, edgeS: number, fps: number): number =>
  Math.min(edgeS, Math.ceil(limitS * (fps || 30) - FRAME_EPS) / (fps || 30))
const tailLimitOnFrame = (limitS: number, edgeS: number, fps: number): number =>
  Math.max(edgeS, Math.floor(limitS * (fps || 30) + FRAME_EPS) / (fps || 30))

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

  // ⛔ SLOWING A CLIP DOWN IS A RIPPLE, so it owes the other tracks a follow like
  // any other. Read off the clip he actually grabbed, before anything moves.
  // Missing this was the quietest of the four ways in: nothing about typing a
  // number into the speed box looks like an edit that moves other tracks, and it
  // is the one he would be least likely to catch happening.
  const moved = new Set<Id>()
  const grabbedOldEnd = clipEndS(found.clip)
  const grabbedNewDur = clipDurationS(lengthInWholeFrames({ ...found.clip, speed: s }, seq.fps))
  const grabbedDelta = found.clip.startS + grabbedNewDur - grabbedOldEnd

  const tracks = seq.tracks.map((track) => {
    const member = track.clips.find((c) => groupIds.has(c.id))
    if (!member) return track
    moved.add(track.id)
    const oldEnd = clipEndS(member)
    const newDur = clipDurationS(lengthInWholeFrames({ ...member, speed: s }, seq.fps))
    const delta = member.startS + newDur - oldEnd
    const clips = track.clips.map((c) => {
      if (groupIds.has(c.id)) {
        // The hand-made keyframes first, then the compiled appearance: the
        // appearance retimer reads the clip's duration off the new speed, and it
        // must not see a half-updated clip.
        const rescaled = rescaleKeyframesForSpeed(c, c.speed, s)
        return retimeAppearance(c, lengthInWholeFrames({ ...rescaled, speed: s }, seq.fps), seq.width, seq.height)
      }
      // Ripple the tail only when the member grew, to clear the overlap.
      if (delta > EPS && c.startS >= oldEnd - EPS) return { ...c, startS: c.startS + delta }
      return c
    })
    return { ...track, clips }
  })
  // Only the growing direction shifts anything: speeding a clip UP leaves a gap
  // on its own track rather than pulling the tail back, so there is no movement
  // for another track to match and following would invent one.
  return syncFollow(
    recomputeDuration({ ...seq, tracks }),
    moved,
    grabbedOldEnd,
    grabbedDelta > EPS ? grabbedDelta : 0,
  )
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
      const head = c.speed < 0 ? reversedTailTo(c, startS - cs) : { ...c, outS: c.inS + (startS - cs) * speed }
      kept.push({ ...head, transitionOut: undefined, fadeOutS: 0 })
    } else {
      const tail = c.speed < 0 ? reversedHeadTo(c, endS - cs) : { ...c, inS: c.inS + (endS - cs) * speed }
      kept.push({ ...tail, startS: endS, transitionIn: undefined, fadeInS: 0 })
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

/**
 * ⛔ A CLIP PLACED FROM HIS MEDIA LANDS ON THE FRAME GRID, 2026-10-03.
 *
 * Its start on a frame, its length a whole number of frames. Two ways in used to
 * leave an edge between two frames, and every edit after it inherits that:
 *   - a picture pasted, or a file added, after playback lands at the playhead,
 *     and a paused playhead rests wherever the transport stopped;
 *   - a file's own length is rarely whole frames of the sequence. His OBS take
 *     "2026-10-03 18-06-57.mp4" runs 33.083 s, which is frame 992.5 at 30 fps.
 * An edge between frames is drawn half a frame from the frame the clip really
 * starts on, the playhead can never stand on it, and C refuses the frames either
 * side of it (see canSplitClipAt). Rounding the length DOWN gives up at most
 * one frame at the tail, the one a fractional end reached into, and never asks
 * the file for more than it has.
 */
export const startOnFrame = (tS: number, fps: number): number => quantizeToFrame(Math.max(0, tS), fps || 30)

/** `durS` cut down to whole frames. Anything shorter than one frame is left alone. */
export function wholeFramesS(durS: number, fps: number): number {
  const rate = fps || 30
  const frames = Math.floor(durS * rate + FRAME_EPS)
  return frames >= 1 ? frames / rate : durS
}

/**
 * The gap resolveStart found, moved onto the next frame when it begins between
 * two (flush against a clip that ends off the grid) and the clip still fits.
 */
function gapStartOnFrame(track: Track, startS: number, durS: number, fps: number): number {
  const rate = fps || 30
  if (onFrameGrid(startS, rate)) return startS
  const next = Math.ceil(startS * rate - FRAME_EPS) / rate
  return resolveStart(track, next, durS) === next ? next : startS
}

export function addClipFromAsset(
  seq0: Sequence,
  trackId: Id,
  asset: MediaAsset,
  desiredStartS: number,
  opts: { exact?: boolean } = {},
): { seq: Sequence; clipId: Id } {
  // The first video onto an empty timeline sets its frame rate. See adoptFrameRate.
  const seq = adoptFrameRate(seq0, asset)
  const trackIndex0 = seq.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex0 === -1) return { seq, clipId: '' }
  const track0 = seq.tracks[trackIndex0]
  const wantKind = asset.kind === 'audio' ? 'audio' : 'video'
  if (track0.kind !== wantKind || track0.locked) return { seq, clipId: '' }

  // On the frame grid, start and length: see startOnFrame.
  const outS = wholeFramesS(asset.durationS || 5, seq.fps) // images have durationS 0 → default 5s
  const desired = startOnFrame(desiredStartS, seq.fps)
  // `exact` lays the clip exactly WHEN he dropped it. Where something is already
  // there, it goes on the next free line (freeTrackFor) instead of clearing what
  // was under it, his pick 2026-09-28. Without `exact`, resolveStart hunts the
  // nearest gap that FITS on this one track.
  const startS = opts.exact ? desired : gapStartOnFrame(track0, resolveStart(track0, desired, outS), outS, seq.fps)
  let base = seq
  let homeId = trackId
  if (opts.exact) {
    const home = freeTrackFor(seq, wantKind, trackIndex0, startS, outS)
    base = home.seq
    homeId = base.tracks[home.trackIndex]!.id
  }
  const trackIndex = base.tracks.findIndex((t) => t.id === homeId)
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

/**
 * A REVERSED CLIP PLAYS ITS SOURCE BACKWARD, SO ITS EDGES ARE SWAPPED.
 *
 * At clip-local second `x` a reversed clip shows `outS - x * |speed|` (the
 * renderer's own mapping, render/resolve.ts), so its HEAD is the END of its
 * source span and its TAIL is the start. Every trim and cut used to do forward
 * arithmetic on it. Measured 2026-10-01 in his GYM, on a reversed clip: a cut
 * moved the picture on the left half by 3 seconds, Q left 23 wrong frames and
 * took away the end he kept, W changed the picture BEFORE the playhead by 30
 * frames, and a freeze held a frame 7 frames from the one on screen. The same
 * verbs on the same clip played forward: 0 frames. These four helpers are the
 * reversed half of that arithmetic; the forward code stays exactly as it was.
 */

/** Timeline seconds of source a clip has left before its head. */
function headRoomS(clip: Clip, asset: MediaAsset): number {
  const sp = absSpeed(clip)
  return clip.speed < 0 ? (asset.durationS - clip.outS) / sp : clip.inS / sp
}

/** How far past its start a clip's end can reach before the source runs out. */
function tailLimitS(clip: Clip, asset: MediaAsset): number {
  const sp = absSpeed(clip)
  return clip.speed < 0 ? clip.outS / sp : (asset.durationS - clip.inS) / sp
}

/**
 * A reversed clip whose head moved `headDeltaS` later (earlier when negative)
 * while its tail stays put: the head is the END of the source span, so `outS`
 * moves.
 */
function reversedHeadTo(clip: Clip, headDeltaS: number): Clip {
  return { ...clip, outS: clip.outS - headDeltaS * absSpeed(clip) }
}

/**
 * A reversed clip whose tail now ends `durS` after its start: the tail is the
 * START of the source span, so `inS` moves. A still grown past source zero
 * floors `inS` and widens `outS` instead, the same rule the forward head uses.
 */
function reversedTailTo(clip: Clip, durS: number): Clip {
  const inS = clip.outS - durS * absSpeed(clip)
  return inS >= 0 ? { ...clip, inS } : { ...clip, inS: 0, outS: clip.outS - inS }
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
    if (!boundless) lo = Math.max(lo, headLimitOnFrame(clip.startS - headRoomS(clip, asset), clip.startS, seq.fps))
    const startS = Math.min(endS - minDurS, Math.max(lo, tS))
    if (startS === clip.startS) return seq
    if (clip.speed < 0) {
      next = { ...reversedHeadTo(clip, startS - clip.startS), startS }
    } else {
      const inS = clip.inS + (startS - clip.startS) * sp
      next =
        inS >= 0
          ? { ...clip, startS, inS }
          : // Image extended left past source zero: floor inS, grow outS so the
            // out edge stays fixed at endS.
            { ...clip, startS, inS: 0, outS: (endS - startS) * sp }
    }
    next = retimeKeyframesForHead(next, startS - clip.startS)
  } else {
    const nextClip = track.clips[clipIndex + 1] as Clip | undefined
    let hi = nextClip ? nextClip.startS : Infinity
    if (!boundless) hi = Math.min(hi, tailLimitOnFrame(clip.startS + tailLimitS(clip, asset), endS, seq.fps))
    const newEndS = Math.min(hi, Math.max(clip.startS + minDurS, tS))
    if (newEndS === endS) return seq
    next =
      clip.speed < 0
        ? reversedTailTo(clip, newEndS - clip.startS)
        : { ...clip, outS: clip.inS + (newEndS - clip.startS) * sp }
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

/** Put `shape` on a keyframe, dropping a curve it no longer has. */
function withShape(k: Keyframe, shape: Pick<Keyframe, 'ease' | 'curve'>): Keyframe {
  const next: Keyframe = { t: k.t, value: k.value, ease: shape.ease }
  return shape.curve ? { ...next, curve: shape.curve } : next
}

/**
 * Split one channel's keyframes at clip-local time `cutT`. Both sides get a
 * boundary keyframe holding the RESOLVED value at the cut (an existing keyframe
 * at the cut is reused verbatim), so left ends and right begins on the exact
 * same value.
 *
 * ⛔ AND THE SHAPE BETWEEN THOSE VALUES SURVIVES THE CUT NOW. It used not to.
 * The left half kept its ease and re-ran the whole of it over half the distance,
 * and the right half was handed a plain linear. The endpoints matched, so a
 * still frame looked correct, while the PATH between them was wrong at every cut
 * he made: measured by the keyframe audit as a push off about 4 percent, a pop
 * about 10, and a hold arriving as a ramp. Every cut degraded his motion a
 * little more, silently, and this docstring used to call it exact.
 *
 * `splitEaseAt` cuts the curve itself in two, so the halves played back to back
 * are the original. Where no exact answer exists (`easeInOut`, or a cut where
 * the value has not moved) it says so and the old linear boundary stands, which
 * is the honest fallback rather than an invented shape.
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

  // The segment the cut lands inside, if there is one on both sides of it.
  const from = before[before.length - 1]
  const to = kfs.find((k) => k.t > cutT + KF_EPS)
  const split =
    !atCut && from && to ? splitEaseAt(from, (cutT - from.t) / (to.t - from.t)) : null

  const leftBody = split ? [...before.slice(0, -1), withShape(from, split.left)] : before
  const leftEnd = atCut ? { ...atCut, t: cutT } : { t: cutT, value: v, ease: 'linear' as const }
  const rightHead = atCut
    ? { ...atCut, t: 0 }
    : withShape({ t: 0, value: v, ease: 'linear' }, split ? split.right : { ease: 'linear' })

  return { left: [...leftBody, leftEnd], right: [rightHead, ...after] }
}

/**
 * Whether a cut at `tS` would actually divide this clip into two usable pieces.
 * A piece shorter than one frame can never render a full frame, and a cut that
 * close to an edge is playhead jitter (cutting during playback, double-taps),
 * so honoring it would litter the timeline with unusable slivers.
 *
 * One source of truth, because splitGroup has to ask the SAME question of every
 * member before it commits to splitting any of them.
 *
 * ⛔ A CUT ON THE FRAME GRID COUNTS FRAMES, NOT SECONDS, 2026-10-03.
 *
 * His report, with a screenshot: *"I can't cut. When I click C, it won't cut in
 * this frame, even though I'm on another frame."* His project had every edit
 * after a 2.5x clip sitting between two frames (6.318 s is frame 189.54 at 30
 * fps). The playhead only ever stands ON a frame, so at each of those edits the
 * frame before it was 0.54 of a frame from the clip's end and the frame after it
 * 0.46 of a frame from the next clip's start, and the old rule (each piece at
 * least 1/fps long) refused both. Two dead frames at every edit, and C said
 * nothing about either.
 *
 * What a piece needs is a FRAME to show: the renderer samples each clip at the
 * frame instants inside [start, end). Cutting ON a frame, the right piece always
 * starts on the frame it shows, however short it is, so the frame before an
 * off-grid end is a fine place to cut. The frame after an off-grid start is not:
 * that frame is the clip's first, and the left piece would show nothing.
 * splitAtPlayhead says so out loud. A clip on the grid gets exactly the answer it
 * always got. A cut OFF the grid (a word boundary, a silence edge, a window being
 * carved) keeps the length rule, where a few milliseconds of piece is a sliver.
 */
export function canSplitClipAt(clip: Clip, fps: number, tS: number): boolean {
  const rate = fps || 30
  const endS = clipEndS(clip)
  if (onFrameGrid(tS, rate)) return framesShown(clip.startS, tS, rate) >= 1 && framesShown(tS, endS, rate) >= 1
  const minPieceS = 1 / rate
  return tS >= clip.startS + minPieceS && tS <= endS - minPieceS
}

/** On a frame instant, to within float noise. */
export const onFrameGrid = (tS: number, fps: number): boolean => Math.abs(tS * fps - Math.round(tS * fps)) < FRAME_EPS

/** How many frame instants fall inside [fromS, toS): the frames that span shows. */
export function framesShown(fromS: number, toS: number, fps: number): number {
  const first = Math.ceil(fromS * fps - FRAME_EPS)
  const end = Math.ceil(toS * fps - FRAME_EPS)
  return Math.max(0, end - first)
}

export function splitClip(seq: Sequence, clipId: Id, tS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const { track, clip, trackIndex, clipIndex } = found
  if (!canSplitClipAt(clip, seq.fps, tS)) return seq

  // A reversed clip shows `outS - local * |speed|` (see `headRoomS`), so its
  // left half keeps the END of the source span and its right half the start.
  const reversed = clip.speed < 0
  const cutSource = reversed
    ? clip.outS - (tS - clip.startS) * absSpeed(clip)
    : clip.inS + (tS - clip.startS) * absSpeed(clip)
  const cutLocal = tS - clip.startS
  // Edge-owned decorations split with their edge: the LEFT half keeps only the
  // fade-in/transition-in (its out edge is now a hard cut), the RIGHT half only
  // the fade-out/transition-out. Copying both to both halves put a fade-out+
  // fade-in bump at every cut point.
  let left: Clip = {
    ...clip,
    ...(reversed ? { inS: cutSource } : { outS: cutSource }),
    transitionOut: undefined,
    fadeOutS: 0,
  }
  let right: Clip = {
    ...clip,
    id: newId(),
    startS: tS,
    ...(reversed ? { outS: cutSource } : { inS: cutSource }),
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
  const next = withTrackClips(
    seq,
    found.trackIndex,
    found.track.clips.filter((c) => c.id !== clipId),
  )
  // Deleting the SOUND of a linked pair is a decision, and it has to survive
  // the next load: the video half keeps its linkId (so its own audio stays off
  // now) AND is marked, so repairLostAudioLinks does not read the missing
  // partner as a lost link and hand the clip its voice back tomorrow.
  const link = found.clip.linkId
  if (found.track.kind !== 'audio' || link === undefined) return next
  return {
    ...next,
    tracks: next.tracks.map((t) =>
      t.kind !== 'video' || !t.clips.some((c) => c.linkId === link)
        ? t
        : { ...t, clips: t.clips.map((c) => (c.linkId === link ? { ...c, ownAudioOff: true as const } : c)) },
    ),
  }
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
/**
 * Trim a proposed LEFT shift until nothing lands on top of anything.
 *
 * ⛔ CLOSING A GAP USED TO DRAG A LINKED PARTNER STRAIGHT THROUGH ITS NEIGHBOURS.
 * The shift map is built from the link index alone and `shiftClipsBy` only
 * subtracts and re-sorts: it never asks whether the destination is free. So
 * closing a gap in front of a clip whose audio partner sits behind a music bed
 * slid the voice four seconds INTO the bed, producing the one state the rest of
 * this file is written to make impossible.
 *
 * Members of one link group are always trimmed to the SAME distance, because the
 * point of the group is that they arrive together. A partner with no room
 * therefore holds its whole group back, which leaves part of the gap uncloseable
 * and is the honest answer: the alternative is losing his audio.
 *
 * ⛔ IT HAS TO STAY LINEAR. There is a gate on this path measuring 4000 linked
 * clips against a single frame, so the work per pass is one sort of each track
 * (done ONCE, up front) and one walk. A pass reduces at least one group or it is
 * the last one.
 *
 * Reductions cascade, so this iterates. It cannot loop forever, because a delta
 * only ever falls and only ever onto one of a finite set of gaps, but a
 * pathological arrangement could take many passes and this runs on a gesture. So
 * the passes are capped, and an arrangement that has not settled by then closes
 * NO gap at all rather than a wrong one. Nothing observed has needed more than
 * two.
 */
const CLAMP_PASSES = 8

function clampShiftForCollisions(seq: Sequence, deltaById: Map<Id, number>, byLink: Map<Id, Id[]>): Map<Id, number> {
  const out = new Map(deltaById)
  // Sorted once: the walk below needs start order and nothing here changes it.
  const lanes = seq.tracks
    .filter((t) => t.clips.some((c) => out.has(c.id)))
    .map((t) => [...t.clips].sort((a, b) => a.startS - b.startS))
  if (lanes.length === 0) return out

  for (let pass = 0; ; pass++) {
    let changed = false
    for (const clips of lanes) {
      // Where the previous clip on this track ENDS once its own shift is applied.
      let projectedEnd = 0
      for (const c of clips) {
        const want = out.get(c.id) ?? 0
        const room = Math.max(0, c.startS - projectedEnd)
        if (want > room + EPS) {
          // The whole link group comes down to what this member can manage.
          for (const gid of groupIdsOf(c, byLink)) {
            if ((out.get(gid) ?? 0) > room) {
              out.set(gid, room)
              changed = true
            }
          }
          projectedEnd = clipEndS(c) - room
        } else {
          projectedEnd = clipEndS(c) - want
        }
      }
    }
    if (!changed) return out
    if (pass >= CLAMP_PASSES) {
      // Too tangled to settle. Moving nothing is always safe; moving something
      // half-resolved is not.
      return new Map()
    }
  }
}

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
 * MOVE EVERY OTHER TRACK ALONG WITH A RIPPLE, so his edit does not slide out of
 * sync behind his back.
 *
 * His ask, 2026-08-13. A ripple used to shift only the track it happened on.
 *
 * `atS` is where the ripple happened in SEQUENCE time and `deltaS` is how far
 * everything after it moves, negative when the timeline gets shorter. Every clip
 * that STARTS at or after that point, on a track that follows, moves by it.
 *
 * ⛔ `atS` IS THE FAR EDGE OF THE EDIT, NEVER THE NEAR ONE. For a delete that is
 * the deleted clip's END, not its start; for a trim it is the clip's OLD end,
 * whichever direction the edge went. Passing the near edge lets a follower land
 * inside the span the ripple just removed, which is how a clip on his second
 * track ended up at MINUS ONE SECOND: the origin track never does that, because
 * its own clips all begin at or after that far edge already.
 *
 * ⛔ A CLIP THAT STARTS BEFORE THE POINT AND RUNS PAST IT IS LEFT ALONE.
 * Shifting it would open a hole behind it and splitting it would destroy work he
 * did not ask to have touched. Conservative is right here, and it is what the
 * reference editors do.
 *
 * ⛔⛔ AND A TRACK HOLDING SUCH A CLIP DOES NOT FOLLOW AT ALL. Leaving the
 * spanning clip while its neighbours slide left is not a compromise, it is an
 * OVERLAP: a five second overlay over his cut, with the clip after it pulled
 * back underneath it, and "clips never overlap on one track" is the invariant
 * the whole engine is written against. That track is already out of sync at the
 * cut, so the honest answer is that it keeps its own timing, exactly as it did
 * before any of this existed, and nothing he has already finished is damaged.
 *
 * Locked tracks are skipped for the same reason `unlockedClipIds` exists: a lock
 * is him saying leave this alone, and every verb honours it rather than trusting
 * the caller.
 *
 * ⛔⛔ CALL THIS ONCE PER USER ACTION, AT THE GROUP LEVEL, NEVER INSIDE
 * `rippleDelete` OR `rippleTrimTo`. Those are single-track primitives and the
 * `*Group` wrappers call them ONCE PER LINKED MEMBER, so a follow buried inside
 * them shifts every other track TWICE for a linked A/V pair: his music jumps by
 * double, and only on linked clips, which is the kind of bug that looks random.
 * A previous session hit exactly this and named it the trap in the sync lock.
 */
function syncFollow(
  seq: Sequence,
  alreadyMoved: ReadonlySet<Id>,
  atS: number,
  deltaS: number,
  report?: RippleReport,
): Sequence {
  return syncFollowEdits(seq, alreadyMoved, [{ atS, deltaS }], report)
}

/** One ripple: everything at or after `atS` moves by `deltaS`, negative for left. */
interface RippleEdit {
  atS: number
  deltaS: number
}

/**
 * What a ripple could NOT carry along: the tracks that kept their own timing
 * because something on them sits in the time the edit took out. A track held
 * by a clip running across the cut is not listed: that hold is as old as sync
 * lock and stays silent. A verb fills it when the caller hands one in, so the message
 * that names those tracks reads the decision the engine actually took instead
 * of guessing at it. Only a track that WOULD have moved is listed: a track with
 * nothing after the cut is not held back from anything.
 */
export interface RippleReport {
  heldTrackIds: Id[]
}

/**
 * The general form: SEVERAL ripples that were all one press of his keyboard.
 *
 * ⛔ THIS EXISTS BECAUSE COUNTING THE CLIPS HE PICKED IS NOT COUNTING THE TIME
 * REMOVED. Ripple deleting a selection runs one delete per clip, so two clips
 * covering the SAME second on two tracks used to shift every other track by two
 * seconds: measured 2026-08-13, a third track landed at 0 when the answer was 1.
 * Overlapping edits are merged to the time actually removed before anything
 * moves, which is also, on its own, what stops a linked A/V pair counting twice.
 */
function syncFollowEdits(
  seq: Sequence,
  alreadyMoved: ReadonlySet<Id>,
  edits: readonly RippleEdit[],
  report?: RippleReport,
): Sequence {
  const real = edits.filter((e) => Math.abs(e.deltaS) > EPS)
  if (real.length === 0) return seq
  const deltaById = new Map<Id, number>()
  for (const t of seq.tracks) {
    // ⛔ `alreadyMoved` is EVERY track the ripple itself touched, not just the
    // one he clicked on. A linked A/V pair is rippled on BOTH its tracks by the
    // group wrapper, so skipping only the origin would shift the audio half a
    // second time: the same double-shift trap, one level up from where it was
    // expected. Whichever way this is wired, the question to ask is "which
    // tracks has the ripple already moved", never "which track did he click".
    if (alreadyMoved.has(t.id) || t.locked || !syncLockOf(t)) continue
    const own = new Map<Id, number>()
    for (const c of t.clips) {
      // Every edit at or before this clip applies to it, and they add up.
      let deltaS = 0
      for (const e of real) if (c.startS >= e.atS - EPS) deltaS += e.deltaS
      // `shiftClipsBy` SUBTRACTS, so a ripple that pulls the timeline left is a
      // positive entry here. Getting this sign backwards is the easiest mistake
      // in this whole feature.
      if (Math.abs(deltaS) > EPS) own.set(c.id, -deltaS)
    }
    if (own.size === 0) continue
    // Straddling the cut, per the block comment: this track keeps its own
    // timing rather than tearing itself in half. Touching `>` and `<` and not
    // their epsilon-slack forms is deliberate, a clip that ends exactly ON the
    // point does not straddle it and is the ordinary butted-up case.
    //
    const straddles = t.clips.some((c) => real.some((e) => c.startS < e.atS - EPS && clipEndS(c) > e.atS + EPS))
    // ⛔⛔ AND SO DOES A CLIP IN THE TIME THE EDIT TOOK OUT THAT THE FOLLOWERS
    // WOULD LAND ON. A left ripple removes `[atS + deltaS, atS]` and every clip
    // after it slides back across that span, so a caption or a voice take lying
    // INSIDE the span stayed put while the clips behind it slid on top of it, or
    // past it. Measured 2026-10-01 on his five projects: 239 of 471 ripple
    // deletes, Qs and Ws left two clips in one place, two of his voiceovers
    // playing at once and one caption drawn over another. His captions and his
    // voice are finished work, so that track keeps its timing and he is told.
    // A clip in the span that nothing reaches (a word cut on both tracks at the
    // same points) still lets the track follow, as it always has: holding it
    // there would put everything after the cut out of sync for no reason.
    //
    // Only the second kind is REPORTED. A clip across the cut held its track
    // silently long before this, and it is most of his ripples (a caption
    // running over the cut point): naming it every time put a toast on 391 of
    // 471 of his edits, a line he would learn to ignore. Measured 2026-10-03.
    if (straddles) continue
    if (followWouldCollide(t.clips, own)) {
      report?.heldTrackIds.push(t.id)
      continue
    }
    for (const [id, d] of own) deltaById.set(id, d)
  }
  return shiftClipsBy(seq, deltaById)
}

/**
 * Would shifting these clips (left by `deltaById`, the `shiftClipsBy` sign) put
 * one on top of another, or carry one PAST a clip that stays? Walked in the
 * track's own order, so a clip that would land anywhere before the end of an
 * earlier one is caught either way. One pass, no allocation per clip. Two clips
 * that ALREADY shared time before the edit are old damage, not this edit's, and
 * do not hold the track on their own.
 */
function followWouldCollide(clips: readonly Clip[], deltaById: ReadonlyMap<Id, number>): boolean {
  let reach = -Infinity
  let reachBefore = -Infinity
  for (const c of clips) {
    const d = deltaById.get(c.id) ?? 0
    if (c.startS - d < reach - EPS && c.startS >= reachBefore - EPS) return true
    reach = Math.max(reach, clipEndS(c) - d)
    reachBefore = Math.max(reachBefore, clipEndS(c))
  }
  return false
}

/**
 * Merge ripple deletes that cover the same stretch of time into the time
 * ACTUALLY removed, as `[far edge, how far everything after it moves]`.
 *
 * A linked A/V pair is two deletes of one second at the same second: one second
 * removed, not two. Two clips he box-selected across two tracks are the same
 * again. Spans that merely touch end to end stay separate, because they already
 * add up correctly and merging them would change nothing.
 */
function mergeRemovals(spans: ReadonlyArray<{ startS: number; endS: number }>): RippleEdit[] {
  const sorted = [...spans].sort((a, b) => a.startS - b.startS)
  const merged: Array<{ startS: number; endS: number }> = []
  for (const s of sorted) {
    const last = merged[merged.length - 1]
    if (last && s.startS < last.endS - EPS) last.endS = Math.max(last.endS, s.endS)
    else merged.push({ ...s })
  }
  return merged.map((s) => ({ atS: s.endS, deltaS: s.startS - s.endS }))
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
  return shiftClipsBy(seq, clampShiftForCollisions(seq, deltaById, byLink))
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
  // Same guard as closeGapBefore: a partner on another track may not be shoved
  // through whatever is already sitting there just because this track repacks.
  return shiftClipsBy(seq, clampShiftForCollisions(seq, deltaById, byLink))
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
  opts: { exact?: boolean } = {},
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

  // On the frame grid, start and length: see startOnFrame. Both halves are cut
  // from the same `dur`, so the pair stays exactly as long as each other.
  const dur = wholeFramesS(clipDurationS(newClipFromAsset(asset, 0)), seq.fps)
  const placed = (startS: number): Clip => ({ ...newClipFromAsset(asset, startS), outS: dur })
  const desired = startOnFrame(desiredStartS, seq.fps)
  // `exact` drops the pair exactly WHEN he aimed, each half on the next free
  // line of its kind when its own lane is taken there, and nothing under it is
  // cleared (his pick 2026-09-28). Otherwise resolveStart looks for a start free
  // on both tracks at once, and on a packed timeline that is only the open end.
  let startS: number
  let base = seq
  let vId = videoTrackId
  let aId = audioTrackId
  if (opts.exact) {
    startS = desired
    const vHome = freeTrackFor(base, 'video', vIndex0, startS, dur)
    base = vHome.seq
    vId = base.tracks[vHome.trackIndex]!.id
    if (canLink) {
      const aHome = freeTrackFor(base, 'audio', base.tracks.findIndex((t) => t.id === audioTrackId), startS, dur)
      base = aHome.seq
      aId = base.tracks[aHome.trackIndex]!.id
    }
  } else {
    // Place at a start free on BOTH tracks so the pair stays aligned.
    const obstacles: Track = {
      ...seq.tracks[vIndex0],
      clips: [...seq.tracks[vIndex0].clips, ...(canLink ? aTrack0!.clips : [])],
    }
    startS = gapStartOnFrame(obstacles, resolveStart(obstacles, desired, dur), dur, seq.fps)
  }

  const seqB = base
  const vIndex = seqB.tracks.findIndex((t) => t.id === vId)
  const vTrack = seqB.tracks[vIndex]
  const aIndex = aId ? seqB.tracks.findIndex((t) => t.id === aId) : -1

  if (!canLink) {
    // No audio track: standalone video clip keeps its own audio (no linkId).
    const clip = fitNewClipToFrame(placed(startS), asset, seq)
    return {
      seq: withTrackClips(seqB, vIndex, insertSorted(vTrack.clips, clip)),
      videoClipId: clip.id,
      audioClipId: '',
    }
  }

  const linkId = newId()
  const videoClip: Clip = { ...fitNewClipToFrame(placed(startS), asset, seq), linkId }
  const audioClip: Clip = { ...placed(startS), linkId }
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
  const ids = clipGroupIds(seq, clipId)
  if (ids.length <= 1) return trimClipTo(seq, assets, clipId, edge, tS)
  // ⛔ THE EDGE IS AGREED BEFORE ANYTHING IS CUT, the same rule rippleTrimGroup
  // keeps. Each half used to be trimmed to the same time one after the other,
  // and a trim is clamped by its own track: the neighbour beside it, the media
  // it has left. When only the audio half's neighbour was in the way, the video
  // ran on to the drag and the sound stopped short, and from that moment the
  // pair was two lengths, out of sync with nothing on screen to say so. So
  // every member is tried alone, the edge that moved LEAST wins, and every
  // member is trimmed to that one edge.
  const origin = findClip(seq, clipId)
  if (!origin) return seq
  const edgeOf = (c: Clip): number => (edge === 'in' ? c.startS : clipEndS(c))
  const from = edgeOf(origin.clip)
  let agreed: number | null = null
  for (const id of ids) {
    const after = findClip(trimClipTo(seq, assets, id, edge, tS), id)
    if (!after) continue
    const e = edgeOf(after.clip)
    if (agreed === null || Math.abs(e - from) < Math.abs(agreed - from)) agreed = e
  }
  if (agreed === null) return seq
  let next = seq
  for (const id of ids) next = trimClipTo(next, assets, id, edge, agreed)
  return next
}

/**
 * Ripple-trim ONE clip and leave its linked partner's LENGTH alone, then carry
 * the other tracks along. The verb behind Ctrl+dragging an edge with one half of
 * a pair explicitly selected.
 *
 * ⛔ THE UI MUST CALL THIS, NEVER `rippleTrimTo` DIRECTLY. The primitive is
 * single-track on purpose, so a UI wired straight to it left every other track
 * standing still on exactly the gesture a sync lock exists for, and only when he
 * had picked one half of a pair. That is the sort of hole nobody finds by using
 * the app, because it looks like it works everywhere else.
 */
export function rippleTrimSolo(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
  report?: RippleReport,
): Sequence {
  const before = findClip(seq, clipId)
  if (!before) return seq
  const next = rippleTrimTo(seq, assets, clipId, edge, tS)
  const after = findClip(next, clipId)
  if (!after) return next
  return syncFollow(
    next,
    new Set([before.track.id]),
    clipEndS(before.clip),
    clipEndS(after.clip) - clipEndS(before.clip),
    report,
  )
}

export function rippleTrimGroup(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
  report?: RippleReport,
): Sequence {
  const before = findClip(seq, clipId)
  const ids = clipGroupIds(seq, clipId)
  const moved = new Set<Id>()
  for (const id of ids) {
    const f = findClip(seq, id)
    if (f) moved.add(f.track.id)
  }

  // ⛔ EVERY HALF OF THE PAIR MOVES BY THE SAME AMOUNT, OR IT IS NOT A PAIR.
  //
  // Each half used to be trimmed to the SAME TIME, one after the other, and a
  // trim is clamped by its own source: how much head and tail that particular
  // file has left. A video half and an audio half are usually two different
  // files, and a separately recorded voice track almost always is. So asking
  // for a second and a half of trim could take a second and a half off the
  // picture and only nine tenths off the sound, and from that moment the two
  // were different lengths and everything after them on the two tracks sat at
  // different times. That is lip sync gone, from one drag, with nothing on
  // screen to say it happened.
  //
  // So the amount is agreed BEFORE anything is cut: try it on each half, keep
  // the smallest move anyone can manage, and give every half that. The trim is
  // as long as the most constrained member allows, which is the only length
  // they can all actually reach.
  const probe = (id: Id): number | null => {
    const beforeOne = findClip(seq, id)
    if (!beforeOne) return null
    const afterOne = findClip(rippleTrimTo(seq, assets, id, edge, tS), id)
    return afterOne ? clipEndS(afterOne.clip) - clipEndS(beforeOne.clip) : null
  }
  const deltas = ids.map(probe).filter((d): d is number => d !== null)
  if (deltas.length === 0) return seq
  const sign = Math.sign(deltas[0])
  // A half that would move the other way, or not at all, means there is no move
  // they can share. Doing nothing is the only answer that keeps them together.
  if (sign === 0 || deltas.some((d) => Math.sign(d) !== sign)) return seq
  const agreedS = sign * Math.min(...deltas.map(Math.abs))

  let next = seq
  for (const id of ids) {
    const f = findClip(next, id)
    if (!f) continue
    // Read off each half's own geometry, so halves that were never exactly
    // aligned keep whatever offset they had.
    const targetS = edge === 'out' ? clipEndS(f.clip) + agreedS : f.clip.startS - agreedS
    next = rippleTrimTo(next, assets, id, edge, targetS)
  }

  if (!before) return next
  // The clip's OLD end, in both directions. `rippleTrimTo` pins startS on either
  // edge and moves the END by the delta, and its own track shifts everything at
  // or after that old end, so this is simply the same point the primitive used.
  // Taking the later of the two ends instead would leave a clip sitting between
  // the old and new end standing still while its neighbours moved around it.
  return syncFollow(next, moved, clipEndS(before.clip), agreedS, report)
}

export function deleteGroup(seq: Sequence, clipId: Id): Sequence {
  let next = seq
  for (const id of clipGroupIds(seq, clipId)) next = deleteClip(next, id)
  return next
}

/**
 * Selection-scoped delete: what you picked is what goes.
 *
 * HIS WORDS, 2026-08-06: *"when I right-click a video clip and click Delete, it
 * deletes the audio too. When did I ever say you could do that?"*
 *
 * He is right, and the old rule was not even consistent: deleting the AUDIO
 * half took only that half, but deleting the VIDEO half took BOTH. So the same
 * key did two different things depending on which lane you happened to click,
 * and the destructive one was the unmarked case. The note that used to live
 * here said video-only deletion was "rare" and "remains reachable by unlinking
 * first", which is a habit change standing in for a fix.
 *
 * Now either half of a linked pair deletes ALONE. The survivor keeps its
 * linkId, so a video clip whose audio is gone stays video-only exactly as it
 * did before, and an audio clip whose video is gone still plays. Anything
 * unlinked has no group, so it is the same single delete it always was.
 *
 * Deleting BOTH is still one press: Shift-click the second half so the pair is
 * selected, then Delete. Ripple delete is unchanged and stays group-wide,
 * because rippling one half would slide its track out of sync with the other.
 */
export function deleteScoped(seq: Sequence, clipId: Id): Sequence {
  return deleteClip(seq, clipId)
}

export function rippleDeleteGroup(seq: Sequence, clipId: Id): Sequence {
  return rippleDeleteMany(seq, [clipId])
}

/**
 * Ripple delete a WHOLE SELECTION as ONE action, so the tracks that follow move
 * by the time that was actually removed.
 *
 * ⛔ THE UI MUST CALL THIS ONCE, NEVER `rippleDeleteGroup` IN A LOOP. Each call
 * follows on its own, so a loop over his selection pays the follow once per clip
 * he picked: two clips covering the same second on two tracks shifted a third
 * track by two seconds instead of one. Measured 2026-08-13.
 *
 * Every span is read off the ORIGINAL sequence before a single clip moves, which
 * is what makes them comparable at all, and linked partners come along by the
 * same route rather than by a separate rule.
 */
export function rippleDeleteMany(seq: Sequence, clipIds: readonly Id[], report?: RippleReport): Sequence {
  const targets = new Set<Id>()
  const moved = new Set<Id>()
  const spans: Array<{ startS: number; endS: number }> = []
  for (const clipId of clipIds) {
    for (const id of clipGroupIds(seq, clipId)) {
      if (targets.has(id)) continue
      const f = findClip(seq, id)
      if (!f) continue
      targets.add(id)
      moved.add(f.track.id)
      spans.push({ startS: f.clip.startS, endS: clipEndS(f.clip) })
    }
  }
  if (targets.size === 0) return seq

  let next = seq
  for (const id of targets) next = rippleDelete(next, id)
  return syncFollowEdits(next, moved, mergeRemovals(spans), report)
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
    if (!boundless) hi = tailLimitOnFrame(clip.startS + tailLimitS(clip, asset), endS, seq.fps)
    const newEndS = Math.min(hi, Math.max(clip.startS + minDurS, tS))
    if (newEndS === endS) return seq
    deltaS = newEndS - endS
    next =
      clip.speed < 0
        ? reversedTailTo(clip, newEndS - clip.startS)
        : { ...clip, outS: clip.inS + (newEndS - clip.startS) * sp }
  } else {
    // Ripple-in keeps startS fixed (content slides under the head), so the
    // previous clip never constrains it: only the source head + min duration.
    const lo = boundless ? -Infinity : headLimitOnFrame(clip.startS - headRoomS(clip, asset), clip.startS, seq.fps)
    const t = Math.min(endS - minDurS, Math.max(lo, tS))
    if (t === clip.startS) return seq
    deltaS = clip.startS - t
    if (clip.speed < 0) {
      next = reversedHeadTo(clip, t - clip.startS)
    } else {
      const inS = clip.inS + (t - clip.startS) * sp
      next =
        inS >= 0
          ? { ...clip, inS }
          : // Image grown past source zero: floor inS, widen outS to keep the
            // implied duration delta.
            { ...clip, inS: 0, outS: (clipDurationS(clip) + deltaS) * sp }
    }
    next = retimeKeyframesForHead(next, t - clip.startS)
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
  if (!boundlessR) lo = Math.max(lo, headLimitOnFrame(right.clip.startS - headRoomS(right.clip, assetR), right.clip.startS, seq.fps))
  let hi = rightEndS - minDurS
  if (!boundlessL) hi = Math.min(hi, tailLimitOnFrame(left.clip.startS + tailLimitS(left.clip, assetL), right.clip.startS, seq.fps))
  const t = Math.min(hi, Math.max(lo, tS))

  const trimmedLeft: Clip =
    left.clip.speed < 0
      ? reversedTailTo(left.clip, t - left.clip.startS)
      : { ...left.clip, outS: left.clip.inS + (t - left.clip.startS) * spL }
  if (
    trimmedLeft.outS === left.clip.outS &&
    trimmedLeft.inS === left.clip.inS &&
    t === right.clip.startS
  )
    return seq

  const newLeft: Clip = retimeAppearance(left.clip, trimmedLeft, seq.width, seq.height)
  const rInS = right.clip.inS + (t - right.clip.startS) * spR
  const newRight: Clip = retimeAppearance(
    right.clip,
    retimeKeyframesForHead(
      right.clip.speed < 0
        ? { ...reversedHeadTo(right.clip, t - right.clip.startS), startS: t }
        : rInS >= 0
          ? { ...right.clip, startS: t, inS: rInS }
          : // Right image pulled left past source zero: floor inS, keep its end
            // fixed by widening outS.
            { ...right.clip, startS: t, inS: 0, outS: (rightEndS - t) * spR },
      t - right.clip.startS,
    ),
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
  if (!boundlessN) lo = Math.max(lo, nextClip.startS - headRoomS(nextClip, assetN) - durS)
  let hi = nextEndS - minDurS - durS
  if (!boundlessP) hi = Math.min(hi, prev.startS + tailLimitS(prev, assetP))
  const t = Math.min(hi, Math.max(lo, tS))
  if (t === clip.startS) return seq

  const newPrev: Clip = retimeAppearance(
    prev,
    prev.speed < 0 ? reversedTailTo(prev, t - prev.startS) : { ...prev, outS: prev.inS + (t - prev.startS) * spP },
    seq.width,
    seq.height,
  )
  const newStartN = t + durS
  const nInS = nextClip.inS + (newStartN - nextClip.startS) * spN
  const newNext: Clip = retimeAppearance(
    nextClip,
    nextClip.speed < 0
      ? { ...reversedHeadTo(nextClip, newStartN - nextClip.startS), startS: newStartN }
      : nInS >= 0
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

/**
 * ⛔ NOTHING THAT LANDS ON THE TIMELINE MAY COVER WHAT IS ALREADY THERE,
 * 2026-09-28. His words: *"when I finish recording or paste a picture into a
 * line like V4 that already has stuff in it, it just deletes what it had under
 * it."* Asked where it should go instead, he picked "the next free line".
 *
 * The track a clip of `kind` spanning [startS, startS + durS) can land on
 * without touching anything: `fromIndex` when it is free and unlocked, else the
 * next free unlocked track of the same kind moving AWAY from the middle of the
 * timeline (up through video, down through audio), else a brand new track. The
 * clip keeps its time exactly: nothing is moved, cut or removed.
 */
export function freeTrackFor(
  seq: Sequence,
  kind: 'video' | 'audio',
  fromIndex: number,
  startS: number,
  durS: number,
): { seq: Sequence; trackIndex: number } {
  const same: number[] = []
  seq.tracks.forEach((t, i) => {
    if (t.kind === kind) same.push(i)
  })
  const from = Math.max(0, same.indexOf(fromIndex))
  for (let k = from; k < same.length; k++) {
    const t = seq.tracks[same[k]!]!
    if (!t.locked && canPlace(t, startS, durS)) return { seq, trackIndex: same[k]! }
  }
  const grown = addTrack(seq, kind)
  const made = grown.tracks.find((t) => !seq.tracks.includes(t))!
  return { seq: grown, trackIndex: grown.tracks.indexOf(made) }
}

/**
 * Paste the clipboard at `atS`.
 *
 * With a `target` (his right click on a lane) the payload lands on the track he
 * clicked: the lowest copied track of that kind goes there and the rest keep
 * their distance from it. Without one (Ctrl+V) each clip goes back to the track
 * it was copied from. Either way it lands at exactly the time asked, and a clip
 * whose spot is taken moves to the next free line (freeTrackFor), never in time
 * and never on top of anything. His words: *"it pastes it where I clicked it. It
 * doesn't just paste it randomly."*
 */
export function pasteClips(
  seq: Sequence,
  payload: ClipPayload[],
  atS: number,
  target?: { trackIndex: number },
): { seq: Sequence; newIds: Id[]; blockedByLock: number } {
  const kindIdx = (sq: Sequence): Record<'video' | 'audio', number[]> => {
    const out: Record<'video' | 'audio', number[]> = { video: [], audio: [] }
    sq.tracks.forEach((t, i) => out[t.kind].push(i))
    return out
  }
  const start = kindIdx(seq)

  // Which same-kind track a payload item asks for. A target shifts every item of
  // the target's kind by the same amount, so their stacking survives the move.
  const targetKind = target ? seq.tracks[target.trackIndex]?.kind : undefined
  const targetPos = target && targetKind ? start[targetKind].indexOf(target.trackIndex) : -1
  const ofTargetKind = payload.filter((p) => p.trackKind === targetKind).map((p) => p.trackOffset)
  const anchorOffset = ofTargetKind.length > 0 ? Math.min(...ofTargetKind) : -1
  const wantedOffset = (item: ClipPayload): number =>
    targetKind && item.trackKind === targetKind && anchorOffset >= 0 && targetPos >= 0
      ? targetPos + (item.trackOffset - anchorOffset)
      : item.trackOffset

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
  const groupOf = (item: ClipPayload): Id | null => {
    const id = item.clip.linkId
    return id && (linkCount.get(id) ?? 0) >= 2 ? id : null
  }

  // A link group is placed as one thing, so it is gathered up first. Everything
  // else keeps the payload's own order, and a group takes the place of its
  // earliest member.
  const units: ClipPayload[][] = []
  const unitOfGroup = new Map<Id, ClipPayload[]>()
  for (const item of payload) {
    const g = groupOf(item)
    if (!g) {
      units.push([item])
      continue
    }
    const existing = unitOfGroup.get(g)
    if (existing) existing.push(item)
    else {
      const unit = [item]
      unitOfGroup.set(g, unit)
      units.push(unit)
    }
  }

  let cur = seq
  let blockedByLock = 0
  for (const unit of units) {
    // Indices come from the CURRENT sequence: an earlier clip may have added a
    // track, which shifts everything after it.
    const idx = kindIdx(cur)
    const asked = unit.map((item) => {
      const sameKind = idx[item.trackKind]
      if (sameKind.length === 0) return null
      return sameKind[Math.min(Math.max(0, wantedOffset(item)), sameKind.length - 1)]!
    })
    // ⛔ A LOCKED HALF TAKES THE WHOLE PAIR WITH IT.
    // Pasting a linked pair onto a locked audio track used to drop the audio
    // and paste the video on its own, still linked, which is the one shape a
    // linked video clip cannot survive: it makes no sound of its own, because
    // its partner is meant to, and the partner never arrived.
    if (asked.some((ti) => ti === null || cur.tracks[ti].locked)) {
      blockedByLock += 1
      continue
    }
    // Pinned by identity, so a track added for one half cannot shift the other's.
    const askedTracks = asked.map((ti) => cur.tracks[ti!]!)
    for (let m = 0; m < unit.length; m++) {
      const item = unit[m]!
      const body = structuredClone(item.clip)
      const desiredS = Math.max(0, atS + item.offsetS)
      const durS = (body.outS - body.inS) / Math.abs(body.speed || 1)
      const home = freeTrackFor(cur, item.trackKind, cur.tracks.indexOf(askedTracks[m]!), desiredS, durS)
      cur = home.seq
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
        startS: desiredS,
        effects: body.effects.map((e) => ({ ...e, id: newId() })),
        linkId,
      }
      const placedTrack = cur.tracks[home.trackIndex]!
      const withClip = { ...placedTrack, clips: insertSorted(placedTrack.clips, clip) }
      cur = { ...cur, tracks: cur.tracks.map((t, i) => (i === home.trackIndex ? withClip : t)) }
      // Keep the identity pins pointing at the live track objects.
      for (let k = 0; k < askedTracks.length; k++) if (askedTracks[k] === placedTrack) askedTracks[k] = withClip
      newIds.push(clip.id)
    }
  }
  if (newIds.length === 0) return { seq, newIds, blockedByLock }
  return { seq: recomputeDuration(cur), newIds, blockedByLock }
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
