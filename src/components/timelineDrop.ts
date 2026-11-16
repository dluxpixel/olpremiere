import {
  addClipFromAsset,
  addClipWithLinkedAudio,
  clipDurationS,
  collectSnapPoints,
  resolveStart,
  snapTime,
} from '../engine/timeline'
import { audioTracks, videoTracks, type Id, type MediaAsset, type Sequence, type Track } from '../engine/types'
import { ASSET_MIME, SFX_MIME, TITLE_MIME } from '../state/dnd'
import { SNAP_PX } from './timelineGeometry'

/** What a drag from the bins carries, read off its dataTransfer types. */
export function dropKinds(types: readonly string[]): { isAsset: boolean; isSfx: boolean; isTitle: boolean } {
  return {
    isAsset: types.includes(ASSET_MIME),
    isSfx: types.includes(SFX_MIME),
    isTitle: types.includes(TITLE_MIME),
  }
}

/** Whether the hovered lane can take the drop: a sound needs an audio lane, a title a video lane. */
export const laneTakesDrop = (lane: Track | null, isSfx: boolean, isTitle: boolean): lane is Track =>
  !(!lane || (isSfx && lane.kind !== 'audio') || (isTitle && lane.kind !== 'video'))

/** The drop time, snapped to every edge, marker and the playhead when snapping is on. */
export function snappedDropTime(tRaw: number, seq: Sequence, snapping: boolean, playheadS: number, pxPerS: number): number {
  const points = snapping ? collectSnapPoints(seq, { playheadS }) : []
  return snapping ? snapTime(tRaw, points, SNAP_PX / pxPerS).t : tRaw
}

// A dragged SFX lands on the hovered audio lane at the drop time.
export const sfxDropTrack = (lane: Track | null, seq: Sequence): Track | undefined =>
  lane?.kind === 'audio' && !lane.locked ? lane : audioTracks(seq).find((t) => !t.locked)

/** The hovered lane when it is the right kind and unlocked, else the first unlocked lane of that kind. */
export const assetDropTrack = (hovered: Track | null, seq: Sequence, wantKind: 'video' | 'audio'): Track | undefined =>
  hovered && hovered.kind === wantKind && !hovered.locked
    ? hovered
    : seq.tracks.find((t) => t.kind === wantKind && !t.locked)

/** One clip-shaped rectangle of the drop preview: where a drop will land, on which lane, how long. */
export interface DropGhost {
  trackId: Id
  tS: number
  durS: number
  label?: string
}

/**
 * What the lanes draw while a bin drag hovers: the line at the snapped time on
 * the hovered lane, and the ghost clips (none when the length is not known).
 */
export interface DropPreview {
  trackId: Id
  tS: number
  ghosts: DropGhost[]
  /**
   * A clip of the drop lands on a lane that does not exist yet. Its lane is not
   * on screen, so the hovered lane must not draw the plain line for it (that
   * would point at the wrong lane).
   */
  makesLane?: boolean
}

/** The ghosts of an insert, and whether any of its clips lands on a lane the insert makes. */
export interface InsertPreview {
  ghosts: DropGhost[]
  makesLane: boolean
}

/**
 * The ONE insert a bin drop runs, for the drop and for its ghost alike.
 *
 * A video with sound splits its audio to a linked clip on the first unlocked
 * audio lane. Exactly when he dropped it, and never on top of anything: a lane
 * that is taken there passes it to the next free line (his pick, 2026-09-28: a
 * finished recording dropped on V4 used to delete what V4 had under it). Pure:
 * the sequence handed in is not changed, so the ghost can run it for nothing.
 */
export function insertDroppedAsset(
  seq: Sequence,
  asset: MediaAsset,
  target: Track,
  tS: number,
): { seq: Sequence; clipIds: Id[] } {
  if (asset.kind === 'video' && asset.hasAudio) {
    const audioTrack = audioTracks(seq).find((tr) => !tr.locked) ?? null
    const r = addClipWithLinkedAudio(seq, target.id, audioTrack?.id ?? null, asset, tS, { exact: true })
    return { seq: r.seq, clipIds: [r.videoClipId, r.audioClipId].filter(Boolean) }
  }
  const r = addClipFromAsset(seq, target.id, asset, tS, { exact: true })
  return { seq: r.seq, clipIds: r.clipId ? [r.clipId] : [] }
}

/**
 * The ghosts for the clips an insert made: each one's lane, start and length as
 * the insert actually left them. A clip on a lane the insert had to MAKE (every
 * line of its kind was taken) has no lane on screen to draw in, so it has no
 * ghost, and `makesLane` says so (the hovered lane then draws no line either).
 */
function ghostsOfInsert(before: Sequence, after: Sequence, clipIds: Id[], label: string): InsertPreview {
  const ghosts: DropGhost[] = []
  let makesLane = false
  for (const id of clipIds) {
    const track = after.tracks.find((t) => t.clips.some((c) => c.id === id))
    const clip = track?.clips.find((c) => c.id === id)
    if (!track || !clip) continue
    if (!before.tracks.some((t) => t.id === track.id)) {
      makesLane = true
      continue
    }
    ghosts.push({ trackId: track.id, tS: clip.startS, durS: clipDurationS(clip), ...(label ? { label } : {}) })
  }
  return { ghosts, makesLane }
}

const NO_PREVIEW: InsertPreview = { ghosts: [], makesLane: false }

/** The ghosts of a bin or Library drop, and whether it makes a lane, from the same lane choice and insert the drop uses. */
export function assetDropPreview(seq: Sequence, asset: MediaAsset, hovered: Track | null, tS: number): InsertPreview {
  const target = assetDropTrack(hovered, seq, asset.kind === 'audio' ? 'audio' : 'video')
  if (!target) return NO_PREVIEW
  const r = insertDroppedAsset(seq, asset, target, tS)
  return ghostsOfInsert(seq, r.seq, r.clipIds, asset.name)
}

/** The ghosts of a bin or Library drop, from the same lane choice and insert the drop uses. */
export const assetDropGhosts = (seq: Sequence, asset: MediaAsset, hovered: Track | null, tS: number): DropGhost[] =>
  assetDropPreview(seq, asset, hovered, tS).ghosts

/** The ghost of a dropped sound (and whether it makes a lane): the lane and nudge the sound inserter gives it (not `exact`, like it). */
export function sfxDropPreview(seq: Sequence, asset: MediaAsset, hovered: Track | null, tS: number): InsertPreview {
  const target = sfxDropTrack(hovered, seq)
  if (!target) return NO_PREVIEW
  const r = addClipFromAsset(seq, target.id, asset, tS)
  return ghostsOfInsert(seq, r.seq, r.clipId ? [r.clipId] : [], asset.name)
}

/** The ghost of a dropped sound: the lane and nudge the sound inserter gives it (not `exact`, like it). */
export const sfxDropGhosts = (seq: Sequence, asset: MediaAsset, hovered: Track | null, tS: number): DropGhost[] =>
  sfxDropPreview(seq, asset, hovered, tS).ghosts

/** Where every title goes: the topmost unlocked video lane (titles overlay footage below them). */
export const titleDropTrack = (seq: Sequence): Track | undefined => [...videoTracks(seq)].reverse().find((t) => !t.locked)

/** The ghost of a dropped title: its shelf length on the title lane, nudged to a gap like the title insert. */
export function titleDropGhosts(seq: Sequence, durS: number, label: string, tS: number): DropGhost[] {
  const target = titleDropTrack(seq)
  if (!target) return []
  return [{ trackId: target.id, tS: resolveStart(target, tS, durS), durS, label }]
}
