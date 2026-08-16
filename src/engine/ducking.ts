// Auto-duck: music sits down whenever the voiceover speaks. Tracks opt in via
// Track.audioRole: 'voice' drives the duck, 'music' receives it. ONE pure
// envelope builder feeds all three audio consumers (live preview, offline
// export render, pure worker mixer), so preview == export by construction and
// the pure mixer stays byte-deterministic. Pure: no WebAudio, no store.

// Only a TYPE import from audio.ts, because audio.ts imports this module at runtime,
// and a runtime cycle here would be a footgun waiting for a bundler change.
import type { GainPoint } from './audio'
import type { Sequence, Track } from './types'

/** How far the music drops while the voice is speaking. */
export const DUCK_DB = -8
const DUCK_GAIN = 10 ** (DUCK_DB / 20)
/** Ramp down starts this long BEFORE the voice so its first word is clear. */
export const DUCK_ATTACK_S = 0.15
/** Ramp back up over this long after the voice stops. */
export const DUCK_RELEASE_S = 0.35

interface WindowS {
  startS: number
  endS: number
}

/**
 * Timeline windows (absolute seconds) where an audible voice-role track has an
 * enabled clip. Windows whose surrounding ramps would touch are merged, so the
 * music holds its ducked level through breaths instead of pumping.
 */
export function voiceWindows(tracks: readonly Track[], soloActive: boolean): WindowS[] {
  const windows: WindowS[] = []
  for (const track of tracks) {
    if (track.audioRole !== 'voice') continue
    if (soloActive ? !track.solo : track.muted) continue
    for (const clip of track.clips) {
      if (!clip.enabled || clip.speed === 0) continue
      const durS = (clip.outS - clip.inS) / Math.abs(clip.speed)
      if (durS <= 0) continue
      windows.push({ startS: clip.startS, endS: clip.startS + durS })
    }
  }
  windows.sort((a, b) => a.startS - b.startS)

  const merged: WindowS[] = []
  for (const w of windows) {
    const last = merged[merged.length - 1]
    if (last && w.startS - DUCK_ATTACK_S <= last.endS + DUCK_RELEASE_S) {
      last.endS = Math.max(last.endS, w.endS)
    } else {
      merged.push({ ...w })
    }
  }
  return merged
}

/** Piecewise-linear value of the duck envelope at absolute time t. */
function duckValueAt(windows: readonly WindowS[], t: number): number {
  const duck = DUCK_GAIN
  for (const w of windows) {
    if (t < w.startS - DUCK_ATTACK_S) break
    if (t < w.startS) return 1 + ((duck - 1) * (t - (w.startS - DUCK_ATTACK_S))) / DUCK_ATTACK_S
    if (t <= w.endS) return duck
    if (t < w.endS + DUCK_RELEASE_S) return duck + ((1 - duck) * (t - w.endS)) / DUCK_RELEASE_S
  }
  return 1
}

/**
 * The gain automation a music track plays under the current voiceover, as
 * GainPoints relative to fromS (the same convention as clipGainEnvelope).
 * Always starts with a point at offset 0 carrying the mid-envelope value, so
 * consumers never have to reason about knots scheduled in the past. Returns
 * null when nothing ducks (no voice content at all).
 */
export function duckEnvelope(
  tracks: readonly Track[],
  soloActive: boolean,
  fromS: number,
): GainPoint[] | null {
  const windows = voiceWindows(tracks, soloActive)
  if (windows.length === 0) return null
  const duck = DUCK_GAIN

  const points: GainPoint[] = [{ offsetS: 0, value: duckValueAt(windows, fromS) }]
  for (const w of windows) {
    const knots = [
      { t: w.startS - DUCK_ATTACK_S, value: 1 },
      { t: w.startS, value: duck },
      { t: w.endS, value: duck },
      { t: w.endS + DUCK_RELEASE_S, value: 1 },
    ]
    for (const k of knots) {
      if (k.t > fromS) points.push({ offsetS: k.t - fromS, value: k.value })
    }
  }
  points.sort((a, b) => a.offsetS - b.offsetS)
  return points
}

/** True when this sequence has any music track that would duck right now. */
export function duckingActive(seq: Sequence): boolean {
  const soloActive = seq.tracks.some((t) => t.solo)
  if (!seq.tracks.some((t) => t.audioRole === 'music' && (soloActive ? t.solo : !t.muted))) return false
  return voiceWindows(seq.tracks, soloActive).length > 0
}
