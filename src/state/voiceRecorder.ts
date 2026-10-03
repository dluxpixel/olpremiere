// Voiceover recorder + studio. A take is NO LONGER dropped straight into the
// bin: it lands in the studio panel for review, where the user keeps it or
// discards it. Kept, it goes through the SAME import pipeline everything else
// uses (probe + persist + waveform) and is placed on the timeline where he
// performed it (takePlacement.ts). The studio also owns a live mic stream so
// the meter, the "hear myself" monitor, and MediaRecorder all tap one capture.
// 100% local. The audio never leaves the machine.

import { create } from 'zustand'
import { getAudioOutputDevice, setAudioOutputDevice } from '../engine/audio'
import type { HeardEnd, HeardSpan } from '../engine/playback'
import { importFiles } from './mediaActions'
import { createMonitorGraph, type MonitorGraph } from './recordingMonitor'
import { useToasts } from './toasts'
import { currentHeardSpan, ensurePlaying, pausePlayback } from './playbackControl'
import { updateActiveSequence, useStore } from './store'
import { CLIP_AMP, readTake } from './takeAudio'
import { placeTakeClips, takeClipSpans, type HeardDuringTake, type TakeTiming } from './takePlacement'
import { beginRestartHold } from './unloadGuard'

/** A captured take held for review before it is kept or thrown away. */
export interface PendingTake {
  /** Object URL for the review player. Revoked on keep/discard. */
  url: string
  blob: Blob
  mime: string
  name: string
  /** Wall-clock length of the take, seconds. */
  durationS: number
  /** What was measured while it was recorded, so a kept take lands where he performed it. */
  timing: TakeTiming
}

interface RecorderState {
  /** The studio panel is open (owns the live mic + monitor graph). */
  studioOpen: boolean
  recording: boolean
  /**
   * The preview is paused mid-take (dubbing with Space). The take is held for
   * the readout and the hint only: the recorder keeps running, and what he says
   * while paused is simply not placed on the timeline (see pauseRecording).
   * `recording` stays true while paused: a take is still in progress.
   */
  paused: boolean
  /** Epoch ms the current take started, for the elapsed readout. Null when idle. */
  startedAt: number | null
  /** A finished take awaiting keep/discard. Null when there is nothing to review. */
  pendingTake: PendingTake | null
  /** A kept take is being read, imported and placed: Keep says "Adding..." until it is done. */
  keeping: boolean
  /** Hear yourself: route the mic to the output while the studio is open. Persisted. */
  monitoring: boolean
  /** Roll the preview when recording starts. Default on. */
  autoPlay: boolean
  /** Live input peak since the last frame, linear (1 = full scale), for the meter. */
  level: number
  /**
   * The clip light: latched on the moment the input reaches -1 dBFS, and off
   * only when he clicks it or starts the next take (MIC-3).
   */
  clipped: boolean
  /** The input really recording, by name, so he can see it ('' when unknown). */
  inputLabel: string
  /** The chosen mic is not connected and the system default is recording instead (MIC-8). */
  inputMissing: boolean
  /** Chosen audio-input `deviceId`, or null for the system default. Persisted. */
  selectedInputId: string | null
  /** The chosen mic's name when it was picked, so a missing one can be named. Persisted. */
  selectedInputLabel: string | null
  /** Chosen audio-OUTPUT `deviceId`, or null for the system default. Persisted. */
  selectedOutputId: string | null
}

/** localStorage keys; survive reloads and projects. (Output lives in engine/audio.) */
const INPUT_KEY = 'olpremiere:recorder:input-device'
const INPUT_LABEL_KEY = 'olpremiere:recorder:input-label'
const MONITOR_KEY = 'olpremiere:recorder:monitor'
// Stored INVERTED: present means he turned the preview off. See setAutoPlay.
const AUTOPLAY_OFF_KEY = 'olpremiere:recorder:autoplay-off'

/** Recorded-audio bitrate for the Opus FALLBACK only. 128 kbps Opus is close to
 * transparent for voice; the browser default is far lower, which is a big part
 * of why raw recordings sound bad. A lossless take has no bitrate to ask for. */
