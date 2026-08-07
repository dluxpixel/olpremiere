// One-gesture Jettism motion: punch in / punch out / cut punch at the playhead,
// impact, whip across a cut, speed-ramp the work area. Each action is ONE
// dispatch (one undo step) over the pure builders in engine/motion.ts.

import { getAudioBuffer } from '../engine/audio'
import { detectOnsets } from '../engine/beats'
import { withChannelValue } from '../engine/effects/channels'
import { impactClip, punchInClip, punchOutClip, rampSpeedRange, whipClips } from '../engine/motion'
import { clipEndS, splitGroup } from '../engine/timeline'
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

/** True when the playhead sits inside this clip, which every punch needs. */
function insideClip(clip: Clip, atS: number): boolean {
  return atS > clip.startS && atS < clipEndS(clip)
}

/**
 * The point every punch converges on, in sequence pixels: the persisted zoom
 * anchor scaled up out of normalized frame coords.
 *
 * The focal machinery has always been in punchInClip, but only the monitor
 * right-click ever passed it, so every panel-fired and keyboard punch zoomed at
 * the dead centre of the frame. The default anchor sits above centre at a framed
 * talking head's eye line, and zooming at his face instead of the middle of the
 * picture is most of the difference between his edit and everyone else's.
 */
const focalPoint = (seq: Sequence): { x: number; y: number } => {
  const anchor = useStore.getState().ui.zoomAnchor
  return { x: anchor.x * seq.width, y: anchor.y * seq.height }
}

/** The workhorse zoom, at the playhead on this clip. Depth = the chosen punch depth. */
export function punchInAtPlayhead(clipId: string, targetScale?: number): void {
  const g = guarded(clipId)
  if (!g) return
  const { playheadS: atS, punchDepth, punchRiseFrames } = useStore.getState().ui
  if (!insideClip(g.clip, atS)) {
    useToasts.getState().show('Put the playhead inside the clip first', 'danger')
    return
  }
  const depth = targetScale ?? punchDepth
  mapOne('Punch in', clipId, (c, sq) =>
    punchInClip(c, sq.fps, {
      atS,
      targetScale: depth,
      riseFrames: punchRiseFrames,
      // Arrive and STAY. The old envelope scheduled the frame to slide back on
      // its own, which is why "punch out at any time in the clip" was not
      // something the app could express: punchOutAtPlayhead is that verb now.
      holdToEnd: true,
      focal: focalPoint(sq),
      seqWidth: sq.width,
      seqHeight: sq.height,
    }),
  )
}

/** Punch in toward a point (monitor right-click: the zoom centers on it). */
export function punchInAtPoint(clipId: string, focal: { x: number; y: number }): void {
  const g = guarded(clipId)
  if (!g) return
  const { playheadS: atS, punchDepth, punchRiseFrames } = useStore.getState().ui
  mapOne('Punch in', clipId, (c, sq) =>
    punchInClip(c, sq.fps, {
      atS,
      targetScale: punchDepth,
      riseFrames: punchRiseFrames,
      // Same verb as the panel button, so the same envelope: a punch in holds.
      holdToEnd: true,
      focal,
      seqWidth: sq.width,
      seqHeight: sq.height,
    }),
  )
}

/**
 * The other half of the verb: fall from wherever the frame currently sits back
 * to the clip's own base framing over the same frames and the same curve the
 * rise used, and hold there. This is "punch out at any time in the clip".
 *
 * It passes the SAME focal the punch in converged on, so position lands back on
 * its base too and a punch in followed by a punch out ends exactly where the
 * clip started rather than a few pixels off it.
 */
export function punchOutAtPlayhead(clipId: string): void {
  const g = guarded(clipId)
  if (!g) return
  const { playheadS: atS, punchRiseFrames } = useStore.getState().ui
  if (!insideClip(g.clip, atS)) {
    useToasts.getState().show('Put the playhead inside the clip first', 'danger')
    return
  }
  mapOne('Punch out', clipId, (c, sq) =>
    punchOutClip(c, sq.fps, {
      atS,
      riseFrames: punchRiseFrames,
      focal: focalPoint(sq),
      seqWidth: sq.width,
      seqHeight: sq.height,
    }),
  )
}

/**
 * The hard-cut punch, which is what most YouTube punch-ins actually are: split
 * at the playhead and let the right half simply START bigger. No animation at
 * all, zero frames, no curve to shape afterwards.
 *
 * The cut goes through `splitGroup`, never `splitClipOnly`: a punch is a picture
 * edit he fires without thinking about the audio, and cutting the video alone
 * would leave the linked audio whole, so the two sides desync at every cut he
 * makes this way.
 */
export function cutPunchAtPlayhead(clipId: string): void {
  const g = guarded(clipId)
  if (!g) return
  const { playheadS: atS, punchDepth } = useStore.getState().ui
  if (!insideClip(g.clip, atS)) {
    useToasts.getState().show('Put the playhead inside the clip first', 'danger')
    return
  }
  let landed = false
  updateActiveSequence('Cut punch', (sq) => {
    const next = splitGroup(sq, clipId, atS)
    // splitGroup hands back the SAME sequence when it refuses the cut (a sliver,
    // or a linked partner that cannot take it there), and a right half that was
    // never made must not be invented.
    if (next === sq) return sq
    const found = locate(next, clipId)
    if (!found) return sq
    // The left piece keeps the original id, so the right half is the clip
    // directly after it, the same way splitClipOnly finds its pair.
    const i = found.track.clips.findIndex((c) => c.id === clipId)
    const right = found.track.clips[i + 1]
    if (!right) return sq
    landed = true
    return {
      ...next,
      tracks: next.tracks.map((t) =>
        t.id === found.track.id
          ? {
              ...t,
              clips: t.clips.map((c) => (c.id === right.id ? withChannelValue(c, 'scale', punchDepth) : c)),
            }
          : t,
      ),
    }
  })
  if (!landed) useToasts.getState().show('Too close to a clip edge to cut there', 'danger')
}

/** The phonk impact (desat + blur + punch + shake), at the playhead. */
export function impactAtPlayhead(clipId: string): void {
  const g = guarded(clipId)
  if (!g) return
  const atS = useStore.getState().ui.playheadS
  if (!insideClip(g.clip, atS)) {
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
 * each one. The whole run is ONE undo step. Detection is local + pure; only
 * the decode touches WebAudio.
 *
 * This is the ONE punch that keeps the OLD returning envelope: it calls
 * punchInClip with no holdToEnd, so every hit rises, holds 0.5s and eases back
 * to base over 0.25s. Sixteen non-returning punches would stack, and a ladder
 * that climbs to nonsense is not a beat edit. Deliberate, not an oversight.
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
        const target = vids[i].clips.find((c) => !c.title && c.enabled && insideClip(c, t))
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
