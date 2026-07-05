// Pure timeline engine: clip math, placement, trim/split/delete, snapping.
// No React, no DOM, no store — only types. Every function takes and returns
// immutable data; when nothing changes the input reference comes back as-is.

import {
  defaultTransform,
  newId,
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

export function collectSnapPoints(
  seq: Sequence,
  opts?: { excludeClipId?: Id; playheadS?: number },
): number[] {
  const points = new Set<number>([0])
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      if (clip.id === opts?.excludeClipId) continue
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
    const clip: Clip = {
      ...body,
      id: newId(),
      startS: resolveStart(track, atS + item.offsetS, durS),
      effects: body.effects.map((e) => ({ ...e, id: newId() })),
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
