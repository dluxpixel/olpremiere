// Store helpers for the audio-mixer track controls (Phase 6). Each call is one
// undo step; the Fader/pan controls commit on release, so a drag is not a flood.

import type { AutoLevel, Id, Track } from '../engine/types'
import { updateActiveSequence } from './store'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

function mapTrack(trackId: Id, label: string, fn: (t: Track) => Track): void {
  updateActiveSequence(label, (seq) => {
    const idx = seq.tracks.findIndex((t) => t.id === trackId)
    if (idx < 0) return seq
    const next = fn(seq.tracks[idx])
    if (next === seq.tracks[idx]) return seq
    const tracks = seq.tracks.slice()
    tracks[idx] = next
    return { ...seq, tracks }
  })
}

export function setTrackVolumeDb(trackId: Id, db: number): void {
  const v = clamp(db, -60, 12)
  mapTrack(trackId, 'Set track volume', (t) => (t.volumeDb === v ? t : { ...t, volumeDb: v }))
}

export function setTrackPan(trackId: Id, pan: number): void {
  const v = clamp(pan, -1, 1)
  mapTrack(trackId, 'Set track pan', (t) => (t.pan === v ? t : { ...t, pan: v }))
}

export function setTrackAutoLevel(trackId: Id, level: AutoLevel): void {
  mapTrack(trackId, 'Set auto-level', (t) => (t.autoLevel ?? 'off') === level ? t : { ...t, autoLevel: level })
}
