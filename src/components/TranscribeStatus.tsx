// The auto-caption progress pill: model download %, then "listening", with a
// cancel that terminates the Whisper worker. Hidden while idle.

import { Loader2, X } from 'lucide-react'
import { useTranscribe } from '../state/transcribeActions'

export function TranscribeStatus() {
  const status = useTranscribe((s) => s.status)
  const pct = useTranscribe((s) => s.pct)
  const downloading = useTranscribe((s) => s.downloading)
  const cancel = useTranscribe((s) => s.cancel)
  const queue = useTranscribe((s) => s.queue)
  if (status === 'idle') return null

  // "Downloading (once)" was a lie every time after the first: the model lives in
  // the local cache, and loading it from there still reports progress, so he saw
  // the download banner on every new version and reasonably stopped trusting it.
  // "Listening for words" was said while the app was still deciding whether
  // anybody was talking at all, which is how it came to claim it was listening
  // for words in a clip of gameplay. His words, 2026-08-19: *"I think when it
  // says 'listening for words,' it also listens to video clips. It's kinda
  // weird."* Each step says what it is really doing now.
  const label =
    status === 'reading'
      ? 'Reading the clip’s audio…'
      : status === 'screening'
        ? 'Checking if anyone is talking…'
        : status === 'model'
          ? downloading
            ? 'Downloading Whisper (first time only)'
            : 'Loading Whisper…'
          : 'Listening for words…'

  return (
    <div
      data-testid="transcribe-status"
      role="status"
      className="fixed bottom-12 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-bg-elevated py-1.5 pl-3 pr-2.5 text-ui-sm text-text-primary shadow-pop"
    >
      {/* In-progress work is an ember state, not an accent state. */}
      <Loader2 size={13} strokeWidth={2} aria-hidden className="animate-spin text-ember" />
      <span>{label}</span>
      {/* Captioning a whole timeline runs one clip at a time, so say where it is.
          Without this the pill looks identical for a minute and for ten. */}
      {queue && (
        <span data-testid="transcribe-queue" className="font-numeric text-ui-sm text-text-secondary">
          clip {queue.index} of {queue.total}
        </span>
      )}
      {status === 'model' && (
        <span className="font-numeric text-ui-sm text-text-secondary">
          {pct != null ? `${Math.round(pct)}%` : '…'}
        </span>
      )}
      {cancel && (
        <button
          type="button"
          aria-label="Cancel transcription"
          onClick={cancel}
          className="ml-0.5 rounded-full p-0.5 text-text-muted transition-colors duration-[120ms] hover:bg-bg-input hover:text-text-primary"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
