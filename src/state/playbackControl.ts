// Wires the engine Transport (audio-master clock) to the store. The single
// place Space / J / K / L and the transport buttons act through.

import { clipEmitsAudioOn, scheduleAudio } from '../engine/audio'
import { diagnoseSilence, type SilenceFix } from '../engine/audioSilence'
import { Transport, type HeardSpan } from '../engine/playback'
import { pauseAllPreviewVideos, setPreviewTransportRate } from '../engine/preview'
import { activeSequence, type Clip, type Track } from '../engine/types'
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

const transport = new Transport({
  getEndS: () => activeSequence(useStore.getState().project).durationS,
  onTick: (t) => useStore.getState().setUI({ playheadS: Math.max(0, t) }),
  onStateChange: (playing, rate) => {
    useStore.getState().setUI({ playing })
    if (!playing) pauseAllPreviewVideos()
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
  // `follow` comes with a rebuild mid-play: the sound starts where the picture
  // is once it is ready, however long it took to build (SF-1).
  schedule: (fromS, follow) => {
    // A scrub grain still ringing would sound over the top of the transport, so
    // the two are never alive at once. Cheap and idempotent.
    const { project } = useStore.getState()
    // Before the graph is built, not after: if the mix cannot make a sound, he
    // hears the same nothing either way and the only difference is whether the
    // app told him which switch is doing it.
    warnIfSilent()
    const seq = activeSequence(project)
    // What this graph plays, so a clip edit mid-play can tell it is out of date.
    builtSound = soundFingerprint(seq.tracks)
    return scheduleAudio(seq, project.assets, fromS, follow)
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
  if (!transport.playing) return
  // ⛔ A FADER, PAN, MUTE OR SOLO MOVES THE LIVE GRAPH'S OWN GAINS (AU-9). Every
  // one used to rebuild the whole graph, which stopped every source mid-waveform
  // (a click) and left 50 ms and more of nothing. Only a change the graph cannot
  // follow (a track that was silent has to sound, the ducking changed, Auto-level
  // or a role switched) still rebuilds, and that rebuild hands over seamlessly.
  if (transport.setMix(activeSequence(useStore.getState().project).tracks)) warnIfSilent()
  else transport.rescheduleAudio({ seamless: true })
})

/**
 * ⛔ A CLIP EDIT MID-PLAY IS HEARD WHILE IT PLAYS (AU-9). The graph is built from
 * the clips as they were at Play, so a clip's volume, fades, keyframes, noise
 * reduction, trim, or a deleted clip, kept playing the old way until he stopped
 * and started again. Every field the sound is built from is named here, and a
 * change rebuilds the sound once he has stopped dragging for a moment, so a
 * drag does not rebuild it on every step. A picture-only edit changes nothing here.
 */
export const CLIP_EDIT_SETTLE_MS = 200

const clipSoundKey = (c: Clip): string =>
  [
    c.id,
    c.assetId,
    c.startS,
    c.inS,
    c.outS,
    c.speed,
    c.enabled ? 1 : 0,
    c.audioGainDb,
    c.fadeInS,
    c.fadeOutS,
    c.denoise ?? 0,
    c.linkId ?? '',
    c.ownAudioOff ? 1 : 0,
    JSON.stringify(c.keyframes?.volume ?? null),
  ].join(',')

let keyedTracks: readonly Track[] | null = null
let keyedSound = ''
/** What every clip that makes a sound would play, per track. Cached on the tracks themselves. */
function soundFingerprint(tracks: readonly Track[]): string {
  if (tracks === keyedTracks) return keyedSound
  keyedTracks = tracks
  keyedSound = tracks
    .map((t) => `${t.id}[${t.clips.filter((c) => clipEmitsAudioOn(t.kind, c)).map(clipSoundKey).join(';')}]`)
    .join('|')
  return keyedSound
}

/** What the graph playing now was built from, and what the clips were last seen to say. */
let builtSound = ''
let seenSound = ''
let clipEditTimer: ReturnType<typeof setTimeout> | null = null
const soundNow = (): string => soundFingerprint(activeSequence(useStore.getState().project).tracks)
useStore.subscribe(() => {
  if (!transport.playing) return
  // Only a CHANGE re-arms the wait. The playhead writes to the store every frame,
  // and re-arming on each of those would put the rebuild off until he stopped.
  const now = soundNow()
  if (now === seenSound) return
  seenSound = now
  if (now === builtSound) return
  if (clipEditTimer !== null) clearTimeout(clipEditTimer)
  clipEditTimer = setTimeout(() => {
    clipEditTimer = null
    if (transport.playing && soundNow() !== builtSound) transport.rescheduleAudio({ seamless: true })
  }, CLIP_EDIT_SETTLE_MS)
})
