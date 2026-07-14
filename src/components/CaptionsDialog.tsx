// The Captions dialog — the two non-Whisper roads to word captions:
//   Paste  — a word-timed JSON list or an SRT (exact timings win).
//   Tap    — type the script, press Start, tap Enter on each word as the
//            voiceover plays; taps become the word timings.
// Both funnel into addCaptionsFromWords, same as Auto-Caption.

import { useEffect, useRef, useState } from 'react'
import { parseTranscript, tapsToWords } from '../engine/captions/transcript'
import { addCaptionsFromWords } from '../state/captionActions'
import { pausePlayback, togglePlay } from '../state/playbackControl'
import { useStore } from '../state/store'
import { Button } from '../ui/Button'

const PASTE_HINT = `[{"text":"so","startS":0.1,"endS":0.4}, …]   or an .srt`

type Mode = 'paste' | 'tap'

export function CaptionsDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('paste')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Tap mode: the words being timed and the taps collected so far.
  const [tapWords, setTapWords] = useState<string[] | null>(null)
  const [taps, setTaps] = useState<number[]>([])
  const tapsRef = useRef<{ words: string[]; taps: number[] } | null>(null)

  const finishTapping = (commit: boolean) => {
    const run = tapsRef.current
    tapsRef.current = null
    setTapWords(null)
    setTaps([])
    pausePlayback()
    if (commit && run) {
      const words = tapsToWords(run.words, run.taps)
      if (words.length > 0) {
        addCaptionsFromWords(words, { label: 'Captions (tap to time)' })
        onClose()
      }
    }
  }

  // Tap capture runs on window in the CAPTURE phase so the global keymap's
  // space/enter bindings never see the keys while a tap run is live.
  useEffect(() => {
    if (!tapWords) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        const t = useStore.getState().ui.playheadS
        setTaps((prev) => {
          const next = [...prev, t]
          const run = tapsRef.current
          if (run) {
            run.taps = next
            if (next.length >= run.words.length) queueMicrotask(() => finishTapping(true))
          }
          return next
        })
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        setTaps((prev) => {
          const next = prev.slice(0, -1)
          if (tapsRef.current) tapsRef.current.taps = next
          return next
        })
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finishTapping(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapWords])

  // Leaving the dialog mid-run must not leave the transport playing.
  useEffect(() => () => pausePlayback(), [])

  const applyPaste = () => {
    const words = parseTranscript(text)
    if (!words || words.length === 0) {
      setError('Could not read that — paste a JSON word list or an SRT.')
      return
    }
    addCaptionsFromWords(words, { label: 'Captions from transcript' })
    onClose()
  }

  const startTapping = () => {
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      setError('Type the script first — one tap per word.')
      return
    }
    setError(null)
    setTaps([])
    setTapWords(words)
    tapsRef.current = { words, taps: [] }
    if (!useStore.getState().ui.playing) togglePlay()
  }

  const tapping = tapWords !== null
  const nextWord = tapping ? tapWords[taps.length] : null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !tapping) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Captions"
        data-testid="captions-dialog"
        className="w-[460px] rounded-[6px] border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 items-center gap-2 border-b border-border px-4">
          <span className="text-[13px] font-medium text-text-primary">Captions</span>
          <div role="tablist" className="ml-2 flex items-center gap-1">
            {(['paste', 'tap'] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                disabled={tapping}
                onClick={() => {
                  setMode(m)
                  setError(null)
                }}
                className={`rounded-[4px] px-2 py-0.5 text-[11px] transition-colors ${
                  mode === m ? 'bg-accent-quiet text-accent' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {m === 'paste' ? 'Paste transcript' : 'Tap to time'}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={tapping}
            onClick={onClose}
            className="ml-auto rounded-[3px] px-1.5 text-[14px] text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-2 p-4">
          {tapping ? (
            <div data-testid="tap-progress" className="rounded-[6px] border border-border bg-bg-panel px-3 py-4 text-center">
              <div className="text-[11px] text-text-muted">
                Tap <span className="text-text-primary">Enter</span> on each word · Backspace undoes · Esc cancels
              </div>
              <div className="mt-2 text-[22px] font-semibold text-text-primary">{nextWord}</div>
              <div className="mt-1 text-[11px] tabular-nums text-text-secondary">
                {taps.length} / {tapWords.length}
              </div>
            </div>
          ) : (
            <>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setError(null)
                }}
                rows={7}
                placeholder={mode === 'paste' ? PASTE_HINT : 'Type the voiceover script — one tap per word.'}
                data-testid="captions-text"
                className="w-full resize-none rounded-[4px] bg-bg-input p-2 font-mono text-[11px] text-text-primary placeholder:text-text-muted"
              />
              {error && <div className="text-[11px] text-danger">{error}</div>}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-muted">
                  {mode === 'paste'
                    ? 'Exact word timings (JSON) or SRT cues, spread word-by-word.'
                    : 'Playback starts at the playhead; captions land as you tap.'}
                </span>
                <div className="ml-auto">
                  {mode === 'paste' ? (
                    <Button onClick={applyPaste} data-testid="captions-apply">
                      Add captions
                    </Button>
                  ) : (
                    <Button onClick={startTapping} data-testid="captions-tap-start">
                      Start
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
