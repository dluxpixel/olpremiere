import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  canStreamToDisk,
  exportSequence,
  pickExportDestination,
  type ExportProgress,
} from '../engine/export'
import { planExport } from '../engine/export/exportPlan'
import { exportNative } from '../engine/export/nativeExport'
import { isElectron } from '../platform'
import { beginCriticalWork } from '../state/unloadGuard'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { Button, IconButton } from '../ui/Button'

/** The specific GPU-B-frame crash that a software retry fixes. */
function isBFrameCrash(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /monotonically|Timestamps must be|\bDTS\b|B-?frame/i.test(m)
}

type Stage =
  /** The save dialog is up; nothing is encoding yet, so the modal still closes. */
  | { kind: 'starting' }
  | { kind: 'running'; progress: ExportProgress; startedAt: number }
  /** `streamed` distinguishes "written where you chose" from "in your downloads". */
  | { kind: 'done'; sizeBytes: number; fileName: string; streamed: boolean }
  | { kind: 'error'; message: string }

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} KB`
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const s = Math.round(seconds)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/**
 * Export is ONE BUTTON. Pressing it starts the export — there is no settings
 * screen, because there is nothing to decide: engine/export/exportPlan.ts picks
 * the best available settings from the sequence itself, the same way every time.
 * This component is now only the save destination, the progress, and the result.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const show = useToasts((s) => s.show)

  // Frozen when the dialog opens: an edit landing mid-encode must not change
  // what is being rendered.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- frozen on purpose
  const plan = useMemo(() => planExport(activeSequence(project)), [])
  const [stage, setStage] = useState<Stage>({ kind: 'starting' })
  const abortRef = useRef<AbortController | null>(null)
  const startedRef = useRef(false)
  const mountedRef = useRef(false)

  // Stop the encode if the dialog is destroyed under it. StrictMode mounts,
  // unmounts and remounts every component in dev, so a naive cleanup would abort
  // the export it had just started (the controller exists synchronously on the
  // no-picker path). Deferring one task and cancelling on the remount tells a
  // real unmount apart from StrictMode's rehearsal.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      setTimeout(() => {
        if (!mountedRef.current) abortRef.current?.abort()
      }, 0)
    }
  }, [])

  const running = stage.kind === 'running'

  useEffect(() => {
    if (running) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

  const beginRunning = () =>
    setStage({
      kind: 'running',
      progress: {
        phase: 'preparing',
        framesDone: 0,
        framesTotal: Math.ceil((plan.settings.endS - plan.settings.startS) * plan.settings.fps),
      },
      startedAt: performance.now(),
    })

  const onProgress = (progress: ExportProgress) =>
    setStage((prev) => (prev.kind === 'running' ? { ...prev, progress } : prev))

  const fileName = `${project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}.mp4`

  const start = async () => {
    let handle: FileSystemFileHandle | null = null
    if (canStreamToDisk()) {
      try {
        handle = await pickExportDestination(fileName)
      } catch (err) {
        setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        return
      }
      // Picker dismissed: there is nothing to export to, and nothing to show.
      if (!handle) {
        onClose()
        return
      }
    }

    const abort = new AbortController()
    abortRef.current = abort
    const endCritical = beginCriticalWork()
    beginRunning()
    try {
      const runExport = (hw: 'prefer-hardware' | 'prefer-software') =>
        exportSequence(
          project,
          { ...plan.settings, hardwareAcceleration: hw },
          onProgress,
          abort.signal,
          handle ?? undefined,
        )

      // Constant quality already pins the software encoder; the retry only
      // matters on the VBR fallback, where a GPU B-frame crash is still possible.
      let blob: Blob | null
      try {
        blob = await runExport('prefer-software')
      } catch (err) {
        if (abort.signal.aborted || !isBFrameCrash(err)) throw err
        setStage((prev) =>
          prev.kind === 'running'
            ? { ...prev, progress: { ...prev.progress, phase: 'preparing', framesDone: 0 }, startedAt: performance.now() }
            : prev,
        )
        blob = await runExport('prefer-hardware')
      }

      let sizeBytes: number
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
        sizeBytes = blob.size
      } else {
        sizeBytes = (await handle!.getFile()).size
      }
      const savedAs = handle?.name ?? fileName
      setStage({ kind: 'done', sizeBytes, fileName: savedAs, streamed: !!handle })
      show(`Exported ${savedAs} (${fmtBytes(sizeBytes)})`, 'success')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') onClose()
      else setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      endCritical()
    }
  }

  // Desktop: render with the shared pipeline, encode with the bundled ffmpeg
  // (x264 veryslow at constant quality — the best file this app can produce).
  const startNative = async () => {
    const baseName = project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'
    const abort = new AbortController()
    abortRef.current = abort
    const endCritical = beginCriticalWork()
    beginRunning()
    try {
      const res = await exportNative(
        project,
        plan.settings,
        {
          encoder: plan.nativeEncoder,
          quality: plan.qp,
          suggestedName: `${baseName}.${plan.nativeExt}`,
        },
        onProgress,
        abort.signal,
      )
      if (res === null) {
        onClose() // save dialog dismissed
        return
      }
      const savedAs = res.outPath.split(/[\\/]/).pop() ?? `${baseName}.${plan.nativeExt}`
      setStage({ kind: 'done', sizeBytes: res.sizeBytes, fileName: savedAs, streamed: true })
      show(`Exported ${savedAs} (${fmtBytes(res.sizeBytes)})`, 'success')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') onClose()
      else setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      endCritical()
    }
  }

  const run = () => void (isElectron ? startNative() : start())

  // Start the moment the dialog opens. The ref guard survives StrictMode's
  // double mount in dev, which would otherwise open two save dialogs and run
  // two encodes over the same file.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, by the ref guard
  }, [])

  const pct =
    stage.kind === 'running' && stage.progress.framesTotal > 0
      ? Math.min(100, Math.round((stage.progress.framesDone / stage.progress.framesTotal) * 100))
      : 0
  const eta =
    stage.kind === 'running' && stage.progress.framesDone > 3
      ? ((performance.now() - stage.startedAt) / 1000 / stage.progress.framesDone) *
        (stage.progress.framesTotal - stage.progress.framesDone)
      : NaN

  const retry = () => {
    setStage({ kind: 'starting' })
    run()
  }

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
        className="flex max-h-[88vh] w-[440px] flex-col rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border px-4">
          <span className="text-ui font-semibold text-text-primary">Export</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={onClose} disabled={running}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>

        {(stage.kind === 'starting' || running) && (
          <div className="flex flex-col gap-3 p-4" data-testid="export-progress">
            {/* What the app chose — a statement, not an offer. */}
            <p className="font-numeric text-[11px] text-text-muted" data-testid="export-plan">
              {plan.settings.width} × {plan.settings.height} · {plan.settings.fps} fps · H.264
              {plan.usingWorkArea ? ' · work area' : ''}
            </p>

            {stage.kind === 'starting' ? (
              <p className="text-[12px] text-text-secondary">Choose where to save it…</p>
            ) : (
              <>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="flex items-center gap-1.5 capitalize text-ember">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember" aria-hidden />
                    {stage.progress.phase}…
                  </span>
                  <span className="font-numeric text-text-primary">{pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-bg-input">
                  <div
                    className="h-full rounded-full bg-ember transition-[width] duration-[120ms] ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between font-numeric text-[11px] text-text-muted">
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
              </>
            )}
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[13px] text-text-primary">
              Saved <span className="font-medium">{stage.fileName}</span>{' '}
              <span className="text-text-secondary">({fmtBytes(stage.sizeBytes)})</span>{' '}
              {stage.streamed ? 'where you chose.' : 'to your downloads.'}
            </p>
            <div className="flex justify-end">
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
              <Button variant="primary" data-testid="export-retry" onClick={retry}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
