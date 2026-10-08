// Wires the engine Transport (audio-master clock) to the store. The single
// place Space / J / K / L and the transport buttons act through.

import { scheduleAudio } from '../engine/audio'
import { diagnoseSilence, type SilenceFix } from '../engine/audioSilence'
import { Transport, type HeardSpan } from '../engine/playback'
import {
  forgetPlayedFrame,
  lastPlayedFrameS,
  pauseAllPreviewVideos,
  setPreviewTransportRate,
} from '../engine/preview'
import { lastFrameS } from '../engine/timecode'
import { activeSequence } from '../engine/types'
import { workArea } from '../engine/workArea'
import { isTakeInProgress, pauseRecording, resumeRecording, takeHeard } from './voiceRecorder'
import { useToasts } from './toasts'
import { updateActiveSequence, useStore } from './store'

/**
 * ⛔ SILENCE HAS TO SAY WHY, 2026-08-24. He reported the audio simply not
 * working, and there was no regression to find: a left-over solo, or every
 * track muted, turns the sound off completely while the picture, the transport
 * and the meter all look exactly as they do when it works. Nothing said a word.
 *
 * The rule lives in `engine/audioSilence.ts` so it can be tested without an
 * AudioContext; this is only the part that speaks and the one-click way out.
 * Said at most once per distinct cause, so a loop cannot nag him.
 */
let lastSilenceKey = ''

function clearSilence(fix: SilenceFix): void {
  updateActiveSequence(fix === 'unsolo' ? 'Turn solo off' : 'Unmute every track', (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) => (fix === 'unsolo' ? { ...t, solo: false } : { ...t, muted: false })),
  }))
}

function warnIfSilent(): void {
  const found = diagnoseSilence(activeSequence(useStore.getState().project).tracks)
  if (!found) {
    lastSilenceKey = ''
    return
  }
  if (found.key === lastSilenceKey) return
  lastSilenceKey = found.key
  const fix = found.fix
  useToasts
    .getState()
    .show(
      found.message,
      'info',
      fix ? { label: fix === 'unsolo' ? 'Turn solo off' : 'Unmute', onClick: () => clearSilence(fix) } : undefined,
    )
}

// Current shuttle rate, published only on state CHANGE (never per tick) so the
// transport badge can subscribe imperatively without any per-frame React.
let shuttleRate = 0
const rateSubs = new Set<(rate: number) => void>()
export function subscribeShuttleRate(cb: (rate: number) => void): () => void {
  rateSubs.add(cb)
  cb(shuttleRate)
  return () => rateSubs.delete(cb)
}

/**
 * Where the last pause REALLY stopped, and the frame the playhead was put on.
 *
 * ⛔ A PAUSE LEFT THE PLAYHEAD BETWEEN TWO FRAMES (2026-10-06). Playing draws
 * the frame the playhead is in (Monitor.tsx floors it, like the export), and a
 * paused playhead draws the NEAREST frame, so about half of all pauses stepped
 * the picture on by one, and the readout disagreed with the picture. So a pause
 * puts the playhead on the frame that was on screen. The exact time is kept,
 * and a take being recorded resumes from it while the playhead has not been
 * moved, because a dub resumed from the frame would replay a stretch he already
 * heard (MIC-5).
 */
let stoppedAt: { exactS: number; frameS: number } | null = null

/**
 * Where play should start from the playhead.
 *
 * ⛔ EVERY RESUME SKIPPED THE PICTURE FORWARD BY THE OUTPUT LATENCY (sweep
 * review B1, 2026-10-08). The exact stop is the SOUND clock, and the frame on
 * screen is that less the latency (PB-8): 41 ms on his default output, 2 to 3
 * frames at 60 fps skipped on every Space, and Space-Space crept forward by that
 * each tap; 0.3 s on Bluetooth. So the exact stop is for a take only, the one
 * thing that must not replay what he heard. Everything else, Space and J/L, goes
 * on from the frame he is looking at.
 */
function resumeFrom(playheadS: number): number {
  if (!stoppedAt || Math.abs(playheadS - stoppedAt.frameS) >= 1e-9) return playheadS
  return isTakeInProgress() ? stoppedAt.exactS : playheadS
}

/**
 * Where Space plays from. At the end it starts over from the top (Premiere
 * behavior), and the end is the LAST FRAME as well as the end itself: play that
 * runs out parks there (onPaused), and so does End.
 */
function playFrom(playheadS: number, endS: number, fps: number): number {
  const from = resumeFrom(playheadS)
  return from >= endS - 1e-6 || playheadS >= lastFrameS(endS, fps) - 1e-6 ? 0 : from
}

