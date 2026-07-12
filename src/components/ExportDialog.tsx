import { Download, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  canStreamToDisk,
  exportSequence,
  pickExportDestination,
  type ExportProgress,
  type ExportSettings,
} from '../engine/export'
import { losslessBitrate } from '../engine/export/bitrate'
import { beginCriticalWork } from '../state/unloadGuard'
import { activeSequence } from '../engine/types'
import { workArea } from '../engine/workArea'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { Button, IconButton } from '../ui/Button'

interface ResolutionPreset {
  label: string
  width: number
  height: number
}

/** Largest even-dimension box that fits seq within (boxW×boxH), keeping aspect. */
function evenFit(seqW: number, seqH: number, boxW: number, boxH: number): { width: number; height: number } {
  const s = Math.min(1, boxW / seqW, boxH / seqH)
  return {
    width: Math.max(2, Math.round((seqW * s) / 2) * 2),
    height: Math.max(2, Math.round((seqH * s) / 2) * 2),
  }
}

/**
 * Export presets PRESERVE the sequence aspect (so a 9:16 Shorts sequence exports
 * vertical, never stretched). For a 1920×1080 sequence these are the classic
 * Sequence / 1280×720 / 640×360.
 */
function buildResolutions(seqW: number, seqH: number): ResolutionPreset[] {
  const full = evenFit(seqW, seqH, seqW, seqH)
  const hd = evenFit(seqW, seqH, 1280, 720)
  const sd = evenFit(seqW, seqH, 640, 360)
  return [
    { label: `Sequence (${full.width}×${full.height})`, ...full },
    { label: `HD (${hd.width}×${hd.height})`, ...hd },
    { label: `SD (${sd.width}×${sd.height})`, ...sd },
  ]
}

// `max` computes a near-lossless target from the chosen resolution at export
// time (see losslessBitrate); the rest are fixed. Listed best-first so the
// highest-quality "1:1 to source" option is the most prominent.
const BITRATES = [
  { key: 'max', label: 'Maximum (1:1 — near-lossless)', value: null },
  { key: 'high', label: 'High (24 Mbps)', value: 24_000_000 },
  { key: 'medium', label: 'Medium (12 Mbps)', value: 12_000_000 },
  { key: 'low', label: 'Low (5 Mbps)', value: 5_000_000 },
] as const

// GPU is fast but some GPUs emit B-frames the muxer can't handle (the export
// crashes); software (openh264) never does. Auto uses the GPU and falls back to
// software only if it actually crashes — so most people get GPU speed and nobody
// hits the crash. The choice is remembered.
type EncoderMode = 'auto' | 'gpu' | 'software'
const ENCODER_KEY = 'reel:export:encoder'
const ENCODERS: { key: EncoderMode; label: string }[] = [
  { key: 'auto', label: 'Auto (GPU, else software)' },
  { key: 'gpu', label: 'GPU (fastest)' },
  { key: 'software', label: 'Software (most compatible)' },
]
function loadEncoderMode(): EncoderMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(ENCODER_KEY) : null
    return v === 'gpu' || v === 'software' || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
function saveEncoderMode(m: EncoderMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ENCODER_KEY, m)
  } catch {
    // ignore storage failures
  }
}
/** The specific GPU-B-frame crash that a software retry fixes. */
export function isBFrameCrash(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /monotonically|Timestamps must be|\bDTS\b|B-?frame/i.test(m)
}

