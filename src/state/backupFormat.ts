// The document as it is written to disk. Shared by the rotating backups
// (autoBackup.ts) and the per project files (persistence.ts), so a file from
// either folder is the same shape and opens in the same Recover shelf.
//
// A leaf on purpose: persistence.ts writes this on every save and autoBackup.ts
// imports persistence.ts, so the format cannot live in either without a cycle.

import type { Project } from '../engine/types'

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