const transport = new Transport({
  getEndS: () => activeSequence(useStore.getState().project).durationS,
  onTick: (t) => useStore.getState().setUI({ playheadS: Math.max(0, t) }),
  onPaused: (exactS, ranOut) => {
    const s = useStore.getState()
    const seq = activeSequence(s.project)
    const fps = seq.fps || 30
    // Play ran off the end: the last real frame, never the end itself, where
    // nothing resolves and the monitor goes black (PB-17). Space starts over
    // from there (playFrom). Only play that RAN OUT: the sound reaches the end
    // before the picture does (PB-8), so a pause in the last stretch has a stop
    // time at the end too, and is a pause on the frame he is looking at, which
    // the next Space resumes from (sweep review S2). J that ran back to the
    // start: the start.
    // Otherwise the frame on screen is the one the monitor LAST DREW
    // (lastPlayedFrameS), not the one the live clock has reached since; a tick
    // the monitor did not draw (its redraw cap, a frame still decoding) leaves
    // the store ahead of the picture. Before the monitor has drawn anything this
    // run (no canvas, or a pause on the very first frame), the frame the last
    // tick is in.
    const frameS =
      ranOut && seq.durationS > 0
        ? lastFrameS(seq.durationS, fps)
        : exactS <= 0
          ? 0
          : (lastPlayedFrameS() ?? Math.floor(Math.max(0, s.ui.playheadS) * fps + 1e-6) / fps)
    stoppedAt = { exactS: Math.max(0, exactS), frameS }
    s.setUI({ playheadS: frameS })
  },
  onStateChange: (playing, rate) => {
    useStore.getState().setUI({ playing })
    if (playing) forgetPlayedFrame()
    else pauseAllPreviewVideos()
    // Dubbing: a take in progress follows the transport. Pausing the preview
    // (Space, K, the transport button, or hitting the end) holds the take;
    // resuming resumes it. The mic itself never stops (voiceRecorder,
    // pauseRecording): what keeps the voiceover in sync is onHeard below, and
    // the paused span is simply not placed. No-op when nothing is recording.
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
  // Every stretch of the timeline he hears, so a take recorded against it lands
  // where he performed it (MIC-4, MIC-5). The recorder ignores it between takes.
  onHeard: (span, endedAtMs, why) => takeHeard(span, endedAtMs, why),
  schedule: (fromS) => {
    // A scrub grain still ringing would sound over the top of the transport, so
    // the two are never alive at once. Cheap and idempotent.
    const { project } = useStore.getState()
    // Before the graph is built, not after: if the mix cannot make a sound, he
    // hears the same nothing either way and the only difference is whether the
    // app told him which switch is doing it.
    warnIfSilent()
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
  const seq = activeSequence(s.project)
  if (seq.durationS <= 0) return
  void transport.play(playFrom(s.ui.playheadS, seq.durationS, seq.fps), 1)
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
  const seq = activeSequence(s.project)
  if (seq.durationS <= 0) return
  void transport.play(playFrom(s.ui.playheadS, seq.durationS, seq.fps), 1)
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
  const fromS = transport.playing ? transport.currentTime() : resumeFrom(s.ui.playheadS)
  void transport.play(fromS, dir * magnitude)
}

export const isPlaying = (): boolean => transport.playing

/**
 * The clock's tick for the animation frame stamped `now`, before anything
 * draws in it (Transport.tickFrame). The monitor calls it first in its draw.
 */
export const tickPlaybackFrame = (now: number): void => transport.tickFrame(now)

/** The stretch of the timeline he is hearing right now, for a take started mid-play. */
export const currentHeardSpan = (): HeardSpan | null => transport.heardSpan

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
// ⛔ EVERY TRACK SETTING THE GRAPH BAKES IN HAS TO BE NAMED HERE. The audio
// graph reads the track object once, when it is scheduled, so a setting missing
// from this line simply does nothing until he stops and starts again. Auto Level
// and Audio Role sit in the same panel as mute, solo, volume and pan and were
// both missing: turning one on mid-play changed nothing he could hear, which
// reads as the control being broken. Same defect the note above describes for
// mute, left half closed.
const mixFingerprint = (): string => {
  const seq = activeSequence(useStore.getState().project)
  return seq.tracks.map((t) => `${t.id}:${t.muted ? 1 : 0}${t.solo ? 1 : 0}:${t.volumeDb ?? 0}:${t.pan ?? 0}:${t.autoLevel ?? 0}:${t.audioRole ?? 0}`).join('|')
}

let lastMix = ''
useStore.subscribe(() => {
  const now = mixFingerprint()
  if (now === lastMix) return
  lastMix = now
  if (transport.playing) transport.rescheduleAudio()
})
