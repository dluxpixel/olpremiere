// The recording studio: a movable panel that owns the live mic. Record into
// it, then KEEP the take (it becomes a bin asset) or DISCARD it (bad take) -
// nothing reaches the media bin without a decision. Pick input and output
// devices, watch the level, and hear yourself while you work. Movable so it
// can sit beside the preview during a to-picture voiceover.

import { Check, GripHorizontal, Headphones, Mic, Play, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  closeStudio,
  discardTake,
  keepTake,
  listAudioInputs,
  setInputDevice,
  setAutoPlay,
  setMonitoring,
  setOutputDevice,
  startRecording,
  stopRecording,
  takeElapsedMs,
  useRecorder,
} from '../state/voiceRecorder'
import { canPickOutput, listAudioOutputs } from '../state/recordingMonitor'
import { IconButton } from '../ui/Button'

const SELECT_CLS =
  'h-7 w-full cursor-default rounded-field border border-border bg-bg-input px-1.5 text-ui-sm text-text-primary'

/** dB-ish level bar driven imperatively off the store's `level` each frame. */
function LevelMeter() {
  const fill = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const lvl = useRecorder.getState().level
      // Perceptual-ish curve: quiet speech should still move the bar.
      const pct = Math.min(100, Math.pow(lvl, 0.6) * 118)
      if (fill.current) fill.current.style.width = `${pct}%`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-bg-input" data-testid="studio-level">
      <div ref={fill} className="h-full w-0 rounded-full bg-success transition-[background-color]" />
    </div>
  )
}

