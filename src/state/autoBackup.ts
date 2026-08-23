// Automatic backups of the EDIT to plain files on disk.
//
// The whole point: a project that exists only inside browser storage has a
// single point of failure the user cannot see. On 2026-07-26 an edit was lost
// because the app's save reported success while writing nothing, the media
// survived but the project record did not, and the browser then reclaimed the
// "unused" media. Nothing warned. The only copy that survived was a file the
// user had saved by hand.
//
// So the document goes to a real file, on a timer, forever, without being asked.
//
// What is saved and what is not:
//   SAVED      every clip, cut, transition, effect, keyframe, caption, track and
//              setting - the decisions, which cannot be recreated.
//   NOT SAVED  the media bytes. A self-contained project file is over a
//              gigabyte; writing that every couple of minutes would fill the disk
//              and stall the app, so it would end up switched off, which is worse
//              than useless. The document itself is only tens of kilobytes, and
//              each asset's NAME is recorded so a restore can say exactly which
//              files to re-import.
//
// Only writes when the document actually changed, so an idle app writes nothing.

import { listProjects, loadProjectById } from './persistence'
import { useStore } from './store'
import type { Project } from '../engine/types'

/** Quiet period between backups. Frequent enough to lose only minutes of work. */
const INTERVAL_MS = 2 * 60 * 1000

/** What a backup file contains. Versioned so a future reader can adapt. */
export interface BackupFile {
  kind: 'ol-premiere-backup'
  version: 1
  savedAt: string
  appVersion: string
  /** The project document, media stripped. */
  project: Project
  /** Asset id -> file name, so a restore can name the files to re-import. */
  mediaNames: Record<string, string>
}

/**
 * Collect each asset's file name for the restore message.
 *
 * Nothing needs stripping: an asset record holds only metadata and `blobKey` /
 * `thumbnailKey`, which are POINTERS into local storage, never the bytes. So the
 * document is already small and already media-free, and the whole project
 * serialises to tens of kilobytes. The keys are kept deliberately: after a
 * restore they still resolve if the media survived, and only need re-importing
 * if it did not.
 */
export function mediaNamesOf(project: Project): Record<string, string> {
  const names: Record<string, string> = {}
  for (const [id, a] of Object.entries(project.assets ?? {})) {
    if (a) names[id] = a.name ?? id
  }
  return names
}

export function serialize(project: Project, appVersion: string): string {
  const payload: BackupFile = {
    kind: 'ol-premiere-backup',
    version: 1,
    savedAt: new Date().toISOString(),
    appVersion,
    project,
    mediaNames: mediaNamesOf(project),
  }
  return JSON.stringify(payload)
}

let timer: number | null = null
let lastWritten = ''
let writing = false

/** True when the desktop shell is present, since only it can write files unprompted. */
const canWrite = (): boolean => typeof window !== 'undefined' && !!window.api?.isElectron

/**
 * What was last written for each project, keyed by project id.
 *
 * ⛔ PER PROJECT, NOT ONE STRING. It used to hold a single fingerprint for the
 * open document, which was all this ever backed up.
 */
const lastWrittenFor = new Map<string, string>()

/**
 * Back up EVERY project he has, not only the one on screen.
 *
 * ⛔ THIS IS THE FAULT THAT COST HIM HIS FINISHED WORK. 2026-08-23: *"I had a ton
 * of finished projects. I had a ton of projects on later and working on."* When
 * the browser threw its database away, the only thing with a copy on disk was
 * whatever he happened to have OPEN. Everything filed under Later or Finished had
 * never been written to a file at all, so there was nothing anywhere to bring
 * back and no honest way to tell him otherwise.
 *
 * Each project carries its own fingerprint, so one that has not changed writes
 * nothing: the cost of covering ten projects instead of one is ten reads and zero
 * writes. And the prune in `electron/backups.ts` will never delete the last copy
 * a project has, or this would age his finished work out a slower way.
 */
async function backupEveryProject(): Promise<void> {
  if (!canWrite()) return
  const openId = useStore.getState().project?.id
  let summaries: { id: string }[]
  try {
    summaries = await listProjects()
  } catch {
    return
  }
  for (const s of summaries) {
    if (s.id === openId) continue // the open one has just been written above
    try {
      const p = await loadProjectById(s.id)
      if (!p) continue
      const json = serialize(p, 'desktop')
      const fingerprint = json.replace(/"savedAt":"[^"]*"/, '')
      if (lastWrittenFor.get(s.id) === fingerprint) continue
      await window.api!.backupWrite(p.name ?? 'project', json)
      lastWrittenFor.set(s.id, fingerprint)
    } catch {
      // One unreadable project must never stop the others being written.
    }
  }
}

async function backupNow(reason: string): Promise<void> {
  if (!canWrite() || writing) return
  const project = useStore.getState().project
  if (!project) return
  let json: string
  try {
    json = serialize(project, window.api?.isElectron ? 'desktop' : 'web')
  } catch {
    return // a document that cannot be serialised must not take the app down
  }
  // Compare the payload MINUS its timestamp, or every tick looks like a change.
  const fingerprint = json.replace(/"savedAt":"[^"]*"/, '')
  // ⛔ THE SWEEP RUNS EVEN WHEN THE OPEN PROJECT HAS NOT CHANGED, and that is the
  // whole point of it. He can sit on one edit for an hour while nine others have
  // never been written to a file at all, which is exactly the state his machine
  // was in when the database threw itself away.
  if (fingerprint === lastWritten) {
    await backupEveryProject()
    return
  }
  writing = true
  try {
    await window.api!.backupWrite(project.name ?? 'project', json)
    lastWritten = fingerprint
    if (project.id) lastWrittenFor.set(project.id, fingerprint)
    // Then everything he is NOT looking at, which is what had no copy at all.
    await backupEveryProject()
  } catch {
    // Disk full, permissions, folder gone: a failed backup is not worth
    // interrupting an edit over, and the next tick will try again. It stays
    // silent by design. The loud warning belongs to the integrity check, which
    // tells the user when their data is actually at risk.
    void reason
  } finally {
    writing = false
  }
}

/**
 * Start backing up. Runs on a timer, and once more when the window is closing
 * (the close is the one that matters most, because it catches the last minutes
 * of work that the timer has not reached yet).
 */
export function initAutoBackup(): void {
  if (!canWrite() || timer !== null) return
  timer = window.setInterval(() => void backupNow('timer'), INTERVAL_MS)
  // `pagehide` fires on close where `beforeunload` is unreliable; the write is
  // best-effort at that point, which is why the timer exists as well.
  window.addEventListener('pagehide', () => void backupNow('closing'))
  // One shortly after boot, so a session that crashes early still leaves a copy.
  window.setTimeout(() => void backupNow('startup'), 20_000)
}