export const RECORDING_BITS_PER_SECOND = 128_000

/** Read a saved string, tolerating environments without localStorage. */
function loadSaved(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function loadFlag(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export const useRecorder = create<RecorderState>(() => ({
  studioOpen: false,
  recording: false,
  paused: false,
  startedAt: null,
  pendingTake: null,
  keeping: false,
  monitoring: loadFlag(MONITOR_KEY),
  autoPlay: !loadFlag(AUTOPLAY_OFF_KEY),
  level: 0,
  clipped: false,
  inputLabel: '',
  inputMissing: false,
  selectedInputId: loadSaved(INPUT_KEY),
  selectedInputLabel: loadSaved(INPUT_LABEL_KEY),
  // Output is app-wide (playback + monitor) and owned/persisted by engine/audio.
  selectedOutputId: getAudioOutputDevice(),
}))

/**
 * The `getUserMedia` audio constraint. Always captures the mic RAW: echo
 * cancellation, auto-gain AND noise suppression all OFF. Every one of those is
 * tuned for a phone/call and mangles a real mic into a pumped, muffled,
 * low-quality mess, the exact complaint. A condenser in a quiet room is best
 * captured pristine; clean-up (if ever wanted) belongs after the take, not baked
 * into the capture. Discord's clean suppression is Krisp: proprietary/licensed, and
 * not something a local browser app can embed, so there is no honest "match
 * Discord" toggle to offer here. A pinned device uses `exact` so we KNOW we
 * captured the mic the user picked; if it's gone `getUserMedia` throws and we
 * fall back loudly rather than record from the wrong device.
 */
/**
 * A live take, or one held for review, blocks an automatic restart until it is
 * kept or thrown away. See beginRestartHold: an update applying itself while he
 * speaks used to swallow the whole take.
 *
 * Driven off the store rather than the start/stop verbs, so a recorder that
 * stops on its own (the mic unplugged) releases the hold too.
 */
let releaseRestartHold: (() => void) | null = null
useRecorder.subscribe((s) => {
  const precious = s.recording || s.pendingTake !== null
  if (precious && !releaseRestartHold) releaseRestartHold = beginRestartHold()
  else if (!precious && releaseRestartHold) {
    releaseRestartHold()
    releaseRestartHold = null
  }
})

export function audioConstraintFor(deviceId: string | null): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48_000,
    channelCount: 1,
  }
  if (deviceId) c.deviceId = { exact: deviceId }
  return c
}

/**
 * The available audio-input devices. Device labels are empty until mic
 * permission has been granted at least once; since the whole point here is to
 * pick a mic, unlock them with a transient stream when they're all blank.
 */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const audioInputs = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  let inputs = await audioInputs()
  if (inputs.length > 0 && inputs.every((d) => d.label === '')) {
    try {
      const unlock = await navigator.mediaDevices.getUserMedia({ audio: true })
      unlock.getTracks().forEach((t) => t.stop())
      inputs = await audioInputs()
    } catch {
      // Permission denied. Return the unlabeled entries; the UI names them generically.
    }
  }
  return inputs
}

/**
 * Choose the recording input (null = system default) and remember it, with its
 * name, so the day it is unplugged the app can say WHICH mic is missing.
 */
export function setInputDevice(deviceId: string | null, label: string | null = null): void {
  const name = deviceId && label ? label : null
  useRecorder.setState({ selectedInputId: deviceId, selectedInputLabel: name })
  try {
    if (typeof localStorage === 'undefined') return
    if (deviceId) localStorage.setItem(INPUT_KEY, deviceId)
    else localStorage.removeItem(INPUT_KEY)
    if (name) localStorage.setItem(INPUT_LABEL_KEY, name)
    else localStorage.removeItem(INPUT_LABEL_KEY)
  } catch {
    // Ignore storage failures (private mode / quota); the in-memory pick still applies.
  }
  // A live studio must re-acquire on the new mic so the meter/monitor follow.
  if (useRecorder.getState().studioOpen) void reacquireMonitor()
}

