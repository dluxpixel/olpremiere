// One-gesture Jettism motion: punch-in / impact at the playhead, whip across
// a cut, speed-ramp the work area. Each action is ONE dispatch (one undo step)
// over the pure builders in engine/motion.ts.

import { impactClip, punchInClip, rampSpeedRange, whipClips } from '../engine/motion'
import { clipEndS } from '../engine/timeline'
import { activeSequence, newId, type Clip, type Sequence, type Track } from '../engine/types'
import { hasWorkArea, workArea } from '../engine/workArea'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

function locate(seq: Sequence, clipId: string): { track: Track; clip: Clip } | null {
  const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  return track && clip ? { track, clip } : null
}

function guarded(clipId: string): { seq: Sequence; track: Track; clip: Clip } | null {
  const seq = activeSequence(useStore.getState().project)
  const found = locate(seq, clipId)
  if (!found) return null
  if (found.track.locked) {
    useToasts.getState().show('Track is locked', 'danger')
    return null
  }
  return { seq, ...found }
}

const mapOne = (label: string, clipId: string, fn: (clip: Clip, seq: Sequence) => Clip): void =>
  updateActiveSequence(label, (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId)
        ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c, sq) : c)) }
        : t,
    ),
  }))

/** The workhorse zoom, at the playhead on this clip. */
export function punchInAtPlayhead(clipId: string): void {
  const g = guarded(clipId)
  if (!g) return
  const atS = useStore.getState().ui.playheadS
  if (atS <= g.clip.startS || atS >= clipEndS(g.clip)) {
    useToasts.getState().show('Put the playhead inside the clip first', 'danger')
    return
  }
  mapOne('Punch in', clipId, (c, sq) => punchInClip(c, sq.fps, { atS }))
}

/** The phonk impact (desat + blur + punch + shake), at the playhead. */
export function impactAtPlayhead(clipId: string): void {
  const g = guarded(clipId)
  if (!g) return
  const atS = useStore.getState().ui.playheadS
  if (atS <= g.clip.startS || atS >= clipEndS(g.clip)) {
    useToasts.getState().show('Put the playhead inside the clip first', 'danger')
    return
  }
  mapOne('Impact hit', clipId, (c, sq) => impactClip(c, sq.fps, { atS }))
}

/** Whip transition into the adjacent next clip on the same track. */
export function whipToNext(clipId: string): void {
  const g = guarded(clipId)
  if (!g) return
  const idx = g.track.clips.findIndex((c) => c.id === clipId)
  const next = g.track.clips[idx + 1]
  if (!next || Math.abs(clipEndS(g.clip) - next.startS) > 1e-3) {
    useToasts.getState().show('Needs a touching next clip on the same track', 'danger')
    return
  }
  updateActiveSequence('Whip transition', (sq) => {
    const found = locate(sq, clipId)
    if (!found) return sq
    const i = found.track.clips.findIndex((c) => c.id === clipId)
    const b = found.track.clips[i + 1]
    if (!b) return sq
    const whipped = whipClips(found.clip, b, sq.fps, newId)
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === found.track.id
          ? {
              ...t,
              clips: t.clips.map((c) => (c.id === clipId ? whipped.a : c.id === b.id ? whipped.b : c)),
            }
          : t,
      ),
    }
  })
}

/** Speed-ramp the work-area range of this clip (I/O keys set the range). */
export function rampWorkArea(clipId: string, factor: number): void {
  const g = guarded(clipId)
  if (!g) return
  if (!hasWorkArea(g.seq)) {
    useToasts.getState().show('Set an In/Out range first (I / O)', 'danger')
    return
  }
  const wa = workArea(g.seq)
  const lo = Math.max(wa.startS, g.clip.startS)
  const hi = Math.min(wa.endS, clipEndS(g.clip))
  if (hi - lo <= 0) {
    useToasts.getState().show('The In/Out range does not touch this clip', 'danger')
    return
  }
  let middleId: string | null = null
  updateActiveSequence(`Speed ×${factor}`, (sq) => {
    const r = rampSpeedRange(sq, clipId, lo, hi, factor, newId)
    middleId = r.middleId
    return r.seq
  })
  if (middleId) useStore.getState().setUI({ selection: [middleId] })
}