export function RecordingStudio() {
  const recording = useRecorder((s) => s.recording)
  const paused = useRecorder((s) => s.paused)
  const startedAt = useRecorder((s) => s.startedAt)
  const pending = useRecorder((s) => s.pendingTake)
  const monitoring = useRecorder((s) => s.monitoring)
  const autoPlay = useRecorder((s) => s.autoPlay)
  const selectedInputId = useRecorder((s) => s.selectedInputId)
  const selectedOutputId = useRecorder((s) => s.selectedOutputId)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    void listAudioInputs().then(setInputs)
    void listAudioOutputs().then(setOutputs)
  }, [])

  useEffect(() => {
    if (!recording || startedAt === null) {
      setElapsed(0)
      return
    }
    // takeElapsedMs excludes paused spans, so the readout freezes while held.
    const tick = () => setElapsed(Math.floor(takeElapsedMs() / 1000))
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [recording, startedAt])

  // Drag by the header. Pointer capture keeps the grab even if the cursor
  // outruns the panel; the panel is clamped into the viewport on drop. Ignore
  // presses that land on a control inside the header (the close button), since
  // the capture would otherwise swallow its click.
  const onHeaderDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHeaderMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const x = Math.max(8, Math.min(window.innerWidth - 316, e.clientX - d.dx))
    const y = Math.max(8, Math.min(window.innerHeight - 80, e.clientY - d.dy))
    setPos({ x, y })
  }
  const onHeaderUp = (e: React.PointerEvent) => {
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div
      role="dialog"
      aria-label="Recording studio"
      data-testid="recording-studio"
      className="fixed z-[70] w-[300px] rounded-dialog border border-border bg-bg-elevated shadow-pop"
      // Default to the LEFT so it never sits under the top-right quick-start
      // card or the transport; drag anywhere from there.
      style={pos ? { left: pos.x, top: pos.y } : { left: 16, top: 60 }}
    >
      <div
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        className="flex h-9 cursor-grab items-center gap-2 border-b border-border px-3 active:cursor-grabbing"
      >
        <GripHorizontal size={14} className="text-text-muted" aria-hidden />
        <span className="text-ui font-semibold text-text-primary">Record</span>
        <span className="ml-auto">
          <IconButton label="Close recording studio" data-testid="studio-close" onClick={closeStudio}>
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </span>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {/* Transport + live meter. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="studio-record"
            aria-label={recording ? 'Stop recording' : 'Record'}
            onClick={() => {
              // ⛔ THE PREVIEW IS THE RECORDER'S JOB NOW, not this button's. It
              // used to call ensurePlaying/pausePlayback here unconditionally,
              // which would have overridden the "play while recording" option and
              // left the switch doing nothing. startRecording honours the option
              // and remembers the spot so a discard can go back to it.
              if (recording) stopRecording()
              else void startRecording()
            }}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors duration-[120ms] ${
              recording ? 'bg-ember text-black' : 'bg-danger text-white hover:brightness-110'
            }`}
          >
            {recording ? (
              <Square size={16} strokeWidth={2} fill="currentColor" />
            ) : (
              <Mic size={18} strokeWidth={2} />
            )}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-ui-sm text-text-secondary">
                {recording ? (paused ? 'Paused' : 'Recording') : pending ? 'Review your take' : 'Ready'}
              </span>
              {recording && (
                <span
                  className={`font-numeric text-ui-sm ${paused ? 'text-text-muted' : 'text-ember'}`}
                  data-testid="studio-elapsed"
                >
                  {mmss}
                </span>
              )}
            </div>
            <LevelMeter />
          </div>
        </div>
        {recording && (
          <p className="-mt-1 text-ui-sm text-text-muted" data-testid="studio-dub-hint">
            {paused ? 'Space resumes the take and the preview.' : 'Space pauses the take and the preview, for dubbing to picture.'}
          </p>
        )}

        {/* The captured take: keep it or throw it away. */}
        {pending && (
          <div
            data-testid="studio-take"
            className="flex flex-col gap-2 rounded-field border border-border bg-bg-panel p-2"
          >
            <audio src={pending.url} controls className="h-8 w-full" data-testid="studio-take-audio" />
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="studio-keep"
                onClick={() => void keepTake()}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-field bg-accent text-ui-sm text-accent-fg hover:bg-accent-hover"
              >
                <Check size={14} strokeWidth={2} />
                Add to media
              </button>
              <button
                type="button"
                data-testid="studio-discard"
                onClick={discardTake}
                className="flex h-8 items-center justify-center gap-1.5 rounded-field border border-border px-3 text-ui-sm text-text-secondary hover:border-danger hover:text-danger"
              >
                <Trash2 size={14} strokeWidth={1.75} />
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Devices + monitoring. */}
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">Microphone</span>
            <select
              data-testid="studio-input"
              aria-label="Microphone"
              className={SELECT_CLS}
              value={selectedInputId ?? ''}
              onChange={(e) => setInputDevice(e.target.value || null)}
            >
              <option value="">System default</option>
              {inputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">Output</span>
            <select
              data-testid="studio-output"
              aria-label="Output device"
              disabled={!canPickOutput()}
              className={SELECT_CLS}
              value={selectedOutputId ?? ''}
              onChange={(e) => setOutputDevice(e.target.value || null)}
              title={canPickOutput() ? undefined : 'This browser always uses the system default output'}
            >
              <option value="">System default</option>
              {outputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${i + 1}`}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            data-testid="studio-monitor"
            aria-pressed={monitoring}
            onClick={() => setMonitoring(!monitoring)}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-field text-ui-sm transition-colors duration-[120ms] ${
              monitoring
                ? 'bg-accent text-accent-fg'
                : 'border border-border text-text-secondary hover:text-text-primary'
            }`}
            title="Route the mic to your output so you hear yourself. Use headphones: on speakers it feeds back."
          >
            <Headphones size={14} strokeWidth={1.75} />
            {monitoring ? 'Hearing yourself' : 'Hear myself'}
          </button>
          {monitoring && (
            <p className="text-ui-sm text-text-muted">Use headphones. On speakers this feeds back.</p>
          )}

          {/* His ask, 2026-08-12: an option to NOT start the preview. It sits
              beside "hear myself" because they are the same kind of choice,
              what happens around a take rather than what is captured. */}
          <button
            type="button"
            data-testid="studio-autoplay"
            aria-pressed={autoPlay}
            onClick={() => setAutoPlay(!autoPlay)}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-field text-ui-sm transition-colors duration-[120ms] ${
              autoPlay
                ? 'bg-accent text-accent-fg'
                : 'border border-border text-text-secondary hover:text-text-primary'
            }`}
            title="Play the timeline while you record, so you can perform against your edit. Throwing a take away puts the playhead back where you started it."
          >
            <Play size={14} strokeWidth={1.75} />
            {autoPlay ? 'Playing while you record' : 'Play while recording'}
          </button>
        </div>
      </div>
    </div>
  )
}