/**
 * Choose the app OUTPUT device (null = system default). App-wide: it routes BOTH
 * the main playback (engine/audio) AND the live "hear myself" monitor to the same
 * device, and engine/audio persists it, so the user picks their output once.
 */
export function setOutputDevice(deviceId: string | null): void {
  useRecorder.setState({ selectedOutputId: deviceId })
  void setAudioOutputDevice(deviceId) // route + remember app playback
  void monitor?.setOutput(deviceId) // route the live monitor to the same device
}

/**
 * Where the playhead was when the current take began, so a discard can go back.
 * Null once there is nothing to go back to.
 */
let takeStartPlayheadS: number | null = null
/** Did WE roll the preview for this take? Only then do we stop it again. */
let startedPlaybackForTake = false

/**
 * Roll the preview when recording starts. ON unless he turns it off.
 *
 * ⛔ Stored as an OFF flag (`'0'` means off, anything else means on) rather than
 * reusing `loadFlag`, which reads a missing key as false. Every existing install
 * has no key at all, and reading that as "he turned the preview off" would ship
 * the feature already disabled for everyone who has ever run the app.
 */
export function setAutoPlay(on: boolean): void {
  useRecorder.setState({ autoPlay: on })
  try {
    if (typeof localStorage !== 'undefined') {
      if (on) localStorage.removeItem(AUTOPLAY_OFF_KEY)
      else localStorage.setItem(AUTOPLAY_OFF_KEY, '1')
    }
  } catch {
    // Ignore storage failures; the in-memory choice still applies.
  }
}

/** Hear yourself: route the live mic to the output while the studio is open. */
export function setMonitoring(on: boolean): void {
  useRecorder.setState({ monitoring: on })
  try {
    if (typeof localStorage !== 'undefined') {
      if (on) localStorage.setItem(MONITOR_KEY, '1')
      else localStorage.removeItem(MONITOR_KEY)
    }
  } catch {
    // Ignore storage failures; the in-memory choice still applies.
  }
  monitor?.setMonitoring(on)
}

let recorder: MediaRecorder | null = null
let takeCount = 0

// Pause bookkeeping for the current take, for the elapsed readout: it shows the
// time he has actually performed, paused spans excluded. Reset every take.
let pausedAccumMs = 0
let pausedAtMs: number | null = null

/**
 * The stretches of preview he heard during the current take, in order (MIC-4,
 * MIC-5). The transport reports them (takeHeard); the kept take is placed from
 * them. Null when no take is running.
 */
let takeHeardSpans: HeardDuringTake[] | null = null
/** The loudest the live meter saw during this take, for when the take cannot be read back. */
let takeLivePeak = 0

/** Time PERFORMED in the current take, ms: the file runs on through pauses, the readout does not. */
export function takeElapsedMs(): number {
  const { startedAt } = useRecorder.getState()
  if (startedAt === null) return 0
  const now = Date.now()
  const pausedNow = pausedAtMs !== null ? now - pausedAtMs : 0
  return Math.max(0, now - startedAt - pausedAccumMs - pausedNow)
}

/** True while a take is being recorded (including while paused). */
export const isTakeInProgress = (): boolean => useRecorder.getState().recording

/**
 * Hold the current take while the preview is paused (dubbing with Space).
 *
 * ⛔ THE MIC KEEPS RECORDING, 2026-09-30 (MIC-5). This used to pause the
 * MediaRecorder, and the recorder restarted about 50 ms before the resumed
 * picture moved and 85 ms before it was heard, so every pause and resume pushed
 * the rest of his take 45 to 62 ms later against the picture. Now the file runs
 * on in real time and each stretch he heard is placed on its own timeline spot
 * when he keeps it (takePlacement.ts). Nothing can accumulate, and what he said
 * while paused is simply not placed. This only drives the readout and the hint.
 */
export function pauseRecording(): void {
  const s = useRecorder.getState()
  if (!s.recording || s.paused) return
  pausedAtMs = Date.now()
  useRecorder.setState({ paused: true })
}

