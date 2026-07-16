// One-gesture Jettism motion: punch-in / impact at the playhead, whip across
// a cut, speed-ramp the work area. Each action is ONE dispatch (one undo step)
// over the pure builders in engine/motion.ts.

import { getAudioBuffer } from '../engine/audio'
import { detectOnsets } from '../engine/beats'
import { impactClip, punchInClip, rampSpeedRange, whipClips } from '../engine/motion'
import { clipEndS } from '../engine/timeline'
import { activeSequence, newId, videoTracks, type Clip, type Sequence, type Track } from '../engine/types'
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

/** The workhorse zoom, at the playhead on this clip. Depth = the chosen punch depth. */
export function punchInAtPlayhead(clipId: string, targetScale?: number): void {
  const g = guarded(clipId)
  if (!g) return
  const atS = useStore.getState().ui.playheadS
  if (atS <= g.clip.startS || atS >= clipEndS(g.clip)) {
    useToasts.getState().show('Put the playhead inside the clip first', 'danger')
    return
  }
  const depth = targetScale ?? useStore.getState().ui.punchDepth
  mapOne('Punch in', clipId, (c, sq) => punchInClip(c, sq.fps, { atS, targetScale: depth }))
}

/** Punch in toward a point (monitor right-click: the zoom centers on it). */
export function punchInAtPoint(clipId: string, focal: { x: number; y: number }): void {
  const g = guarded(clipId)
  if (!g) return
  const atS = useStore.getState().ui.playheadS
  const depth = useStore.getState().ui.punchDepth
  mapOne('Punch in', clipId, (c, sq) =>
    punchInClip(c, sq.fps, { atS, targetScale: depth, focal, seqWidth: sq.width, seqHeight: sq.height }),
  )
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

/** Two punches closer than this would overlap their envelopes and compound. */
const BEAT_PUNCH_GAP_S = 0.8

/**
 * Detect beats/hits in an audio clip and punch the topmost footage clip under
 * each one — the whole run is ONE undo step. Detection is local + pure; only
 * the decode touches WebAudio.
 */
export async function punchOnBeats(audioClipId: string): Promise<void> {
  const g = guarded(audioClipId)
  if (!g) return
  const asset = useStore.getState().project.assets[g.clip.assetId]
  if (!asset?.hasAudio) {
    useToasts.getState().show('Pick an audio clip with sound', 'danger')
    return
  }
  const buffer = await getAudioBuffer(asset)
  if (!buffer) {
    useToasts.getState().show('Could not decode the audio', 'danger')
    return
  }
  // Mono mixdown of the clip's trimmed slice.
  const sr = buffer.sampleRate
  const s0 = Math.max(0, Math.floor(g.clip.inS * sr))
  const s1 = Math.min(buffer.length, Math.ceil(g.clip.outS * sr))
  const mono = new Float32Array(Math.max(0, s1 - s0))
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < mono.length; i++) mono[i] += data[s0 + i] / buffer.numberOfChannels
  }
  const onsets = detectOnsets(mono, sr, { minGapS: BEAT_PUNCH_GAP_S, maxOnsets: 16 })
  if (onsets.length === 0) {
    useToasts.getState().show('No beats found in the clip', 'danger')
    return
  }
  const speed = Math.abs(g.clip.speed) || 1
  const times = onsets.map((t) => g.clip.startS + t / speed)

  let punched = 0
  updateActiveSequence('Punch on beats', (sq) => {
    let next = sq
    for (const t of times) {
      // Topmost enabled FOOTAGE clip under the beat (captions stay still).
      const vids = videoTracks(next)
      for (let i = vids.length - 1; i >= 0; i--) {
        if (vids[i].locked) continue
        const target = vids[i].clips.find((c) => !c.title && c.enabled && t > c.startS && t < clipEndS(c))
        if (!target) continue
        next = {
          ...next,
          tracks: next.tracks.map((tr) =>
            tr.id === vids[i].id
              ? { ...tr, clips: tr.clips.map((c) => (c.id === target.id ? punchInClip(c, sq.fps, { atS: t }) : c)) }
              : tr,
          ),
        }
        punched++
        break
      }
    }
    return punched > 0 ? next : sq
  })
  useToasts
    .getState()
    .show(punched > 0 ? `Punched ${punched} beat(s)` : 'No footage under the beats', punched > 0 ? 'success' : 'danger')
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
