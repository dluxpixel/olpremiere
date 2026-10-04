// The few calls the rest of the app makes into the usage log. Each one is a single
// line at the place that ALREADY knows the thing happened (the store's dispatch,
// the keymap, the export job), so the log never needs its own copy of that logic and
// a change in those files cannot silently stop it recording.
//
// Nothing in here imports the store: it is handed what it needs. That is what lets
// store.ts import it without a cycle, and it keeps this file the only door the
// hot paths go through, which is where the "it costs nothing" claim is measured.

import type { Project } from '../engine/types'
import { extensionOf, usage, type UsageDetails } from './usageLog'
import { editAction, extensionSummary, maskMessage } from './usageNames'

/** Assets that exist in `after` and did not in `before`: what an import just brought in. */
function newAssetNames(before: Project, after: Project): string[] {
  const out: string[] = []
  for (const id in after.assets) if (!(id in before.assets)) out.push(after.assets[id]!.name)
  return out
}

/**
 * An undoable edit was committed (store.dispatch). The label is the one the Undo
 * toast shows; usageNames turns it into a name that carries none of his material.
 * An edit that arrives with a merge key is one step of a run (typing, a scrub), so
 * the run is ONE line with a count instead of forty.
 */
export function noteEdit(
  label: string,
  mergeKey: string | undefined,
  before: Project,
  after: Project,
  tool: string,
  selected: number,
): void {
  if (!usage.isEnabled()) return
  const { kind, a, d } = editAction(label)
  if (mergeKey !== undefined && usage.repeat(kind, a)) return
  const details: UsageDetails = d ? { ...d } : {}
  if (mergeKey !== undefined) details.run = true
  if (selected > 0) details.sel = selected
  if (tool !== 'select') details.tool = tool
  if (kind === 'import') details.exts = extensionSummary(newAssetNames(before, after))
  usage.record(kind, a, details)
}

/**
 * Undo or redo. `ageMs` is how long ago the step he is taking back was made, which
 * is the cheapest honest signal of friction there is: an edit undone two seconds
 * after it happened was a miss, one undone an hour later was a change of mind.
 */
export function noteHistory(dir: 'undo' | 'redo', label: string, ageMs?: number): void {
  if (!usage.isEnabled()) return
  usage.record('history', dir, { of: editAction(label).a, age: ageMs === undefined ? undefined : Math.round(ageMs / 100) / 10 })
}

/**
 * A shortcut ran (keymap.ts), by key and by what it is for. A held key fires again
 * and again; those fold into the first press as a count, so holding an arrow is one
 * line that says how long, not a hundred.
 */
export function noteShortcut(combo: string, command: string, held: boolean): void {
  if (!usage.isEnabled()) return
  if (held && usage.repeat('key', combo, 400)) return
  usage.record('key', combo, { cmd: command })
}

// --- The export, one line per run ----------------------------------------------------

let endExport: ((more?: UsageDetails) => void) | null = null

/** What the export was asked to make, in numbers and names the app chose. */
export interface ExportNote {
  width: number
  height: number
  fps: number
  seconds: number
  encoder: string
  qp: number
  loudness: boolean
  workArea: boolean
  background: boolean
}

export function noteExportStart(n: ExportNote): void {
  // A run replaced by another (the loudness switch restarts it) ends where it was.
  endExport?.({ outcome: 'restarted' })
  endExport = usage.span('export', 'export', {
    w: n.width,
    h: n.height,
    fps: n.fps,
    sec: Math.round(n.seconds),
    enc: n.encoder,
    qp: n.qp,
    loud: n.loudness,
    area: n.workArea,
    bg: n.background,
  })
}

export function noteExportEnd(outcome: 'done' | 'failed' | 'cancelled', more?: { sizeBytes?: number; fileName?: string; error?: string }): void {
  const end = endExport
  endExport = null
  end?.({
    outcome,
    mb: more?.sizeBytes !== undefined ? Math.round(more.sizeBytes / 1e5) / 10 : undefined,
    ext: more?.fileName ? extensionOf(more.fileName) : undefined,
    err: more?.error ? maskMessage(more.error) : undefined,
  })
}