/** The preview resumed: the take is live again. No-op if idle or not paused. */
export function resumeRecording(): void {
  const s = useRecorder.getState()
  if (!s.recording || !s.paused) return
  if (pausedAtMs !== null) {
    pausedAccumMs += Date.now() - pausedAtMs
    pausedAtMs = null
  }
  useRecorder.setState({ paused: false })
}

/**
 * The transport's report of what he hears (engine/playback.ts onHeard): a span
 * when a stretch of the timeline starts reaching his ears, null and the time it
 * stopped when it ends. Kept only while a take is running.
 */
export function takeHeard(span: HeardSpan | null, endedAtMs?: number, why?: HeardEnd): void {
  if (!takeHeardSpans || !useRecorder.getState().recording) return
  if (span) {
    const h: HeardDuringTake = { timelineS: span.timelineS, heardAtMs: span.heardAtMs, endedAtMs: null }
    if (span.continues) h.continues = true
    takeHeardSpans.push(h)
    return
  }
  const open = takeHeardSpans[takeHeardSpans.length - 1]
  if (!open || open.endedAtMs !== null) return
  open.endedAtMs = endedAtMs ?? performance.now()
  if (why === 'end') open.endedBy = 'end'
}

/** Put the clip light out. His click, or the next take. */
export function clearClip(): void {
  useRecorder.setState({ clipped: false })
}

// ---------------------------------------------------------------------------
// The studio's live mic. ONE MonitorGraph feeds the meter, the "hear myself"
// path, and MediaRecorder, so opening the studio is the single mic acquisition.

let monitor: MonitorGraph | null = null
let levelRaf = 0

// The meter loop is a display nicety; guard rAF so the store stays usable in a
// non-DOM env (tests) where requestAnimationFrame is absent.
const raf =
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (): number => 0
const cancelRaf =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (): void => {}

function pumpLevel(): void {
  if (!monitor) return
  const peak = monitor.level()
  const s = useRecorder.getState()
  if (s.recording && !s.paused && peak > takeLivePeak) takeLivePeak = peak
  // The clip light LATCHES: one sample at -1 dBFS turns it on and it stays on.
  useRecorder.setState(peak >= CLIP_AMP && !s.clipped ? { level: peak, clipped: true } : { level: peak })
  levelRaf = raf(pumpLevel)
}

/**
 * Say it out loud when the chosen mic is not the one recording (MIC-8). The
 * comment on audioConstraintFor always promised a LOUD fallback, and the code
 * fell back in silence: a take could come from a webcam and he would not know.
 */
function adoptMonitor(m: MonitorGraph): void {
  const { selectedInputLabel } = useRecorder.getState()
  useRecorder.setState({ inputLabel: m.inputLabel, inputMissing: m.fellBack })
  if (!m.fellBack) return
  const chosen = selectedInputLabel ? `“${selectedInputLabel}”` : 'Your chosen microphone'
  const now = m.inputLabel ? `“${m.inputLabel}”` : 'the system default'
  useToasts.getState().show(`${chosen} is not connected. Recording from ${now} instead.`, 'danger')
}

/** Open the studio panel and bring the mic up live (meter + monitor). */
export async function openStudio(): Promise<void> {
  const show = useToasts.getState().show
  if (!canRecordVoice()) {
    show('Voice recording is not supported in this browser', 'danger')
    return
  }
  useRecorder.setState({ studioOpen: true })
  if (monitor) return
  const { selectedInputId, selectedOutputId, monitoring } = useRecorder.getState()
  try {
    monitor = await createMonitorGraph(selectedInputId, (id) => audioConstraintFor(id))
  } catch {
    show('Microphone access was blocked', 'danger')
    useRecorder.setState({ studioOpen: false })
    return
  }
  adoptMonitor(monitor)
  await monitor.setOutput(selectedOutputId)
  monitor.setMonitoring(monitoring)
  levelRaf = raf(pumpLevel)
}

/** Close the studio: stop any take, release the mic, drop an unreviewed take. */
export function closeStudio(): void {
  if (useRecorder.getState().recording) stopRecording()
  discardTake()
  cancelRaf(levelRaf)
  monitor?.dispose()
  monitor = null
  useRecorder.setState({ studioOpen: false, level: 0 })
}

