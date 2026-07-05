import { Download, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { exportSequence, type ExportProgress, type ExportSettings } from '../engine/export'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { Button, IconButton } from '../ui/Button'

interface ResolutionPreset {
  label: string
  width: number
  height: number
}

const RESOLUTIONS: ResolutionPreset[] = [
  { label: 'Sequence (1920×1080)', width: 1920, height: 1080 },
  { label: 'HD (1280×720)', width: 1280, height: 720 },
  { label: 'SD (640×360)', width: 640, height: 360 },
]

const BITRATES = [
  { label: 'High (24 Mbps)', value: 24_000_000 },
  { label: 'Medium (12 Mbps)', value: 12_000_000 },
  { label: 'Low (5 Mbps)', value: 5_000_000 },
]

type Stage =
  | { kind: 'settings' }
  | { kind: 'running'; progress: ExportProgress; startedAt: number }
  | { kind: 'done'; sizeBytes: number; fileName: string }
  | { kind: 'error'; message: string }

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} KB`
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

  const [resolution, setResolution] = useState(0)
  const [bitrate, setBitrate] = useState(1)
  const [stage, setStage] = useState<Stage>({ kind: 'settings' })
  const abortRef = useRef<AbortController | null>(null)

  // Cancel a running export if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  const fileName = `${project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}.mp4`
  const running = stage.kind === 'running'

  const start = async () => {
    const preset = RESOLUTIONS[resolution]
    const settings: ExportSettings = {
      width: preset.width,
      height: preset.height,
      fps: seq.fps,
      videoBitrate: BITRATES[bitrate].value,
    }
    const abort = new AbortController()
    abortRef.current = abort
    setStage({
      kind: 'running',
      progress: { phase: 'preparing', framesDone: 0, framesTotal: Math.ceil(seq.durationS * seq.fps) },
      startedAt: performance.now(),
    })
    try {
      const blob = await exportSequence(
        project,
        settings,
        (progress) =>
          setStage((prev) =>
            prev.kind === 'running' ? { ...prev, progress } : prev,
          ),
        abort.signal,
      )
      // Save as a download: works everywhere incl. headless verification.
      // The File System Access save-picker path is Phase 8 polish.
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setStage({ kind: 'done', sizeBytes: blob.size, fileName })
      show(`Exported ${fileName} (${fmtBytes(blob.size)})`, 'success')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStage({ kind: 'settings' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setStage({ kind: 'error', message })
      }
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
              Resolution
              <select
                data-testid="export-resolution"
                className="h-7 w-56 rounded-[4px] border border-border bg-bg-input px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                value={resolution}
                onChange={(e) => setResolution(Number(e.target.value))}
              >
                {RESOLUTIONS.map((r, i) => (
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
                value={bitrate}
                onChange={(e) => setBitrate(Number(e.target.value))}
              >
                {BITRATES.map((b, i) => (
                  <option key={b.label} value={i}>
                    {b.label}
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
              <span className="text-text-secondary">({fmtBytes(stage.sizeBytes)})</span> to your
              downloads.
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
