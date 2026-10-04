import { X } from 'lucide-react'
import {
  cancelExport,
  closeExportDialog,
  exportPercent,
  fmtBytes,
  isExportActive,
  retryExport,
  setExportLoudness,
  useExportJob,
} from '../state/exportJob'
import { useSettings } from '../state/settings'
import { useToasts } from '../state/toasts'
import { Button, IconButton } from '../ui/Button'
import { useEscapeToClose } from '../ui/useEscapeToClose'

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const s = Math.round(seconds)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/**
 * Export is ONE BUTTON. Pressing it starts the export. There is no settings
 * screen, because there is nothing to decide: engine/export/exportPlan.ts picks
 * the best available settings from the sequence itself, the same way every time.
 *
 * This component only SHOWS the export: the save destination, the progress and
 * the result. The export itself lives in state/exportJob.ts and outlives it, so
 * on the desktop he can close this and keep working while the file is made.
 * His words, 2026-09-28: *"Make it so that while the video is exporting, I can
 * work on other videos too, because the export time is sometimes very long."*
 */
export function ExportDialog() {
  const open = useExportJob((s) => s.dialogOpen)
  const job = useExportJob((s) => s.job)
  const alreadyRunning = useExportJob((s) => s.alreadyRunning)
  const show = useToasts((s) => s.show)
  // The switch shows the remembered choice, which is also what a restarted
  // export runs with, so it flips the moment he clicks it.
  const platformLoudness = useSettings((s) => s.platformLoudness)

  const stage = job?.stage
  // The desktop export carries on without this dialog, so it closes at any
  // point. The browser's stays up while it encodes, as it always has: its
  // finished file needs a tap on this screen to reach Photos on a phone.
  const canClose = !job || !stage || !isExportActive(stage) || job.background || stage.kind === 'starting'

  // Listening while it is open even when it cannot close, so a dialog under it never takes the
  // key meant for this one.
  useEscapeToClose(() => {
    if (canClose) closeExportDialog()
  }, open)

  if (!open || !job || !stage) return null
  const { plan } = job

  const pct = exportPercent(stage)
  const eta =
    stage.kind === 'running' && stage.progress.framesDone > 3
      ? ((performance.now() - stage.startedAt) / 1000 / stage.progress.framesDone) *
        (stage.progress.framesTotal - stage.progress.framesDone)
      : NaN

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && canClose) closeExportDialog()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        data-testid="export-dialog"
        className="flex max-h-[88vh] w-[440px] max-w-[calc(100vw-24px)] flex-col rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="text-ui font-semibold text-text-primary">Export</span>
          {/* Which project this is: by the time he looks, he may have another
              one open behind it. */}
          <span className="min-w-0 truncate text-ui-sm text-text-muted" data-testid="export-project">
            {job.projectName}
          </span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={closeExportDialog} disabled={!canClose}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>

        {isExportActive(stage) && (
          <div className="flex flex-col gap-3 p-4" data-testid="export-progress">
            {alreadyRunning && (
              // One at a time: a second ffmpeg would fight the first for the
              // same machine. So Export shows the running one and says why.
              <p className="text-[12px] leading-5 text-text-primary" data-testid="export-already-running">
                A video is already exporting. Only one can export at a time, so press Export again when
                this one is done.
              </p>
            )}
            {/* What the app chose: a statement, not an offer. */}
            <p className="font-numeric text-[11px] text-text-muted" data-testid="export-plan">
              {plan.settings.width} × {plan.settings.height} · {plan.settings.fps} fps · H.264
              {plan.usingWorkArea ? ' · work area' : ''}
            </p>
            {/* The one export choice: his answer, "Yes, on by default". It
                changes THIS video (the export starts again with it) and is
                remembered for the next one. */}
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-[11px] text-text-muted">
                <span>Platform loudness</span>
                <input
                  type="checkbox"
                  aria-label="Platform loudness"
                  data-testid="export-loudness"
                  checked={platformLoudness}
                  onChange={(e) => setExportLoudness(e.target.checked)}
                  className="ml-auto h-3.5 w-3.5 cursor-default accent-accent"
                />
              </label>
              <span className="text-[10px] text-text-muted">
                Lands at the level YouTube, TikTok and Instagram play videos at, with a clean limiter and no
                distortion. Off keeps your mix as it is. Changing it starts this export again.
              </span>
            </div>

            {stage.kind === 'starting' && <p className="text-[12px] text-text-secondary">Choose where to save it…</p>}
            {stage.kind === 'running' && (
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
                <div className="mt-1 flex justify-end gap-2">
                  <Button variant="secondary" data-testid="export-cancel" onClick={cancelExport}>
                    Cancel
                  </Button>
                  {/* The dialog is only a window onto the export, so it can go
                      and the file keeps being made. The chip in the top bar
                      brings it back. */}
                  {job.background && (
                    <Button variant="primary" data-testid="export-keep-working" onClick={closeExportDialog}>
                      Keep working
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[13px] text-text-primary">
              {stage.share ? '' : 'Saved '}
              <span className="font-medium">{stage.fileName}</span>{' '}
              <span className="text-text-secondary">({fmtBytes(stage.sizeBytes)})</span>{' '}
              {stage.share ? 'is ready.' : stage.streamed ? 'where you chose.' : 'to your downloads.'}
            </p>
            <div className="flex justify-end gap-2">
              {stage.share && (
                <Button
                  variant="primary"
                  data-testid="export-share"
                  onClick={() => {
                    // Dismissing the sheet rejects with AbortError: not a failure,
                    // the video is still here to save on the next tap.
                    navigator.share({ files: [stage.share!] }).catch((err: unknown) => {
                      if (!(err instanceof DOMException && err.name === 'AbortError')) {
                        show('Could not open the share sheet. Try the button again', 'danger')
                      }
                    })
                  }}
                >
                  Save to Photos
                </Button>
              )}
              {stage.path && window.api?.exportReveal && (
                // The file was named but never the folder, and there was no way to
                // get to it from here: Explorer opens with it selected.
                <Button
                  variant="secondary"
                  data-testid="export-reveal"
                  onClick={() => void window.api?.exportReveal?.(stage.path!)}
                >
                  Show in folder
                </Button>
              )}
              <Button variant={stage.share ? 'secondary' : 'primary'} onClick={closeExportDialog}>
                Done
              </Button>
            </div>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[12px] leading-5 text-danger">{stage.message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeExportDialog}>
                Close
              </Button>
              <Button variant="primary" data-testid="export-retry" onClick={retryExport}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