/** Re-acquire the live mic on a device change without closing the panel. */
async function reacquireMonitor(): Promise<void> {
  if (!monitor) return
  const wasRecording = useRecorder.getState().recording
  if (wasRecording) stopRecording()
  cancelRaf(levelRaf)
  monitor.dispose()
  monitor = null
  const { selectedInputId, selectedOutputId, monitoring } = useRecorder.getState()
  try {
    monitor = await createMonitorGraph(selectedInputId, (id) => audioConstraintFor(id))
  } catch {
    useRecorder.setState({ level: 0, inputLabel: '', inputMissing: false })
    return
  }
  adoptMonitor(monitor)
  await monitor.setOutput(selectedOutputId)
  monitor.setMonitoring(monitoring)
  levelRaf = raf(pumpLevel)
}

/** Whether this browser can record at all (mic + MediaRecorder). Pure capability check. */
export const canRecordVoice = (): boolean =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined'

/**
 * First MediaRecorder mime this browser supports, best first. '' = let the UA
 * choose.
 *
 * ⛔ LOSSLESS FIRST, 2026-09-30 (MIC-6). Every take used to be Opus at 128 kbps
 * and then AAC again at export: two lossy codecs on his voice. Measured against
 * the source on the same record button, Opus left a residual of -23 dB at 15 kHz
 * and -45 dB on a loud 200 Hz tone; the PCM take -50 and -69, the floor of the
 * measurement itself. Electron records PCM in WebM, so the voice stored is the
 * voice the mic delivered. Opus stays as the fallback for an engine without it.
 */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of ['audio/webm;codecs=pcm', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

/** A lossless capture: no bitrate to ask for, and safe to store as mono. */
export const isLosslessMime = (mime: string): boolean => /codecs=pcm|audio\/wav/i.test(mime)

/** File extension matching the recorded mime, so probe/import route it correctly. */
export function recordingFileName(n: number, mime: string): string {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm'
  return `Voice recording ${n}.${ext}`
}

/**
 * Synchronous in-flight guard. `recording` only flips true AFTER the async
 * getUserMedia below, so without this a second click DURING acquisition (a
 * double-click, or a slow first-time permission prompt) would pass the guard
 * again, start a second recorder, and orphan the first mic stream.
 */
let acquiring = false

export async function startRecording(): Promise<void> {
  const show = useToasts.getState().show
  if (useRecorder.getState().recording || acquiring) return
  // Recording lives inside the studio: bring it up if the caller went straight
  // to record. The live mic is the MonitorGraph's stream, so capture, meter,
  // and monitor all share ONE acquisition.
  if (!monitor) {
    acquiring = true
    try {
      await openStudio()
    } finally {
      acquiring = false
    }
    if (!monitor) return // openStudio already surfaced the error
  }
  // A held take is replaced by the new one; reviewing is per-take, not a queue.
  // dropTake, NOT discardTake: see the comment on discardTake.
  dropTake()

  const mime = pickRecorderMime()
  // Opus only: a high, explicit bitrate. The browser default is low and a big
  // reason raw recordings sound bad. A lossless take has no bitrate.
  const options: MediaRecorderOptions = isLosslessMime(mime) ? {} : { audioBitsPerSecond: RECORDING_BITS_PER_SECOND }
  if (mime) options.mimeType = mime
  const startedAt = Date.now()
  const takeChunks: Blob[] = []
  const heard: HeardDuringTake[] = []
  const timing: TakeTiming = {
    recorderStartMs: 0,
    inputLatencyS: monitor.inputLatencyS,
    heard,
    startPlayheadS: useStore.getState().ui.playheadS,
  }
  try {
    const rec = new MediaRecorder(monitor.stream, options)
    recorder = rec
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) takeChunks.push(e.data)
    }
    rec.onstop = () => finalize(mime, rec, takeChunks, startedAt, timing)
    rec.start()
    // File position 0 is the audio delivered from here on (see takePlacement).
    timing.recorderStartMs = performance.now()
  } catch (err) {
    recorder = null
    console.warn('OL Premiere: could not start MediaRecorder', err)
    show('Could not start recording on this device', 'danger')
    return
  }
  // Fresh take: clear any pause carried from the last one, and the clip light.
  pausedAccumMs = 0
  pausedAtMs = null
  takeLivePeak = 0
  takeHeardSpans = heard
  useRecorder.setState({ recording: true, paused: false, startedAt, clipped: false })
  // A preview he already had rolling: the take joins the stretch he is hearing.
  const live = currentHeardSpan()
  if (live) takeHeard(live)

  // WHERE HE STARTED, remembered before anything moves, so a discard can put him
  // back. Kept even when the preview does not roll: he still wants the spot back.
  takeStartPlayheadS = timing.startPlayheadS
  if (useRecorder.getState().autoPlay) {
    // His words: "when you start recording, it starts the preview too", so he can
    // perform against his own edit instead of against silence.
    ensurePlaying()
    startedPlaybackForTake = true
  }
}

