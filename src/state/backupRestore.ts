// Putting a backup back.
//
// ⛔ THE BACKUPS HAVE BEEN WRITTEN FAITHFULLY SINCE 2026-07-26 AND THERE WAS NO
// WAY TO GET ONE BACK. Every couple of minutes the whole edit went to a plain
// file on his disk, forty of them kept in rotation, and the only thing the app
// offered him was a button that opens the folder. So when he opened the editor
// on 2026-08-19 and his projects were not there, the honest state of things was
// that his work was two clicks away and no click existed. His words: *"every
// time you work on a new version, all my saved data gets deleted."* It was not
// deleted. It was unreachable, which felt exactly the same and cost the same.
//
// A restore NEVER overwrites. It lands as a new project with its own id, so
// recovering the wrong one costs nothing and he can try again. Whatever he had
// open stays exactly where it was.
//
// The media is not in a backup and does not need to be: an asset record holds
// the KEY of its bytes, not the bytes, and the bytes live in local storage which
// usually survives whatever took the project record. When some of it really is
// gone, this says which files to re-import by name rather than leaving him to
// work it out from a timeline full of black rectangles.

import { migrateProjectEffects } from '../engine/effects/migrate'
import { migrateProject, newId, type Project } from '../engine/types'
import type { BackupFile } from './autoBackup'
import { getBlob, saveProject } from './persistence'
import { openProject } from './projectActions'
import { useToasts } from './toasts'

export interface BackupRow {
  /** Full path, and the only thing main will read back. */
  path: string
  name: string
  savedAtMs: number
  sizeBytes: number
}

/** What one backup file turns out to hold, once it has been read and parsed. */
export interface BackupContents {
  project: Project
  mediaNames: Record<string, string>
  clipCount: number
  assetCount: number
}

/** Every backup on disk, newest first. Empty when there is no desktop shell. */
export async function listBackups(): Promise<BackupRow[]> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.backupList) return []
  const rows = await api.backupList()
  return rows
    .map((r) => ({ path: r.path, name: r.name, savedAtMs: r.modifiedMs, sizeBytes: r.sizeBytes }))
    .sort((a, b) => b.savedAtMs - a.savedAtMs)
}

/**
 * Read one backup and say what is in it, WITHOUT changing anything.
 *
 * The counts are the whole point of the panel: forty files with near-identical
 * names tell him nothing, and "115 clips, 40 media" tells him which one is the
 * afternoon he does not want to lose.
 */
export async function readBackup(filePath: string): Promise<BackupContents | null> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.backupRead) return null
  let parsed: BackupFile
  try {
    parsed = JSON.parse(await api.backupRead(filePath)) as BackupFile
  } catch {
    return null
  }
  const raw = parsed?.project
  if (!raw || typeof raw !== 'object') return null
  // The same two migrations a project gets when it is loaded from storage. A
  // backup can be weeks old, so it arrives in whatever shape that version wrote.
  const project = migrateProjectEffects(migrateProject(raw))
  const clipCount = Object.values(project.sequences ?? {}).reduce(
    (n, sq) => n + sq.tracks.reduce((m, t) => m + t.clips.length, 0),
    0,
  )
  return {
    project,
    mediaNames: parsed.mediaNames ?? {},
    clipCount,
    assetCount: Object.keys(project.assets ?? {}).length,
  }
}

/** How many of this project's assets still have their bytes in local storage. */
async function countLiveMedia(project: Project): Promise<{ have: number; missing: string[] }> {
  const assets = Object.values(project.assets ?? {})
  let have = 0
  const missing: string[] = []
  for (const a of assets) {
    if (!a?.blobKey) continue
    // Title and adjustment clips carry no media, so they are not counted either way.
    if (await getBlob(a.blobKey)) have += 1
    else missing.push(a.name ?? a.blobKey)
  }
  return { have, missing }
}

/**
 * Put a backup back as a NEW project and open it.
 *
 * A fresh id, and a fresh id for every sequence too, because the ids in the file
 * may still be in use by something he has open. Two projects sharing a sequence
 * id would have them saving over each other, which is a worse bug than the one
 * being recovered from.
 */
export async function restoreBackup(filePath: string): Promise<boolean> {
  const contents = await readBackup(filePath)
  if (!contents) {
    useToasts.getState().show('That backup could not be read', 'danger')
    return false
  }
  const { project } = contents
  const sequenceIdMap = new Map<string, string>()
  const sequences: Project['sequences'] = {}
  for (const [oldId, sq] of Object.entries(project.sequences ?? {})) {
    const freshId = newId()
    sequenceIdMap.set(oldId, freshId)
    sequences[freshId] = { ...sq, id: freshId }
  }
  const activeSequenceId =
    sequenceIdMap.get(project.activeSequenceId) ?? Object.keys(sequences)[0] ?? project.activeSequenceId

  const restored: Project = {
    ...project,
    id: newId(),
    name: `${project.name ?? 'Untitled Project'} (recovered)`,
    sequences,
    activeSequenceId,
    createdAt: project.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  // Recovering something he had filed away should not file the recovery away too.
  delete restored.archivedAt
  delete restored.laterAt

  try {
    await saveProject(restored)
  } catch (err) {
    console.error('OL Premiere: could not save the restored project', err)
    useToasts.getState().show('The recovered project could not be saved', 'danger')
    return false
  }

  await openProject(restored.id)

  const { missing } = await countLiveMedia(restored)
  if (missing.length === 0) {
    useToasts.getState().show(`Recovered ${contents.clipCount} clips`, 'success')
  } else {
    // Naming the files is the difference between a fixable problem and a mystery.
    const head = missing.slice(0, 3).join(', ')
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : ''
    useToasts
      .getState()
      .show(`Recovered the edit. ${missing.length} media files need importing again: ${head}${rest}`, 'info', undefined, {
        durationMs: 15_000,
      })
  }
  return true
}
