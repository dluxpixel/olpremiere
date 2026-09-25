import { collectSnapPoints, snapTime } from '../engine/timeline'
import { audioTracks, type Sequence, type Track } from '../engine/types'
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
