// The Captions dialog - the two non-Whisper roads to word captions:
//   Paste  - a word-timed JSON list or an SRT (exact timings win).
//   Tap    - type the script, press Start, tap Enter on each word as the
//            voiceover plays; taps become the word timings.
// Both funnel into addCaptionsFromWords, same as Auto-Caption.

import { Layers, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  CAPTION_LANGUAGES,
  getCaptionLanguage,
  setCaptionLanguage,
  type CaptionLanguage,
} from '../engine/captions/transcribeConfig'
import { parseTranscript, tapsToWords } from '../engine/captions/transcript'
import { clipEndS } from '../engine/timeline'
import { activeSequence } from '../engine/types'
import { addCaptionsFromWords } from '../state/captionActions'
import { pausePlayback, togglePlay } from '../state/playbackControl'
import { useStore } from '../state/store'
import {
  builtinTextPresets,
  getCaptionPresetId,
  setCaptionPresetId,
  useTextPresets,
  type TextStylePreset,
} from '../state/textPresets'
import { autoCaptionEveryClip, autoCaptionFromClip } from '../state/transcribeActions'
import { Button, IconButton } from '../ui/Button'

/** The voiceover clip Auto-Caption should target. Priority: the clip you have
 * SELECTED (so picking a clip then captioning does what you expect), then the
 * clip under the playhead on a voice-role track, then the first voice clip,
 * then the first audio clip with sound. */
function findVoClipId(): string | null {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const t = s.ui.playheadS
  const sel = new Set(s.ui.selection)
  const audible = seq.tracks
    .filter((tr) => tr.kind === 'audio' && !tr.locked)
    .flatMap((tr) =>
      tr.clips
        .filter((c) => s.project.assets[c.assetId]?.hasAudio)
        .map((c) => ({ c, voice: tr.audioRole === 'voice' })),
    )
  if (audible.length === 0) return null
  const selected = audible.find(({ c }) => sel.has(c.id))
  const under = audible.find(({ c, voice }) => voice && t >= c.startS && t < clipEndS(c))
  return (selected ?? under ?? audible.find(({ voice }) => voice) ?? audible[0]).c.id
}

/** How many clips "Caption every clip" would actually work on. */
function audibleClipCount(): number {
  const s = useStore.getState()
  return activeSequence(s.project)
    .tracks.filter((t) => !t.locked)
    .flatMap((t) => t.clips)
    .filter((c) => s.project.assets[c.assetId]?.hasAudio).length
}

const PASTE_HINT = `[{"text":"so","startS":0.1,"endS":0.4}, …]   or an .srt`

type Mode = 'paste' | 'tap'

export function CaptionsDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('paste')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Caption style: pick a look (lowercase + outline + position + in/out anim) to
  // apply to the whole run. Defaults to the Jettism house style.
  const savedPresets = useTextPresets((s) => s.saved)
  const presets = [...builtinTextPresets(), ...savedPresets]
  // Remembered, not reset-on-open: right-click → Auto-Caption reads the same
  // pick, so the two doors cannot drift apart again.
  const [presetId, setPresetId] = useState(getCaptionPresetId)
  const [language, setLanguage] = useState<CaptionLanguage>(getCaptionLanguage)
  const preset: TextStylePreset | undefined = presets.find((p) => p.id === presetId)
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
        addCaptionsFromWords(words, { label: 'Captions (tap to time)', preset })
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

  // Escape closes the dialog whenever a tap run is not consuming the keys
  // (the tap handler above intercepts Escape on capture to cancel the run).
  const tappingNow = tapWords !== null
  useEffect(() => {
    if (tappingNow) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tappingNow, onClose])

  const applyPaste = () => {
    const words = parseTranscript(text)
    if (!words || words.length === 0) {
      setError('Could not read that. Paste a JSON word list or an SRT.')
      return
    }
    addCaptionsFromWords(words, { label: 'Captions from transcript', preset })
    onClose()
  }

  const startTapping = () => {
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      setError('Type the script first. One tap per word.')
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
        className="w-[460px] rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 items-center gap-2 border-b border-border px-4">
          <span className="text-ui font-semibold text-text-primary">Captions</span>
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
          <span className="ml-auto">
            <IconButton label="Close" disabled={tapping} onClick={onClose}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>

        {/* The #1 Jettism step, front and center - right-click was its only
            home before, which made the flagship feature invisible. */}
        {/* Captions are AUTO now, with no words-per-caption dial: one word per
            caption, on screen for exactly as long as it is spoken. His call: the
            dial welded words together across the pauses between them, so a
            caption sat there while he was saying something else. */}
        {!tapping && (
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Button
                data-testid="captions-auto"
                disabled={findVoClipId() === null}
                onClick={() => {
                  const id = findVoClipId()
                  if (id) {
                    void autoCaptionFromClip(id, preset)
                    onClose()
                  }
                }}
              >
                <Sparkles size={14} strokeWidth={1.5} />
                Caption this clip
              </Button>
              <Button
                variant="secondary"
                data-testid="captions-auto-all"
                disabled={audibleClipCount() === 0}
                onClick={() => {
                  void autoCaptionEveryClip(preset)
                  onClose()
                }}
              >
                <Layers size={14} strokeWidth={1.5} />
                Caption every clip
              </Button>
            </div>
            <span className="text-[10px] text-text-muted">
              {audibleClipCount() === 0
                ? 'Add a clip with sound first.'
                : `One word per caption, timed to the voice. Every clip means all ${audibleClipCount()} with sound, onto one track.`}
            </span>
          </div>
        )}
        {!tapping && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="text-[11px] text-text-muted">Caption style</span>
            <select
              aria-label="Caption style preset"
              data-testid="captions-preset"
              value={presetId}
              onChange={(e) => {
                setPresetId(e.target.value)
                setCaptionPresetId(e.target.value)
              }}
              className="ml-auto h-6 w-[190px] cursor-default rounded-field border border-border bg-bg-input px-1.5 text-[11px] text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Jettism (the measured look)</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {!tapping && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="text-[11px] text-text-muted">Spoken language</span>
            <select
              aria-label="Caption language"
              data-testid="captions-language"
              value={language}
              onChange={(e) => {
                const v = e.target.value as CaptionLanguage
                setLanguage(v)
                setCaptionLanguage(v) // persists; the clip right-click path reads it too
              }}
              className="ml-auto h-6 w-[190px] cursor-default rounded-field border border-border bg-bg-input px-1.5 text-[11px] text-text-primary focus:border-accent focus:outline-none"
            >
              {CAPTION_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-2 p-4">
          {tapping ? (
            <div data-testid="tap-progress" className="rounded-overlay border border-border bg-bg-panel px-3 py-4 text-center">
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
                placeholder={mode === 'paste' ? PASTE_HINT : 'Type the voiceover script. One tap per word.'}
                data-testid="captions-text"
                className="w-full resize-none rounded-field border border-border bg-bg-input p-2 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
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