export function stopRecording(): void {
  if (!useRecorder.getState().recording || !recorder) return
  // onstop fires finalize(); flip the UI state now so the button responds at once.
  // The recorder never pauses (see pauseRecording), so stop() always finds it
  // recording, and the file ends here: a stretch still being heard is cut to it.
  recorder.stop()
  takeHeardSpans = null
  useRecorder.setState({ recording: false, paused: false, startedAt: null })
  // Only stop what WE started. If he had the preview rolling before he hit
  // record, it is his and it keeps rolling.
  if (startedPlaybackForTake) {
    pausePlayback()
    startedPlaybackForTake = false
  }
}

/**
 * Assemble ONE take and HOLD it for review. It does not touch the bin until
 * the user keeps it. The mic is NOT stopped here (the studio owns the shared
 * stream and stays live for the next take + the meter). Clears the recorder
 * pointer only if this take is still the active one.
 */
function finalize(mime: string, rec: MediaRecorder, takeChunks: Blob[], startedAt: number, timing: TakeTiming): void {
  if (recorder === rec) {
    recorder = null
    takeHeardSpans = null
    // A recorder can stop on its OWN (mic unplugged) without stopRecording();
    // reset the flag here or the Stop button sticks forever.
    if (useRecorder.getState().recording) {
      useRecorder.setState({ recording: false, paused: false, startedAt: null })
    }
  }
  // The file runs in real time from start to stop, paused spans included.
  const recordedS = Math.max(0, (Date.now() - startedAt) / 1000)
  pausedAccumMs = 0
  pausedAtMs = null
  const blob = new Blob(takeChunks, { type: mime || 'audio/webm' })
  if (blob.size === 0) {
    useToasts.getState().show('Recording was empty', 'danger')
    return
  }
  takeCount += 1
  const take: PendingTake = {
    url: URL.createObjectURL(blob),
    blob,
    mime,
    name: recordingFileName(takeCount, mime),
    durationS: recordedS,
    timing,
  }
  useRecorder.setState({ pendingTake: take })
  const reading = readFinalTake(take, takeLivePeak)
  takeReadings.set(take, reading)
  // While it is still the one under review, the player plays what will be kept.
  void reading.then((final) => {
    if (final === take || useRecorder.getState().pendingTake !== take) return
    URL.revokeObjectURL(take.url)
    const shown: PendingTake = { ...final, url: URL.createObjectURL(final.blob) }
    takeReadings.set(shown, Promise.resolve(shown))
    useRecorder.setState({ pendingTake: shown })
  })
}

/**
 * What each take will be kept as, once it has been read: the take as recorded,
 * or its mono version. Keyed by the take itself, so Keep can claim a take the
 * moment he clicks and wait for its read afterwards (see keepTake).
 */
const takeReadings = new WeakMap<PendingTake, Promise<PendingTake>>()

