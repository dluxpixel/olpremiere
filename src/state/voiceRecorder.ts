// Voiceover recorder + studio. A take is NO LONGER dropped straight into the
// bin: it lands in the studio panel for review, where the user keeps it (into
// the SAME import pipeline everything else uses — probe + persist + waveform +
// drag-to-timeline) or discards it. The studio also owns a live mic stream so
// the meter, the "hear myself" monitor, and MediaRecorder all tap one capture.
// 100% local — the audio never leaves the machine.

import { create } from 'zustand'
import { importFiles } from './mediaActions'
import { createMonitorGraph, type MonitorGraph } from './recordingMonitor'
import { useToasts } from './toasts'

/** A captured take held for review before it is kept or thrown away. */
export interface PendingTake {
  /** Object URL for the review player. Revoked on keep/discard. */
  url: string
  blob: Blob
  mime: string
  name: string
  /** Wall-clock length of the take, seconds. */
  durationS: number
}

interface RecorderState {
  /** The studio panel is open (owns the live mic + monitor graph). */
  studioOpen: boolean
  recording: boolean
  /** Epoch ms the current take started, for the elapsed readout. Null when idle. */
  startedAt: number | null
  /** A finished take awaiting keep/discard. Null when there is nothing to review. */
  pendingTake: PendingTake | null
  /** Hear yourself: route the mic to the output while the studio is open. Persisted. */
  monitoring: boolean
  /** Live input peak 0..1 for the meter (updated each frame while the studio is open). */
  level: number
  /** Chosen audio-input `deviceId`, or null for the system default. Persisted. */
  selectedInputId: string | null
  /** Chosen audio-OUTPUT `deviceId`, or null for the system default. Persisted. */
  selectedOutputId: string | null
  /**
   * Whether to run browser noise suppression. OFF by default so a voiceover
   * captures pristine; ON removes steady background sound (a passing car, fans).
   * Persisted.
   */
  enhance: boolean
}

/** localStorage keys; survive reloads and projects. */
const INPUT_KEY = 'reel:recorder:input-device'
const OUTPUT_KEY = 'reel:recorder:output-device'
const MONITOR_KEY = 'reel:recorder:monitor'
const ENHANCE_KEY = 'reel:recorder:enhance'

/** Recorded-audio bitrate. 128 kbps Opus is transparent for voice; the browser
 * default is far lower, which is a big part of why raw recordings sound bad. */
export const RECORDING_BITS_PER_SECOND = 128_000

/** Read the saved mic id, tolerating environments without localStorage. */
function loadSavedInputId(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(INPUT_KEY) : null
  } catch {
    return null
  }
}

function loadEnhance(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(ENHANCE_KEY) === '1'
  } catch {
    return false
  }
}

function loadFlag(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function loadString(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

export const useRecorder = create<RecorderState>(() => ({
  studioOpen: false,
  recording: false,
  startedAt: null,
  pendingTake: null,
  monitoring: loadFlag(MONITOR_KEY),
  level: 0,
  selectedInputId: loadSavedInputId(),
  selectedOutputId: loadString(OUTPUT_KEY),
  enhance: loadEnhance(),
}))

/**
 * The `getUserMedia` audio constraint. Always captures clean 48 kHz mono with
 * echo-cancellation and auto-gain OFF (those are what mangle a voiceover into a
 * pumped, muffled mess). `reduceNoise` toggles ONLY noise suppression — the one
 * step that removes steady background sound (a passing car, fans) — so it can
 * quiet the room without the old artefacts. A pinned device uses `exact` so we
 * KNOW we captured the mic the user picked; if it's gone `getUserMedia` throws
 * and we fall back loudly rather than record from the wrong device.
 */
export function audioConstraintFor(deviceId: string | null, reduceNoise = false): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    // Echo cancellation is for call feedback, not a voiceover — it only muddies
    // the sound, so keep it off.
    echoCancellation: false,
    // Noise suppression is the ONE processing step that removes steady/background
    // sound (a passing car, fans, hum). Off = pristine but captures everything;
    // on = quieter background for a little lost detail.
    noiseSuppression: reduceNoise,
    // Auto-gain stays OFF either way: its volume-riding is what pumped/muffled the
    // recording, so noise reduction no longer drags that artefact back in.
    autoGainControl: false,
    sampleRate: 48_000,
    channelCount: 1,
  }
  if (deviceId) c.deviceId = { exact: deviceId }
  return c
}

/** Toggle background-noise suppression and remember it. */
export function setEnhance(on: boolean): void {
  useRecorder.setState({ enhance: on })
  try {
    if (typeof localStorage === 'undefined') return
    if (on) localStorage.setItem(ENHANCE_KEY, '1')
    else localStorage.removeItem(ENHANCE_KEY)
  } catch {
    // Ignore storage failures (private mode / quota); the in-memory choice still applies.
  }
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
      // Permission denied — return the unlabeled entries; the UI names them generically.
    }
  }
  return inputs
}

