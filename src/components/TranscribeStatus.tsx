// The auto-caption progress pill: model download %, then "listening", with a
// cancel that terminates the Whisper worker. Hidden while idle.

import { Loader2, X } from 'lucide-react'
import { useTranscribe } from '../state/transcribeActions'

export function TranscribeStatus() {
  const status = useTranscribe((s) => s.status)
  const pct = useTranscribe((s) => s.pct)
  const cancel = useTranscribe((s) => s.cancel)
  if (status === 'idle') return null

  const label =
    status === 'reading'
      ? 'Reading the clip’s audio…'
      : status === 'model'
        ? 'Downloading Whisper (once)'
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