/**
 * Read a take once, as the app will read it when kept, and say what to keep.
 *
 * ⛔ MIC-3: a take whose peak reached -1 dBFS says so, once, in plain words.
 * The capture is raw with auto gain off, so his mic gain is the only guard, and
 * 5 of his 65 takes touched full scale with flat tops up to 20 samples long, one
 * of them on his best cat timeline, with nothing on screen ever saying so. The
 * live meter can miss a peak while the window is hidden; the file cannot.
 *
 * ⛔ MIC-7: a lossless take that is one voice on both sides (every take he has
 * recorded) is kept as a mono take, half the size, same samples. A take with the
 * voice on one side only keeps that side. Anything else is kept as it came.
 */
async function readFinalTake(take: PendingTake, livePeak: number): Promise<PendingTake> {
  const report = await readTake(take.blob, isLosslessMime(take.mime))
  const peak = report ? report.peak : livePeak
  if (peak >= CLIP_AMP) {
    useRecorder.setState({ clipped: true })
    useToasts.getState().show('This take clipped. Turn your mic gain down.', 'danger')
  }
  if (!report?.mono) return take
  return { ...take, blob: report.mono, mime: 'audio/wav', name: take.name.replace(/\.[^.]+$/, '.wav') }
}

/**
 * Keep the held take: it becomes an ordinary bin asset (waveform, drag, edit)
 * AND lands on the timeline where he performed it.
 *
 * ⛔ HIS ANSWER, 2026-09-30: *"Yes, place it for me."* Kept takes land where he
 * started, on the next free audio line (his voice line first), lined up to the
 * frame, and still show in the library. The placement is ONE edit, so one undo
 * takes it back off the timeline and leaves the take in the library.
 *
 * ⛔ THE TAKE IS HIS THE MOMENT HE CLICKS (2026-10-01). This used to wait for
 * the take's read first and only then claim it, so closing the studio or
 * pressing Record in that wait threw away the take he had just chosen to keep:
 * measured in the real app, gone with the X pressed 2 ms after "Add". The read
 * takes longer the longer the take (230 ms for 30 s, 2.4 s for 10 minutes). Now
 * it is claimed at once, nothing else can drop it, and the button says it is
 * adding until the read and the import are done.
 */
export async function keepTake(): Promise<void> {
  const { pendingTake: take, keeping } = useRecorder.getState()
  if (!take || keeping) return
  useRecorder.setState({ pendingTake: null, keeping: true })
  // Kept, so there is nothing to go back FROM: a later discard must not fling
  // him to where this take began.
  takeStartPlayheadS = null
  try {
    const final = await (takeReadings.get(take) ?? Promise.resolve(take))
    URL.revokeObjectURL(take.url)
    const file = new File([final.blob], final.name, { type: final.blob.type })
    const [id] = await importFiles([file])
    const asset = id ? useStore.getState().project.assets[id] : undefined
    if (!asset) return
    const spans = takeClipSpans(final.timing, asset.durationS)
    if (spans.length === 0) return
    updateActiveSequence(`Place ${asset.name}`, (seq) => placeTakeClips(seq, asset, spans).seq)
  } finally {
    useRecorder.setState({ keeping: false })
  }
}

/** Drop the held take and nothing else. The playhead is NOT touched. */
function dropTake(): void {
  const take = useRecorder.getState().pendingTake
  if (!take) return
  URL.revokeObjectURL(take.url)
  useRecorder.setState({ pendingTake: null })
}

/**
 * Throw the take away AND put him back where he started recording.
 *
 * His words, 2026-08-12: "when you stop the recording and you discard it, you
 * see it's not good enough. Make it go back to the start of the preview."
 * Discarding always means "that one was no good, going again", so the retry has
 * to be instant instead of hunting for the spot he began at.
 *
 * ⛔ `startRecording` must NOT call this. It drops the previous take on its way
 * into a new one, and restoring the playhead there would drag him back to where
 * the LAST take began the moment he starts the next. That is what `dropTake` is
 * for.
 */
export function discardTake(): void {
  // Only a REAL discard moves him. With nothing held this is a no-op, or a
  // stray click would fling the playhead back to some take he already kept.
  if (!useRecorder.getState().pendingTake) return
  dropTake()
  const back = takeStartPlayheadS
  takeStartPlayheadS = null
  if (back === null) return
  pausePlayback()
  useStore.getState().setUI({ playheadS: back })
}
