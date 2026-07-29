// Store helpers for the audio-mixer track controls (Phase 6). Each call is one
// undo step; the Fader/pan controls commit on release, so a drag is not a flood.

import { recomputeDuration } from '../engine/timeline'
import { activeSequence, audioTracks, videoTracks, type AutoLevel, type Id, type Track } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

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

/**
 * Delete a whole track and everything on it, in ONE undo step.
 *
 * Refuses in exactly two cases, both of which would leave him worse off than
 * before he clicked: a LOCKED track (locked means hands off, same as every
 * other edit), and the LAST track of its kind (a sequence with no video track
 * has nowhere to drop the next clip, and nothing in the UI offers a way back).
 * Everything else goes, because the undo step is the safety net.
 */
export function deleteTrack(trackId: Id): void {
  // updateActiveSequence only ever edits the active sequence, so that is the
  // only one a header can be showing.
  const seq = activeSequence(useStore.getState().project)
  const track = seq.tracks.find((t) => t.id === trackId)
  if (!track) return
  if (track.locked) {
    useToasts.getState().show('Track is locked', 'danger')
    return
  }
  const siblings = track.kind === 'audio' ? audioTracks(seq) : videoTracks(seq)
  if (siblings.length <= 1) {
    useToasts.getState().show(`Cannot delete the last ${track.kind} track`, 'danger')
    return
  }
  const n = track.clips.length
  updateActiveSequence(`Delete ${track.name}`, (sq) => {
    if (!sq.tracks.some((t) => t.id === trackId)) return sq
    return recomputeDuration({ ...sq, tracks: sq.tracks.filter((t) => t.id !== trackId) })
  })
  // Drop anything that was selected ON the dead track, or the Inspector keeps
  // showing a clip that no longer exists anywhere.
  const gone = new Set(track.clips.map((c) => c.id))
  const ui = useStore.getState().ui
  const kept = ui.selection.filter((id) => !gone.has(id))
  if (kept.length !== ui.selection.length) useStore.getState().setUI({ selection: kept })
  useToasts.getState().show(n === 0 ? `${track.name} deleted` : `${track.name} and ${n} clip${n === 1 ? '' : 's'} deleted`)
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

/** Auto-duck opt-in: 'voice' drives the duck, 'music' receives it (engine/ducking.ts). */
export function setTrackAudioRole(trackId: Id, role: Track['audioRole']): void {
  mapTrack(trackId, 'Set audio role', (t) => {
    if (t.audioRole === role) return t
    const next = { ...t }
    if (role === undefined) delete next.audioRole
    else next.audioRole = role
    return next
  })
}
