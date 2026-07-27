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
  if (fingerprint === lastWritten) return
  writing = true
  try {
    await window.api!.backupWrite(project.name ?? 'project', json)
    lastWritten = fingerprint
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

/** For the Settings/restore UI and for tests. */
export const _internals = { backupNow }
