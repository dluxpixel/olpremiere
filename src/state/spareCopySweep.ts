// The page's half of letting go of spare copies nothing uses (electron/mediaSweep.ts):
// say what the store uses, and only when nothing is being imported or exported.
//
// ⛔ HIS CALL, 2026-10-06: *"every 7 days"*. Main decides what goes and keeps
// everything it cannot prove is unused. This half only has to be COMPLETE: every
// asset the store's projects use, plus the open edit and every step of its undo
// history, because an Undo can bring a removed file back. And it never asks on a
// start that showed a loss (spareCopyHold.ts).

import type { Project } from '../engine/types'
import { assetIdsUsedBy as idsUsedBy } from '../../electron/assetIdsUsed'
import { useExportJob, isExportActive } from './exportJob'
import { useImportProgress } from './mediaActions'
import { db } from './persistence'
import { spareCopyCleanupHeld } from './spareCopyHold'
import { useStore } from './store'
import { usage } from './usageLog'

export interface SweepOutcome {
  removed: string[]
  freedBytes: number
  waiting: number
  refused?: string
  busy?: boolean
}

export interface SpareSweepApi {
  mediaSweepUnused(projectIds: string[], assetIds: string[]): Promise<SweepOutcome>
}

function shellApi(): SpareSweepApi | null {
  const api = (globalThis as { api?: Partial<SpareSweepApi> }).api
  return typeof api?.mediaSweepUnused === 'function' ? (api as SpareSweepApi) : null
}

/**
 * Every asset id a project could need a spare copy for: its media, and any id a
 * clip still points at, even one whose record is gone. The same definition main
 * reads the project files with (electron/assetIdsUsed.ts).
 */
export function assetIdsUsedBy(p: Project): string[] {
  return idsUsedBy(p)
}

/** True while media is coming in or a video is going out: the sweep waits for both. */
export function sweepMustWait(): boolean {
  if (useImportProgress.getState().total > 0) return true
  const job = useExportJob.getState().job
  return job !== null && isExportActive(job.stage)
}

/**
 * One run. Resolves to what main did, `'busy'` when it must wait, or null when
 * there is nothing to do it with (the web build), the store reads empty, or this
 * start showed a loss.
 */
export async function sweepSpareCopies(api: SpareSweepApi | null = shellApi()): Promise<SweepOutcome | 'busy' | null> {
  if (!api) return null
  if (spareCopyCleanupHeld()) return null
  if (sweepMustWait()) return 'busy'
  const projects = ((await (await db()).getAll('projects')) as Project[]).filter(Boolean)
  // A store that reads empty is a wiped one, never a reason to let anything go.
  if (projects.length === 0) return null
  const { project, history } = useStore.getState()
  const docs: Project[] = [project, ...projects]
  for (const c of [...history.undo, ...history.redo]) docs.push(c.before, c.after)
  const ids = new Set<string>()
  for (const doc of docs) if (doc) for (const id of assetIdsUsedBy(doc)) ids.add(id)
  // Checked again: an import may have started, or a loss been seen, while the store was read.
  if (spareCopyCleanupHeld()) return null
  if (sweepMustWait()) return 'busy'
  const result = await api.mediaSweepUnused(
    projects.map((p) => p.id),
    [...ids],
  )
  // A copy being written is "not now", the same as an import on the page.
  if (result.busy) return 'busy'
  // Into his usage log too, so a cleanup that keeps refusing can be seen. Only the
  // reason's first words: the rest can carry a project file's name.
  usage.record('session', 'spare-copies', {
    removed: result.removed.length,
    mb: Math.round(result.freedBytes / 1e6),
    waiting: result.waiting,
    refused: result.refused ? result.refused.split(':')[0]!.slice(0, 48) : undefined,
  })
  if (result.removed.length > 0) {
    console.log(
      `OL Premiere: let go of ${result.removed.length} spare cop${result.removed.length === 1 ? 'y' : 'ies'} nothing had used for 7 days (${Math.round(result.freedBytes / 1e6)} MB)`,
    )
  } else if (result.refused) console.log(`OL Premiere: spare copy cleanup skipped: ${result.refused}`)
  return result
}

/**
 * Once per start, a few minutes in, behind everything else. When an import, an
 * export or a spare copy write is running it tries again later, a few times,
 * then leaves it to the next start. Never throws.
 */
export function scheduleSpareCopySweep(firstAfterMs = 3 * 60_000, retryMs = 5 * 60_000, tries = 6): void {
  const attempt = (left: number): void => {
    void sweepSpareCopies()
      .then((r) => {
        if (r === 'busy' && left > 1) setTimeout(() => attempt(left - 1), retryMs)
      })
      .catch((err) => console.warn('OL Premiere: spare copy cleanup failed', err))
  }
  setTimeout(() => attempt(tries), firstAfterMs)
}