type Stage =
  | { kind: 'settings' }
  | { kind: 'running'; progress: ExportProgress; startedAt: number }
  /** `streamed` distinguishes "written where you chose" from "in your downloads". */
  | { kind: 'done'; sizeBytes: number; fileName: string; streamed: boolean }
  | { kind: 'error'; message: string }

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} KB`
}

/** A duration for the range picker: "4.5s" reads better than a full timecode here. */
function fmtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  return `${m}m ${Math.round(seconds - m * 60)}s`
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/** MP4 export is the one accent-primary flow in the app (spec §3). */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const seq = activeSequence(project)
  const show = useToasts((s) => s.show)

  const resolutions = buildResolutions(seq.width, seq.height)
  const [resolution, setResolution] = useState(0)
  const [bitrateKey, setBitrateKey] = useState<string>('medium')
  const [encoder, setEncoder] = useState<EncoderMode>(loadEncoderMode)
  const [stage, setStage] = useState<Stage>({ kind: 'settings' })
  const abortRef = useRef<AbortController | null>(null)

  // Default to the work area when one exists: someone who just set in/out points
  // almost always means to render that bit.
  const area = workArea(seq)
  const [useWorkArea, setUseWorkArea] = useState(area.active)
  const range = useWorkArea && area.active ? area : { startS: 0, endS: seq.durationS }

  // Cancel a running export if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  const fileName = `${project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}.mp4`
  const running = stage.kind === 'running'

  const start = async () => {
    const preset = resolutions[resolution]
    const bopt = BITRATES.find((b) => b.key === bitrateKey) ?? BITRATES[2]
    // "Maximum" targets a near-lossless rate computed from the export raster; the
    // rest are fixed values.
    const videoBitrate = bopt.value ?? losslessBitrate(preset.width, preset.height, seq.fps)
    const settings: ExportSettings = {
      width: preset.width,
      height: preset.height,
      fps: seq.fps,
      videoBitrate,
      startS: range.startS,
      endS: range.endS,
    }

    // Ask for the destination FIRST: showSaveFilePicker needs transient user
    // activation, which any await before it would spend. Chunks then stream
    // straight to disk, so peak memory does not grow with the movie's length.
    // Firefox has no picker; it buffers and downloads instead (spec §3).
    let handle: FileSystemFileHandle | null = null
    if (canStreamToDisk()) {
      try {
        handle = await pickExportDestination(fileName)
      } catch (err) {
        setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        return
      }
      // Dismissing the picker is a normal "never mind", not an error.
      if (!handle) return
    }

    const abort = new AbortController()
    abortRef.current = abort
    // Arm the beforeunload guard: closing the tab now would throw away minutes
    // of encoding and leave a half-written file. Disarmed in `finally`.
    const endCritical = beginCriticalWork()
    setStage({
      kind: 'running',
      progress: {
        phase: 'preparing',
        framesDone: 0,
        framesTotal: Math.ceil((range.endS - range.startS) * seq.fps),
      },
      startedAt: performance.now(),
    })
    try {
      const runExport = (hw: 'prefer-hardware' | 'prefer-software') =>
        exportSequence(
          project,
          { ...settings, hardwareAcceleration: hw },
          (progress) => setStage((prev) => (prev.kind === 'running' ? { ...prev, progress } : prev)),
          abort.signal,
          handle ?? undefined,
        )

      let blob: Blob | null
      if (encoder === 'software') {
        blob = await runExport('prefer-software')
      } else if (encoder === 'gpu') {
        blob = await runExport('prefer-hardware')
      } else {
        // Auto: fast GPU first; if THIS GPU emits B-frames the muxer can't mux,
        // silently retry on the software encoder (which never does). The GPU
        // attempt crashes at the first B-frame — early — so little is wasted.
        try {
          blob = await runExport('prefer-hardware')
        } catch (err) {
          if (abort.signal.aborted || !isBFrameCrash(err)) throw err
          setStage((prev) =>
            prev.kind === 'running'
              ? { ...prev, progress: { ...prev.progress, phase: 'preparing', framesDone: 0 }, startedAt: performance.now() }
              : prev,
          )
          blob = await runExport('prefer-software')
        }
      }

      let sizeBytes: number
      if (blob) {
        // Buffered fallback: hand the bytes to the browser as a download.
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
        sizeBytes = blob.size
      } else {
        // Streamed: the bytes are already on disk. Ask the file how big it is.
        sizeBytes = (await handle!.getFile()).size
      }
      const savedAs = handle?.name ?? fileName
      setStage({ kind: 'done', sizeBytes, fileName: savedAs, streamed: !!handle })
      show(`Exported ${savedAs} (${fmtBytes(sizeBytes)})`, 'success')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStage({ kind: 'settings' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setStage({ kind: 'error', message })
      }
    } finally {
      endCritical()
    }
  }

  const pct =
    stage.kind === 'running' && stage.progress.framesTotal > 0
      ? Math.min(100, Math.round((stage.progress.framesDone / stage.progress.framesTotal) * 100))
      : 0
  const eta =
    stage.kind === 'running' && stage.progress.framesDone > 3
      ? ((performance.now() - stage.startedAt) / 1000 / stage.progress.framesDone) *
        (stage.progress.framesTotal - stage.progress.framesDone)
      : NaN

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        data-testid="export-dialog"
        className="w-[420px] rounded-[6px] border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 items-center border-b border-border px-4">
          <span className="text-[16px] font-semibold">Export</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={onClose} disabled={running}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>

        {stage.kind === 'settings' && (
          <div className="flex flex-col gap-3 p-4">
            <label className="flex items-center justify-between gap-3 text-[12px] text-text-secondary">
              Range
              <select
                data-testid="export-range"
                aria-label="Export range"
                className="h-7 w-56 rounded-[4px] border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none disabled:opacity-40"
                value={useWorkArea ? 'workArea' : 'sequence'}
                disabled={!area.active}
                onChange={(e) => setUseWorkArea(e.target.value === 'workArea')}
              >
                <option value="sequence">Entire sequence ({fmtSeconds(seq.durationS)})</option>
                {area.active && (
                  <option value="workArea">Work area ({fmtSeconds(area.endS - area.startS)})</option>
                )}
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 text-[12px] text-text-secondary">
              Resolution
              <select
                data-testid="export-resolution"
                className="h-7 w-56 rounded-[4px] border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                value={resolution}
                onChange={(e) => setResolution(Number(e.target.value))}
              >
                {resolutions.map((r, i) => (
                  <option key={r.label} value={i}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 text-[12px] text-text-secondary">
              Bitrate
              <select
                data-testid="export-bitrate"
                className="h-7 w-56 rounded-[4px] border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                value={bitrateKey}
                onChange={(e) => setBitrateKey(e.target.value)}
              >
                {BITRATES.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 text-[12px] text-text-secondary">
              Encoder
              <select
                data-testid="export-encoder"
                title="GPU is fastest; some GPUs crash the export — Software always works. Auto tries GPU, falls back to Software."
                className="h-7 w-56 rounded-[4px] border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                value={encoder}
                onChange={(e) => {
                  const m = e.target.value as EncoderMode
                  setEncoder(m)
                  saveEncoderMode(m)
                }}
              >
                {ENCODERS.map((en) => (
                  <option key={en.key} value={en.key}>
                    {en.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center justify-between text-[12px] text-text-secondary">
              <span>Format</span>
              <span className="text-text-primary">
                H.264 MP4 · {seq.fps} fps · {fmtEta(seq.durationS)} of video
              </span>
            </div>
            <p className="text-[11px] leading-4 text-text-muted">
              Encoded locally with WebCodecs — your footage never leaves this machine.
            </p>
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="export-start"
                onClick={() => void start()}
                disabled={seq.durationS <= 0}
              >
                <Download size={16} strokeWidth={1.5} />
                Export
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'running' && (
          <div className="flex flex-col gap-3 p-4" data-testid="export-progress">
            <div className="flex items-center justify-between text-[12px]">
              <span className="capitalize text-text-secondary">{stage.progress.phase}…</span>
              <span className="tabular-nums text-text-primary">{pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-input">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-[120ms] ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] tabular-nums text-text-muted">
              <span>
                {stage.progress.framesDone} / {stage.progress.framesTotal} frames
              </span>
              <span>ETA {fmtEta(eta)}</span>
            </div>
            <div className="mt-1 flex justify-end">
              <Button
                variant="secondary"
                data-testid="export-cancel"
                onClick={() => abortRef.current?.abort()}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[13px] text-text-primary">
              Saved <span className="font-medium">{stage.fileName}</span>{' '}
              <span className="text-text-secondary">({fmtBytes(stage.sizeBytes)})</span>{' '}
              {stage.streamed ? 'where you chose.' : 'to your downloads.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setStage({ kind: 'settings' })}>
                Export again
              </Button>
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[12px] leading-5 text-danger">{stage.message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={() => setStage({ kind: 'settings' })}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
