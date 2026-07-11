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
}

/** localStorage key for the remembered mic; survives reloads and projects. */
const INPUT_KEY = 'reel:recorder:input-device'

/** Read the saved mic id, tolerating environments without localStorage. */
function loadSavedInputId(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(INPUT_KEY) : null
  } catch {
    return null
  }
}

export const useRecorder = create<RecorderState>(() => ({
  recording: false,
  startedAt: null,
  selectedInputId: loadSavedInputId(),
}))

/**
 * The `getUserMedia` audio constraint for a chosen input, or the system default.
 * A pinned device uses `exact` so we KNOW we captured the mic the user picked —
 * if it's gone, `getUserMedia` throws and we fall back loudly rather than record
 * silence from the wrong device (the bug this feature fixes).
 */
export function audioConstraintFor(deviceId: string | null): MediaTrackConstraints | boolean {
  return deviceId ? { deviceId: { exact: deviceId } } : true
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

export async function startRecording(): Promise<void> {
  if (useRecorder.getState().recording) return
  const show = useToasts.getState().show
  if (!canRecordVoice()) {
    show('Voice recording is not supported in this browser', 'danger')
    return
  }
  const chosen = useRecorder.getState().selectedInputId
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraintFor(chosen) })
  } catch (err) {
    const name = (err as { name?: string })?.name
    // A pinned device that's since been unplugged makes the `exact` constraint
    // throw. Clear the stale pick and retry on the default so a missing mic
    // degrades to "records from default", never "silently records nothing".
    if (chosen && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      setInputDevice(null)
      show('That microphone is unavailable — using the system default', 'info')
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.onstop = () => void finalize(mime)
  recorder.start()
  useRecorder.setState({ recording: true, startedAt: Date.now() })
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
