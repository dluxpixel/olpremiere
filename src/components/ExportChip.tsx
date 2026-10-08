import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  cancelExport,
  dismissExportResult,
  exportPercent,
  isExportActive,
  openExportDialog,
  openExportResult,
  useExportJob,
} from '../state/exportJob'
import { createArmedDelete, type ArmedDelete } from './armedDelete'

/**
 * The running export, small, in the top bar, while he works on something else.
 *
 * His words, 2026-09-28: *"Make it so that while the video is exporting, I can
 * work on other videos too, because the export time is sometimes very long."*
 * With the export dialog closed this is the only sign one is running, so it
 * carries the percent and WHICH project, since the one on screen may be
 * another. A click brings the dialog back.
 *
 * ⛔ IT STAYS WHEN THE EXPORT ENDS, until he clicks it: "Done, show it" opens the
 * folder, "Export failed, see why" opens the dialog on the reason. It used to
 * vanish with the export, so one that failed while he was in another app left
 * only a toast that was gone 7 seconds later (export audit, 2026-10-06).
 *
 * ⛔ THE STOP TAKES TWO CLICKS. It sits in the bar for the whole export, beside
 * buttons he uses all the time, and one stray click would throw away minutes of
 * encoding. Same safety catch as the bin's Remove, his call 2026-08-09: *"of
 * course the delete thing you'd have to click twice"*.
 */
export function ExportChip() {
  const job = useExportJob((s) => s.job)
  const dialogOpen = useExportJob((s) => s.dialogOpen)
  const [armed, setArmed] = useState(false)
  const armRef = useRef<ArmedDelete | null>(null)
  if (!armRef.current) armRef.current = createArmedDelete({ onChange: setArmed })
  const arm = armRef.current
  useEffect(() => () => arm.dispose(), [arm])

  // Only the desktop export runs behind his back. The browser's keeps its
  // dialog up to the end, so a chip there would only repeat it.
  if (!job || !job.background) return null
  if (!isExportActive(job.stage)) {
    // With the dialog open the dialog already says how it ended.
    if (dialogOpen || (job.stage.kind !== 'done' && job.stage.kind !== 'error')) return null
    const failed = job.stage.kind === 'error'
    return (
      <div
        data-testid="export-chip"
        data-ended={failed ? 'failed' : 'done'}
        className={`flex h-7 min-w-0 items-stretch overflow-hidden rounded-field border text-ui-sm ${
          failed ? 'border-danger/40 bg-danger/15 text-danger' : 'border-success/40 bg-success/15 text-success'
        }`}
      >
        <button
          type="button"
          data-testid="export-chip-open"
          title={failed ? `The export of ${job.projectName} failed. Click to see why` : 'Click to see the video in its folder'}
          onClick={openExportResult}
          className={`flex min-w-0 cursor-default items-center gap-1.5 pl-2.5 pr-1.5 transition-colors duration-[120ms] ease-out ${
            failed ? 'hover:bg-danger/10' : 'hover:bg-success/10'
          }`}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
          <span className="whitespace-nowrap">{failed ? 'Export failed, see why' : 'Done, show it'}</span>
          <span className="max-w-[160px] truncate text-text-secondary">{job.projectName}</span>
        </button>
        <button
          type="button"
          data-testid="export-chip-dismiss"
          aria-label="Hide this"
          title="Hide this"
          onClick={dismissExportResult}
          className={`flex cursor-default items-center border-l px-1.5 transition-colors duration-[120ms] ease-out ${
            failed ? 'border-danger/30 hover:bg-danger/10' : 'border-success/30 hover:bg-success/10'
          }`}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    )
  }
  const pct = exportPercent(job.stage)

  return (
    <div
      data-testid="export-chip"
      className="flex h-7 min-w-0 items-stretch overflow-hidden rounded-field border border-ember/40 bg-ember-quiet text-ui-sm text-ember"
    >
      <button
        type="button"
        data-testid="export-chip-open"
        title={`Exporting ${job.projectName}. Click to see it`}
        onClick={openExportDialog}
        className="flex min-w-0 cursor-default items-center gap-1.5 pl-2.5 pr-1.5 transition-colors duration-[120ms] ease-out hover:bg-ember/10"
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ember" aria-hidden />
        <span className="font-numeric">{pct}%</span>
        <span className="max-w-[160px] truncate text-text-secondary">{job.projectName}</span>
      </button>
      <button
        type="button"
        data-testid="export-chip-cancel"
        data-armed={armed ? 'true' : undefined}
        aria-label={armed ? 'Click again to stop the export' : 'Stop the export'}
        title={armed ? 'Click again to stop it. It stops asking after a few seconds.' : 'Stop the export. Takes two clicks.'}
        onClick={() => {
          if (arm.press() === 'confirmed') cancelExport()
        }}
        // A stop armed a minute ago must never be finished by a click aimed at
        // something else.
        onBlur={() => arm.disarm()}
        className={`flex cursor-default items-center border-l border-ember/30 px-1.5 transition-colors duration-[120ms] ease-out ${
          armed ? 'bg-danger/20 font-medium text-danger hover:bg-danger/30' : 'hover:bg-danger/15 hover:text-danger'
        }`}
      >
        {armed ? 'Stop' : <X size={14} strokeWidth={1.5} />}
      </button>
    </div>
  )
}
