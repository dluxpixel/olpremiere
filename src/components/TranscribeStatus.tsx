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
        ? `Downloading Whisper (once)${pct != null ? ` — ${Math.round(pct)}%` : '…'}`
        : 'Listening for words…'

  return (
    <div
      data-testid="transcribe-status"
      role="status"
      className="fixed bottom-12 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-[6px] border border-border bg-bg-elevated px-3 py-1.5 text-[12px] text-text-primary shadow-lg"
    >
      <Loader2 size={13} strokeWidth={2} aria-hidden className="animate-spin text-accent" />
      <span>{label}</span>
      {cancel && (
        <button
          type="button"
          aria-label="Cancel transcription"
          onClick={cancel}
          className="ml-1 rounded-[3px] p-0.5 text-text-muted transition-colors hover:bg-bg-input hover:text-text-primary"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