/** Choose the recording input (null = system default) and remember it. */
export function setInputDevice(deviceId: string | null): void {
  useRecorder.setState({ selectedInputId: deviceId })
  try {
    if (typeof localStorage === 'undefined') return
    if (deviceId) localStorage.setItem(INPUT_KEY, deviceId)
    else localStorage.removeItem(INPUT_KEY)
  } catch {
    // Ignore storage failures (private mode / quota); the in-memory pick still applies.
  }
  // A live studio must re-acquire on the new mic so the meter/monitor follow.
  if (useRecorder.getState().studioOpen) void reacquireMonitor()
}

/** Choose the monitor OUTPUT (null = system default) and remember it. */
export function setOutputDevice(deviceId: string | null): void {
  useRecorder.setState({ selectedOutputId: deviceId })
  try {
    if (typeof localStorage !== 'undefined') {
      if (deviceId) localStorage.setItem(OUTPUT_KEY, deviceId)
      else localStorage.removeItem(OUTPUT_KEY)
    }
  } catch {
    // Ignore storage failures; the in-memory pick still applies.
  }
  void monitor?.setOutput(deviceId)
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
  useRecorder.setState({ level: monitor.level() })
  levelRaf = raf(pumpLevel)
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
  const { selectedInputId, selectedOutputId, monitoring, enhance } = useRecorder.getState()
  try {
    monitor = await createMonitorGraph(selectedInputId, (id) => audioConstraintFor(id, enhance))
  } catch {
    show('Microphone access was blocked', 'danger')
    useRecorder.setState({ studioOpen: false })
    return
  }
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
  const { selectedInputId, selectedOutputId, monitoring, enhance } = useRecorder.getState()
  try {
    monitor = await createMonitorGraph(selectedInputId, (id) => audioConstraintFor(id, enhance))
  } catch {
    useRecorder.setState({ level: 0 })
    return
  }
  await monitor.setOutput(selectedOutputId)
  monitor.setMonitoring(monitoring)
  levelRaf = raf(pumpLevel)
}

/** Whether this browser can record at all (mic + MediaRecorder). Pure capability check. */
export const canRecordVoice = (): boolean =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined'

/** First MediaRecorder mime this browser supports, best (Opus) first. '' = let the UA choose. */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

/** File extension matching the recorded mime, so probe/import route it correctly. */
export function recordingFileName(n: number, mime: string): string {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm'
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
  discardTake()

  const mime = pickRecorderMime()
  // A high, explicit bitrate — the browser default is low and a big reason raw
  // recordings sound bad.
  const options: MediaRecorderOptions = { audioBitsPerSecond: RECORDING_BITS_PER_SECOND }
  if (mime) options.mimeType = mime
  const startedAt = Date.now()
  const takeChunks: Blob[] = []
  try {
    const rec = new MediaRecorder(monitor.stream, options)
    recorder = rec
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) takeChunks.push(e.data)
    }
    rec.onstop = () => finalize(mime, rec, takeChunks, startedAt)
    rec.start()
  } catch (err) {
    recorder = null
    console.warn('OL Studio: could not start MediaRecorder', err)
    show('Could not start recording on this device', 'danger')
    return
  }
  useRecorder.setState({ recording: true, startedAt })
}

export function stopRecording(): void {
  if (!useRecorder.getState().recording || !recorder) return
  // onstop fires finalize(); flip the UI state now so the button responds at once.
  recorder.stop()
  useRecorder.setState({ recording: false, startedAt: null })
}

/**
 * Assemble ONE take and HOLD it for review — it does not touch the bin until
 * the user keeps it. The mic is NOT stopped here (the studio owns the shared
 * stream and stays live for the next take + the meter). Clears the recorder
 * pointer only if this take is still the active one.
 */
function finalize(mime: string, rec: MediaRecorder, takeChunks: Blob[], startedAt: number): void {
  if (recorder === rec) {
    recorder = null
    // A recorder can stop on its OWN (mic unplugged) without stopRecording();
    // reset the flag here or the Stop button sticks forever.
    if (useRecorder.getState().recording) {
      useRecorder.setState({ recording: false, startedAt: null })
    }
  }
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
    durationS: Math.max(0, (Date.now() - startedAt) / 1000),
  }
  useRecorder.setState({ pendingTake: take })
}

/** Keep the held take: it becomes an ordinary bin asset (waveform, drag, edit). */
export async function keepTake(): Promise<void> {
  const take = useRecorder.getState().pendingTake
  if (!take) return
  useRecorder.setState({ pendingTake: null })
  URL.revokeObjectURL(take.url)
  const file = new File([take.blob], take.name, { type: take.blob.type })
  await importFiles([file])
}

/** Throw the held take away (bad take). No-op when there is nothing held. */
export function discardTake(): void {
  const take = useRecorder.getState().pendingTake
  if (!take) return
  URL.revokeObjectURL(take.url)
  useRecorder.setState({ pendingTake: null })
}
