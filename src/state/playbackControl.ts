// Wires the engine Transport (audio-master clock) to the store. The single
// place Space / J / K / L and the transport buttons act through.

import { scheduleAudio } from '../engine/audio'
import { Transport } from '../engine/playback'
import { pauseAllPreviewVideos, setPreviewTransportRate } from '../engine/preview'
import { activeSequence } from '../engine/types'
import { workArea } from '../engine/workArea'
import { isTakeInProgress, pauseRecording, resumeRecording } from './voiceRecorder'
import { useStore } from './store'

// Current shuttle rate, published only on state CHANGE (never per tick) so the
// transport badge can subscribe imperatively without any per-frame React.
let shuttleRate = 0
const rateSubs = new Set<(rate: number) => void>()
export function subscribeShuttleRate(cb: (rate: number) => void): () => void {
  rateSubs.add(cb)
  cb(shuttleRate)
  return () => rateSubs.delete(cb)
}

const transport = new Transport({
  getEndS: () => activeSequence(useStore.getState().project).durationS,
  onTick: (t) => useStore.getState().setUI({ playheadS: Math.max(0, t) }),
  onStateChange: (playing, rate) => {
    useStore.getState().setUI({ playing })
    if (!playing) pauseAllPreviewVideos()
    // Dubbing: a take in progress follows the transport. Pausing the preview
    // (Space, K, the transport button, or hitting the end) pauses the recorder;
    // resuming resumes it, so a to-picture voiceover stays in sync and the
    // paused span is dropped from the take. No-op when nothing is recording.
    if (isTakeInProgress()) {
      if (playing) resumeRecording()
      else pauseRecording()
    }
    const next = playing ? rate : 0
    // The preview needs the transport rate to keep the picture advancing as fast
    // as the compositor samples it (J/L shuttle). Pushed, not pulled: this module
    // already imports preview, so the reverse would be a cycle.
    setPreviewTransportRate(playing ? rate : 1)
    if (next !== shuttleRate) {
      shuttleRate = next
      for (const cb of rateSubs) cb(next)
    }
  },
  schedule: (fromS) => {
    // A scrub grain still ringing would sound over the top of the transport, so
    // the two are never alive at once. Cheap and idempotent.
    const { project } = useStore.getState()
    return scheduleAudio(activeSequence(project), project.assets, fromS)
  },
  // Loop toggle: the in/out range when set, else the whole sequence.
  getLoopRange: () => {
    const s = useStore.getState()
    if (!s.ui.loop) return null
    const seq = activeSequence(s.project)
    const wa = workArea(seq)
    return wa.active ? { startS: wa.startS, endS: wa.endS } : { startS: 0, endS: seq.durationS }
  },
})

/** "/" and the transport Repeat button. */
export function toggleLoop(): void {
  const s = useStore.getState()
  s.setUI({ loop: !s.ui.loop })
}

export function togglePlay(): void {
  if (transport.playing) {
    transport.pause()
    return
  }
  const s = useStore.getState()
  const endS = activeSequence(s.project).durationS
  if (endS <= 0) return
  // At the end, Space restarts from the top (Premiere behavior).
  const fromS = s.ui.playheadS >= endS - 1e-6 ? 0 : s.ui.playheadS
  void transport.play(fromS, 1)
}

export function pausePlayback(): void {
  if (transport.playing) transport.pause()
}

/**
 * Start playback from the playhead if it isn't already playing. Used so hitting
 * Record rolls the preview for a to-picture voiceover (dub), without toggling
 * off a preview the user had already started.
 */
export function ensurePlaying(): void {
  if (transport.playing) return
  const s = useStore.getState()
  const endS = activeSequence(s.project).durationS
  if (endS <= 0) return
  const fromS = s.ui.playheadS >= endS - 1e-6 ? 0 : s.ui.playheadS
  void transport.play(fromS, 1)
}

const SHUTTLE_RATES = [1, 2, 4]

/** J (dir -1) / L (dir +1): repeat presses in the same direction speed up. */
export function shuttle(dir: -1 | 1): void {
  const s = useStore.getState()
  const endS = activeSequence(s.project).durationS
  if (endS <= 0) return
  let magnitude = 1
  if (transport.playing && Math.sign(transport.rate) === dir) {
    const idx = SHUTTLE_RATES.indexOf(Math.abs(transport.rate))
    magnitude = SHUTTLE_RATES[Math.min(idx + 1, SHUTTLE_RATES.length - 1)] ?? 1
  }
  const fromS = transport.playing ? transport.currentTime() : s.ui.playheadS
  void transport.play(fromS, dir * magnitude)
}

export const isPlaying = (): boolean => transport.playing

/**
 * Keep the SOUND honest while the mix is edited mid-playback.
 *
 * The audio graph is built once when play() starts, from each track's mute,
 * solo, volume and pan as they were at that instant, baked into node settings.
 * Change any of them while it is running and nothing happens until playback
 * stops or loops: muting a track kept it audible, which reads as the mute
 * button simply not working.
 *
 * A cheap fingerprint of the mix is compared on every store change. When it
 * moves AND we are playing, the audio is rebuilt in place. Rebuilding costs a
 * scheduling latency of silence, which is why it is gated on the fingerprint
 * rather than run on every store write: an ordinary timeline edit must not make
 * the sound stutter.
 */
const mixFingerprint = (): string => {
  const seq = activeSequence(useStore.getState().project)
  return seq.tracks.map((t) => `${t.id}:${t.muted ? 1 : 0}${t.solo ? 1 : 0}:${t.volumeDb ?? 0}:${t.pan ?? 0}`).join('|')
}

let lastMix = ''
useStore.subscribe(() => {
  const now = mixFingerprint()
  if (now === lastMix) return
  lastMix = now
  if (transport.playing) transport.rescheduleAudio()
})
