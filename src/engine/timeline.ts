// Pure timeline engine: clip math, placement, trim/split/delete, snapping.
// No React, no DOM, no store: only types. Every function takes and returns
// immutable data; when nothing changes the input reference comes back as-is.

import { refitAppearanceToFrame, retimeAppearance, splitAppearanceAcrossCut } from './anim/appearance'
import { withChannelKeyframes, withChannelValue } from './effects/channels'
import { evalChannel, splitEaseAt } from './keyframes'
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
  const grabbedNewDur = (found.clip.outS - found.clip.inS) / Math.abs(s)
  const grabbedDelta = found.clip.startS + grabbedNewDur - grabbedOldEnd

  const tracks = seq.tracks.map((track) => {
    const member = track.clips.find((c) => groupIds.has(c.id))
    if (!member) return track
    moved.add(track.id)
    const oldEnd = clipEndS(member)
    const newDur = (member.outS - member.inS) / Math.abs(s)
    const delta = member.startS + newDur - oldEnd
    const clips = track.clips.map((c) => {
      if (groupIds.has(c.id)) {
        // The hand-made keyframes first, then the compiled appearance: the
        // appearance retimer reads the clip's duration off the new speed, and it
        // must not see a half-updated clip.
        const rescaled = rescaleKeyframesForSpeed(c, c.speed, s)
        return retimeAppearance(c, { ...rescaled, speed: s }, seq.width, seq.height)
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

/**
 * CLEAR A WINDOW ON ONE TRACK so something can be dropped into it.
 *
 * His words, 2026-08-12: "Click-dragging is so fucking bad. Oh my god, it's just
 * so buggy. It has one function, and it can't even do that." Proven on his own
 * project: **on a packed track a dragged clip has nowhere it fits**, so
 * `resolveStart` hands back the slot it came from, `moveClip` sees an unchanged
 * start and returns the sequence untouched. He drags, lets go, and the clip sits
 * back down with nothing on screen saying why. **A finished edit is packed by
 * definition, so dragging never worked on real work.** He picked overwrite.
 *
 * ⛔ SPLITTING IS DELEGATED TO `splitClip`, NOT REIMPLEMENTED. A clip cut in the
 * middle has to divide its keyframes, fades and transitions by time, and there is
 * one tested implementation of that. Carving a window by hand here would have
 * been a second copy of the hardest maths in this file.
 *
 * A split the min-piece guard refuses leaves a sliver under a frame long; the
 * sweep below removes it with the rest rather than leaving a crumb behind.
 */
export function carveWindow(seq: Sequence, trackId: Id, fromS: number, toS: number, ignoreClipId?: Id): Sequence {
  if (toS - fromS <= EPS) return seq
  const idxOf = (s: Sequence) => s.tracks.findIndex((t) => t.id === trackId)
  if (idxOf(seq) === -1) return seq
  const frame = 1 / (seq.fps || 30)

  let next = seq
  // Cut any clip straddling an edge of the window, so what remains is either
  // wholly inside it or wholly outside. Re-read the track each pass: a split
  // rewrites the clip list.
  for (const edge of [fromS, toS]) {
    for (;;) {
      const track = next.tracks[idxOf(next)]
      const straddler = track.clips.find(
        (c) => c.id !== ignoreClipId && c.startS < edge - EPS && clipEndS(c) > edge + EPS,
      )
      if (!straddler || !canSplitClipAt(straddler, next.fps, edge)) break
      const after = splitClip(next, straddler.id, edge)
      if (after === next) break // refused: leave it to the sweep below
      next = after
    }
  }

  const track = next.tracks[idxOf(next)]
  const kept = track.clips.filter(
    (c) => c.id === ignoreClipId || !(c.startS >= fromS - frame && clipEndS(c) <= toS + frame),
  )
  return kept.length === track.clips.length ? next : withTrackClips(next, idxOf(next), kept)
}

/**
 * Move a clip and OVERWRITE whatever it lands on, the way an NLE does.
 *
 * The difference from `moveClip` is the whole point: that one hunts for a gap the
 * clip fits in and gives up when there is none. This one puts the clip exactly
 * where it was dropped and clears the space for it.
 */
export function moveClipOverwrite(seq: Sequence, clipId: Id, targetTrackId: Id, desiredStartS: number): Sequence {
  const found = findClip(seq, clipId)
  if (!found) return seq
  const targetIndex = seq.tracks.findIndex((t) => t.id === targetTrackId)
  if (targetIndex === -1) return seq
  const target = seq.tracks[targetIndex]
  if (found.track.kind !== target.kind || found.track.locked || target.locked) return seq

  const startS = Math.max(0, desiredStartS)
  if (found.trackIndex === targetIndex && Math.abs(startS - found.clip.startS) < EPS) return seq
  const moved: Clip = { ...found.clip, startS }
  const endS = startS + clipDurationS(moved)

  // ⛔ THE CHEAP PATH IS NOT AN OPTIMISATION, IT IS REQUIRED. This runs on EVERY
  // pointer-move of a drag to build the live preview, and the perf guard caught
  // the first version at FOURTEEN times its budget on a 200-clip sequence.
  // Landing on empty space is the common case and needs no carving at all, so it
  // costs exactly what the old move cost.
  const target2 = seq.tracks[targetIndex]
  const hits = target2.clips.some(
    (c) => c.id !== clipId && c.startS < endS - EPS && clipEndS(c) > startS + EPS,
  )
  if (!hits) {
    const tracks = seq.tracks.map((t, i) => {
      const without = i === found.trackIndex ? t.clips.filter((c) => c.id !== clipId) : t.clips
      const clips = i === targetIndex ? insertSorted(without, moved) : without
      return clips === t.clips ? t : { ...t, clips }
    })
    return recomputeDuration({ ...seq, tracks })
  }

  // Lift it out FIRST, so a move within one track cannot carve itself away.
  const lifted = deleteClip(seq, clipId)
  const carved = carveWindow(lifted, targetTrackId, startS, endS, clipId)
  const ti = carved.tracks.findIndex((t) => t.id === targetTrackId)
  return recomputeDuration(withTrackClips(carved, ti, insertSorted(carved.tracks[ti].clips, moved)))
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
function syncFollow(seq: Sequence, alreadyMoved: ReadonlySet<Id>, atS: number, deltaS: number): Sequence {
  return syncFollowEdits(seq, alreadyMoved, [{ atS, deltaS }])
}

/** One ripple: everything at or after `atS` moves by `deltaS`, negative for left. */
interface RippleEdit {
  atS: number
  deltaS: number
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
function syncFollowEdits(seq: Sequence, alreadyMoved: ReadonlySet<Id>, edits: readonly RippleEdit[]): Sequence {
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
    // Straddling the cut, per the block comment: this track keeps its own
    // timing rather than tearing itself in half. Touching `>` and `<` and not
    // their epsilon-slack forms is deliberate, a clip that ends exactly ON the
    // point does not straddle it and is the ordinary butted-up case.
    if (t.clips.some((c) => real.some((e) => c.startS < e.atS - EPS && clipEndS(c) > e.atS + EPS))) continue
    for (const c of t.clips) {
      // Every edit at or before this clip applies to it, and they add up.
      let deltaS = 0
      for (const e of real) if (c.startS >= e.atS - EPS) deltaS += e.deltaS
      // `shiftClipsBy` SUBTRACTS, so a ripple that pulls the timeline left is a
      // positive entry here. Getting this sign backwards is the easiest mistake
      // in this whole feature.
      if (Math.abs(deltaS) > EPS) deltaById.set(c.id, -deltaS)
    }
  }
  return shiftClipsBy(seq, deltaById)
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
/**
 * `moveGroup` that overwrites instead of refusing.
 *
 * ⛔ The plain group move is ALL OR NOTHING: if any linked partner cannot be
 * placed, `canPlace` fails and NOBODY moves. On a packed timeline that is a
 * SECOND reason a linked drag did nothing at all, on top of the gap search in
 * `moveClip`. Overwrite always fits, so the gate goes with it.
 */
export function moveGroupOverwrite(seq: Sequence, clipId: Id, targetTrackId: Id, desiredStartS: number): Sequence {
  const group = clipGroupIds(seq, clipId)
  if (group.length <= 1) return moveClipOverwrite(seq, clipId, targetTrackId, desiredStartS)
  const before = findClip(seq, clipId)
  if (!before) return seq
  let next = moveClipOverwrite(seq, clipId, targetTrackId, desiredStartS)
  const after = findClip(next, clipId)
  if (!after) return next
  const delta = after.clip.startS - before.clip.startS
  if (delta === 0) return next
  for (const id of group) {
    if (id === clipId) continue
    const m = findClip(next, id)
    if (!m) continue
    next = moveClipOverwrite(next, m.clip.id, m.track.id, Math.max(0, m.clip.startS + delta))
  }
  return next
}

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
  )
}

export function rippleTrimGroup(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: Id,
  edge: 'in' | 'out',
  tS: number,
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
  return syncFollow(next, moved, clipEndS(before.clip), agreedS)
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
export function rippleDeleteMany(seq: Sequence, clipIds: readonly Id[]): Sequence {
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
  return syncFollowEdits(next, moved, mergeRemovals(spans))
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

/**
 * Where a whole linked group can land, as ONE offset shared by every member.
 *
 * ⛔ PASTING A LINKED PAIR USED TO PULL THE PICTURE OFF THE SOUND.
 * Each half looked for a free spot on its own track and took the nearest one.
 * When the video track was clear at the playhead and the audio track was not,
 * the video landed where he asked and the voice landed somewhere else, still
 * wearing the link badge that says these two belong together. Every later edit
 * then moved them as a pair, keeping them permanently out of step, and lip sync
 * that is out by a fifth of a second is not obvious until it is published.
 *
 * The candidates are the offsets each member would have chosen for itself, plus
 * the clear ground past the end of every track the group touches, which always
 * fits. The smallest move that suits ALL of them wins, so a pair whose tracks
 * are both free still lands exactly on the playhead.
 */
function groupPasteOffset(
  tracks: readonly Track[],
  members: { trackIndex: number; desiredS: number; durS: number }[],
): number {
  const candidates: number[] = [0]
  let clearGround = 0
  for (const m of members) {
    const track = tracks[m.trackIndex]
    candidates.push(resolveStart(track, m.desiredS, m.durS) - m.desiredS)
    for (const c of track.clips) clearGround = Math.max(clearGround, clipEndS(c) - m.desiredS)
  }
  candidates.push(clearGround)
  // Nearest first, so the pair moves as little as it can get away with.
  candidates.sort((x, y) => Math.abs(x) - Math.abs(y))
  for (const shift of candidates) {
    if (members.every((m) => canPlace(tracks[m.trackIndex], Math.max(0, m.desiredS + shift), m.durS))) return shift
  }
  return clearGround
}

export function pasteClips(
  seq: Sequence,
  payload: ClipPayload[],
  atS: number,
): { seq: Sequence; newIds: Id[]; blockedByLock: number } {
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

  let tracks = seq.tracks
  let blockedByLock = 0
  for (const unit of units) {
    const placed = unit.map((item) => {
      const sameKind = kindIdx[item.trackKind]
      if (sameKind.length === 0) return null
      const ti = sameKind[Math.min(Math.max(0, item.trackOffset), sameKind.length - 1)]
      const body = structuredClone(item.clip)
      return {
        item,
        body,
        trackIndex: ti,
        desiredS: atS + item.offsetS,
        durS: (body.outS - body.inS) / Math.abs(body.speed || 1),
      }
    })
    // ⛔ A LOCKED HALF TAKES THE WHOLE PAIR WITH IT.
    // Pasting a linked pair onto a locked audio track used to drop the audio
    // and paste the video on its own, still linked, which is the one shape a
    // linked video clip cannot survive: it makes no sound of its own, because
    // its partner is meant to, and the partner never arrived. It played silent,
    // exported silent, and looked completely normal.
    if (placed.some((m) => m === null || tracks[m.trackIndex].locked)) {
      blockedByLock += 1
      continue
    }
    const members = placed as NonNullable<(typeof placed)[number]>[]
    const shift = members.length > 1 ? groupPasteOffset(tracks, members) : 0

    for (const m of members) {
      const track = tracks[m.trackIndex]
      let linkId = m.body.linkId
      if (linkId && (linkCount.get(linkId) ?? 0) < 2) {
        linkId = undefined
      } else if (linkId) {
        const mapped = linkRemap.get(linkId) ?? newId()
        linkRemap.set(linkId, mapped)
        linkId = mapped
      }
      const clip: Clip = {
        ...m.body,
        id: newId(),
        startS:
          members.length > 1
            ? Math.max(0, m.desiredS + shift)
            : resolveStart(track, m.desiredS, m.durS),
        effects: m.body.effects.map((e) => ({ ...e, id: newId() })),
        linkId,
      }
      tracks = tracks.map((t, i) => (i === m.trackIndex ? { ...t, clips: insertSorted(t.clips, clip) } : t))
      newIds.push(clip.id)
    }
  }
  if (newIds.length === 0) return { seq, newIds, blockedByLock }
  return { seq: recomputeDuration({ ...seq, tracks }), newIds, blockedByLock }
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

/**
 * A whole multi-clip drag, as one pure sequence-in, sequence-out step.
 *
 * EXTRACTED FROM Timeline.tsx on 2026-08-06 so it can actually be tested. It
 * was a closure inside the component, which meant the only way to cover it was
 * to drive real pointer physics in a browser, and the first attempt at that
 * ended up re-implementing the logic inside the test: green, and proving
 * nothing about the app. The live preview and the single-dispatch commit both
 * call this, so what he sees while dragging is what lands.
 */
// Move the grabbed clip's group to tS, then shift every other selected
// group by the same delta on its own track - direction-ordered so earlier
// moves never collide with clips that are themselves about to move (the
// same trick as nudgeSelection). ONE sequence in, one out: preview and the
// single-dispatch commit share it byte-for-byte.
/**
 * The nearest start this clip may take on `track` WITHOUT lying on top of
 * anything, given where it is coming from.
 *
 * Going right it parks its tail against the blocker's head; going left it parks
 * its head against the blocker's tail. If there is nowhere at all in the
 * direction he is dragging, it keeps the position it already had, which is the
 * only honest answer for a track with no room.
 *
 * ⛔ WALKED FROM WHERE HE AIMED, IN THE DIRECTION HE DRAGGED. Picking the
 * globally nearest gap instead is what made a packed drag teleport back into its
 * own slot and look like nothing happened.
 */
/**
 * How far this clip may slide along its OWN track before it touches something
 * that is not travelling with it. Infinity when the track is otherwise clear.
 *
 * `travelling` is every clip moving by the same delta in the same gesture, so a
 * linked pair or a repacked run never blocks itself.
 *
 * Going left it also stops at zero, because there is no timeline before it.
 */
export function slideRoom(track: Track, clip: Clip, forward: boolean, travelling: ReadonlySet<Id>): number {
  const end = clipEndS(clip)
  let room = forward ? Infinity : clip.startS
  for (const other of track.clips) {
    if (other.id === clip.id || travelling.has(other.id)) continue
    if (forward) {
      if (other.startS >= end - EPS) room = Math.min(room, other.startS - end)
    } else if (clipEndS(other) <= clip.startS + EPS) {
      room = Math.min(room, clip.startS - clipEndS(other))
    }
  }
  return Math.max(0, room)
}

export function nearestFreeStart(
  track: Track,
  desiredStartS: number,
  durationS: number,
  ignoreClipId: Id,
  fromStartS: number,
): number {
  const want = Math.max(0, desiredStartS)
  const others = track.clips.filter((c) => c.id !== ignoreClipId)
  const clashes = (start: number): boolean =>
    others.some((c) => c.startS < start + durationS - EPS && clipEndS(c) > start + EPS)
  if (!clashes(want)) return want

  const goingRight = want > fromStartS
  const edges = goingRight
    ? others.map((c) => c.startS - durationS).sort((a, b) => b - a)
    : others.map((c) => clipEndS(c)).sort((a, b) => a - b)
  for (const e of edges) {
    const at = Math.max(0, e)
    if (goingRight ? at > want + EPS : at < want - EPS) continue
    if (!clashes(at)) return at
  }
  return fromStartS
}

export function moveSelectionWith(
  base: Sequence,
  grabbedId: Id,
  targetTrackId: Id,
  tS: number,
  others: { id: Id; startS0: number; solo?: boolean }[],
  solo = false,
): Sequence {
  const grabbed = base.tracks.flatMap((t) => t.clips).find((c) => c.id === grabbedId)
  if (!grabbed) return base
  const deltaS = tS - grabbed.startS
  // Solo: he clicked one half of a pair and left the partner unselected, so
  // the partner stays where it is. moveClip is the same verb the group move
  // uses underneath; the only difference is that it stops at this clip.
  // ⛔ NEVER OVERWRITE, AND NEVER SIT STILL EITHER. Both are his, three days
  // apart, and either one alone has a wrong fix.
  //
  // 2026-08-12: a drag on a packed track moved NOTHING, because placement hunted
  // for a gap the clip fits in and the only one was the slot it came from. He
  // chose overwrite to fix that.
  //
  // 2026-08-15: overwrite CARVES the clip underneath. His words: "you can slide
  // clips over different clips ... remove that feature and I never wanna see it
  // again." That is not sliding, it is destroying footage he never touched.
  //
  // So the target is clamped to somewhere legal FIRST, and the placement that
  // runs afterwards is then handed a spot with nothing under it. The clip slides
  // freely and stops against its neighbour: it always moves, and it can never
  // land on anything.
  // ⛔ AND THE CLAMP COVERS THE WHOLE LINKED PAIR, NOT ONLY THE HALF HE GRABBED.
  //
  // The clamp below was applied to the grabbed clip alone. Its partner was then
  // shifted by the same delta through moveGroupOverwrite, which has no clamp at
  // all: it carves whatever is already sitting there. So dragging a linked pair
  // into an empty stretch of video, with a music bed under it on the audio
  // track, silently deleted the slice of music the audio half landed on. That is
  // the same destruction he banned on 2026-08-15, surviving on the half of the
  // gesture nobody looked at.
  //
  // So the group slides as far as its MOST CONSTRAINED member allows. Every
  // member is free where it stands, and sliding a shorter distance in the same
  // direction from a free position is always free, so shortening the delta can
  // never create a new overlap. The pair keeps its sync, it always moves, and it
  // stops against a neighbour rather than eating one.
  const travelling = new Set(solo ? [grabbedId] : clipGroupIds(base, grabbedId))
  let want = tS
  if (!solo && travelling.size > 1 && Math.abs(deltaS) > EPS) {
    const forward = deltaS > 0
    let room = Math.abs(deltaS)
    for (const id of travelling) {
      if (id === grabbedId) continue
      const m = findClip(base, id)
      if (m) room = Math.min(room, slideRoom(m.track, m.clip, forward, travelling))
    }
    want = grabbed.startS + (forward ? room : -room)
  }
  const targetTrack = base.tracks.find((t) => t.id === targetTrackId)
  const safeS = targetTrack
    ? nearestFreeStart(targetTrack, want, clipDurationS(grabbed), grabbedId, grabbed.startS)
    : want
  let next = solo
    ? moveClipOverwrite(base, grabbedId, targetTrackId, safeS)
    : moveGroupOverwrite(base, grabbedId, targetTrackId, safeS)
  if (others.length === 0) return next

  // THE SELECTION CHANGES TRACK TOGETHER, NOT JUST TIME.
  //
  // His words, 2026-08-06: "when I drag one clip, for example, from v6 to v5,
  // it should drag all, but it doesn't."
  //
  // He is right and the old code could not have done it: every carried clip
  // was re-placed on `tr.id`, the track it was ALREADY on, so only the grabbed
  // clip ever changed lane. Worse, a purely vertical drag has deltaS === 0, and
  // the early return above used to bail on that, so dragging a multi-selection
  // straight down moved exactly one clip and left the rest behind.
  //
  // The shift is counted in LANES OF THE SAME KIND, not raw track indices, so
  // "down one video track" stays "down one video track" even with audio tracks
  // interleaved, and a selected audio clip is never flung onto a video track.
  // Clips of the other kind keep their lane and just travel in time.
  const grabbedIdx = base.tracks.findIndex((t) => t.clips.some((c) => c.id === grabbedId))
  const targetIdx = base.tracks.findIndex((t) => t.id === targetTrackId)
  const kind = base.tracks[grabbedIdx]?.kind
  const lanes = base.tracks.map((t, i) => ({ kind: t.kind, i })).filter((x) => x.kind === kind)
  const posOf = (trackIdx: number): number => lanes.findIndex((x) => x.i === trackIdx)
  const laneShift =
    grabbedIdx >= 0 && targetIdx >= 0 ? posOf(targetIdx) - posOf(grabbedIdx) : 0

  // ⛔ THE CARRIED CLIPS MOVE BY WHAT THE GRABBED CLIP ACTUALLY DID, NOT BY WHAT
  // HE ASKED FOR. This is the drag he has reported over and over.
  //
  // `deltaS` is the RAW request. The grabbed clip then gets clamped twice before
  // it lands: once so the whole linked group stays legal, and again by
  // `nearestFreeStart` so it stops against its neighbour instead of eating it.
  // So the clip under his cursor routinely travels LESS than he asked. Every
  // other selected clip was still being shifted by the full `deltaS`.
  //
  // What that looks like on his timeline: he grabs one caption, it stops dead
  // against the next clip, and the rest of the selection sails on past it. The
  // one thing that does not follow the mouse is the one he is holding, which is
  // his words exactly: *"it just doesn't drag the thing I click on in the first
  // place."* On a packed caption track, where every clip has a neighbour a few
  // frames away, this fires on almost every multi-clip drag.
  //
  // The applied delta also makes the fully-blocked case correct for free: if the
  // grabbed clip could not move at all, nothing else moves either, instead of
  // the selection tearing itself apart around a clip that stayed put.
  const appliedS = safeS - grabbed.startS
  if (laneShift === 0 && appliedS === 0) return next
  // ⛔ AND FROM startS0, THE POSITION AT MOUSE-DOWN, not from wherever the clip
  // sits in `next`. The grabbed clip's own move has already rewritten this
  // sequence, and reading a live start would compound the shift on any clip that
  // placement had nudged.
  const ordered = [...others].sort((a, b) => (appliedS > 0 ? b.startS0 - a.startS0 : a.startS0 - b.startS0))
  for (const o of ordered) {
    const trIdx = next.tracks.findIndex((t) => t.clips.some((c) => c.id === o.id))
    const tr = next.tracks[trIdx]
    const oc = tr?.clips.find((c) => c.id === o.id)
    if (!tr || !oc) continue
    // Same kind: shift by the same number of lanes, clamped to the ones that
    // exist. Clamping per clip rather than refusing the whole move means the
    // gesture always does SOMETHING; two clips can land on one lane at the
    // very edge of the stack, which beats the selection silently splitting up.
    let destTrackId = tr.id
    if (tr.kind === kind && laneShift !== 0) {
      const p = posOf(trIdx)
      if (p >= 0) {
        const want = Math.max(0, Math.min(lanes.length - 1, p + laneShift))
        destTrackId = next.tracks[lanes[want].i]?.id ?? tr.id
      }
    }
    // ⛔ EVERY CARRIED CLIP ANSWERS THE SAME QUESTION THE GRABBED ONE DOES, and
    // this line is the bug he reported twice.
    //
    // 2026-08-05 and again 2026-08-12: *"When I fucking drag, it drags the audio
    // with the video clip to and other the way around."* It was hunted twice from
    // a SINGLE clip and could never be reproduced, because a single clip is the
    // one case that was already right: `solo` above stops the grabbed clip taking
    // its partner. This loop then moved every OTHER selected clip with
    // `moveGroup`, unconditionally, which drags each of their partners along
    // whether or not he ever selected them.
    //
    // So one gesture obeyed two different rules: the clip under his cursor left
    // its audio alone and the rest of the selection did not. Select three video
    // clips, drag one, and three audio clips move that he never touched.
    //
    // The rule is the one `soloMove` states in Timeline.tsx: a partner travels
    // only when it is selected too. The caller answers it per clip, because only
    // the caller knows the selection and this file stays pure.
    next = o.solo
      ? moveClip(next, o.id, destTrackId, Math.max(0, o.startS0 + appliedS))
      : moveGroup(next, o.id, destTrackId, Math.max(0, o.startS0 + appliedS))
  }
  return next
}
