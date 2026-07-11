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
}

export const useRecorder = create<RecorderState>(() => ({ recording: false, startedAt: null }))

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
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    show('Microphone access was blocked', 'danger')
    return
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
