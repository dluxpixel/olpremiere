// Voiceover recorder: capture the mic with MediaRecorder, then hand the clip to
// the SAME import pipeline everything else uses (probe + persist + add to bin),
// so a recording becomes an ordinary audio asset with a waveform, fades, gain,
// and drag-to-timeline. 100% local — the audio never leaves the machine.

import { create } from 'zustand'
import { importFiles } from './mediaActions'
import { useToasts } from './toasts'

interface RecorderState {
  recording: boolean
  /** Epoch ms the current take started, for the elapsed readout. Null when idle. */
  startedAt: number | null
  /** Chosen audio-input `deviceId`, or null for the system default. Persisted. */
  selectedInputId: string | null
  /**
   * Whether to run the browser's noise/echo/gain processing. OFF by default so a
   * voiceover captures clean; ON helps a noisy room. Persisted.
   */
  enhance: boolean
}

/** localStorage keys; survive reloads and projects. */
const INPUT_KEY = 'reel:recorder:input-device'
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

export const useRecorder = create<RecorderState>(() => ({
  recording: false,
  startedAt: null,
  selectedInputId: loadSavedInputId(),
  enhance: loadEnhance(),
}))

/**
 * The `getUserMedia` audio constraint. By DEFAULT it turns OFF the phone-call
 * processing chain — echo cancellation, noise suppression, auto-gain — which
 * mangles a voiceover into a pumped, muffled mess, and requests full-quality
 * 48 kHz mono. `enhance` puts that processing back for a noisy room. A pinned
 * device uses `exact` so we KNOW we captured the mic the user picked — if it's
 * gone, `getUserMedia` throws and we fall back loudly rather than record from
 * the wrong device.
 */
export function audioConstraintFor(deviceId: string | null, enhance = false): MediaTrackConstraints {
  const c: MediaTrackConstraints = enhance
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48_000,
        channelCount: 1,
      }
  if (deviceId) c.deviceId = { exact: deviceId }
  return c
}

/** Toggle the browser noise/echo/gain processing and remember it. */
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
}

let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let takeCount = 0

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
  if (!canRecordVoice()) {
    show('Voice recording is not supported in this browser', 'danger')
    return
  }
  acquiring = true
  try {
    const { selectedInputId: chosen, enhance } = useRecorder.getState()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraintFor(chosen, enhance) })
    } catch (err) {
      const name = (err as { name?: string })?.name
      // A pinned device that's since been unplugged makes the `exact` constraint
      // throw. Clear the stale pick and retry on the default so a missing mic
      // degrades to "records from default", never "silently records nothing".
      if (chosen && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        setInputDevice(null)
        show('That microphone is unavailable — using the system default', 'info')
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraintFor(null, enhance) })
        } catch {
          show('Microphone access was blocked', 'danger')
          return
        }
      } else {
        show('Microphone access was blocked', 'danger')
        return
      }
    }
    const mime = pickRecorderMime()
    chunks = []
    // A high, explicit bitrate — the browser default is low and a big reason raw
    // recordings sound bad.
    const options: MediaRecorderOptions = { audioBitsPerSecond: RECORDING_BITS_PER_SECOND }
    if (mime) options.mimeType = mime
    try {
      recorder = new MediaRecorder(stream, options)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      recorder.onstop = () => void finalize(mime)
      recorder.start()
    } catch (err) {
      // Constructor/start can throw on an unsupported option or UA quirk. The mic
      // stream is already live — release it, or the OS record indicator stays lit.
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      recorder = null
      console.warn('OL Premiere: could not start MediaRecorder', err)
      show('Could not start recording on this device', 'danger')
      return
    }
    useRecorder.setState({ recording: true, startedAt: Date.now() })
  } finally {
    acquiring = false
  }
}

export function stopRecording(): void {
  if (!useRecorder.getState().recording || !recorder) return
  // onstop fires finalize(); flip the UI state now so the button responds at once.
  recorder.stop()
  useRecorder.setState({ recording: false, startedAt: null })
}

/** Assemble the take, release the mic, and import it as an audio asset. */
async function finalize(mime: string): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  const blob = new Blob(chunks, { type: mime || 'audio/webm' })
  chunks = []
  recorder = null
  if (blob.size === 0) {
    useToasts.getState().show('Recording was empty', 'danger')
    return
  }
  takeCount += 1
  const file = new File([blob], recordingFileName(takeCount, mime), { type: blob.type })
  await importFiles([file])
}
