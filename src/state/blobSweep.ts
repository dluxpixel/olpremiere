// Reclaim storage from media that NO project references any more.
//
// `blobGc.ts` has always been able to work out which stored keys are orphans.
// Nothing ever called it. So every video he imported and later deleted stayed in
// storage for good, and the space came back only if he happened to undo. That is
// what fills the origin quota and produces "No room left" on an import, with
// nothing visible in the app to explain it.
//
// THE RULE THAT MAKES THIS SAFE, AND IT IS NOT NEGOTIABLE
//
// A blob is deleted only when it is unreachable from EVERY stored project, not
// from the open one. Media is shared: the same key can be referenced by an
// archived project, or by one he has not opened in a month. Sweeping against the
// active project alone would delete footage belonging to the others, and this
// project has already destroyed 8.95 GB of his media once. Anything not
// recognised as project-owned media (Library keys, unknown prefixes) is kept
// unconditionally by orphanedBlobKeys, which is the second half of the guarantee.
//
// It runs ONCE per session, after boot, off the critical path.

import { orphanedBlobKeys } from '../engine/blobGc'
import { blobKeysWrittenThisSession, db } from './persistence'
import { useStore } from './store'
import type { Project } from '../engine/types'

export interface SweepResult {
  /** Keys deleted. */
  removed: number
  /** Projects the reachability union was built from. Zero means REFUSE, never sweep. */
  projectsScanned: number
  /** Keys examined. */
  examined: number
}

/**
 * Delete stored media that no project references.
 *
 * Returns counts rather than throwing on a partial failure: reclaiming space is
 * housekeeping and must never be able to take the app down or interrupt an edit.
 */
export async function sweepOrphanedBlobs(): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, projectsScanned: 0, examined: 0 }
  try {
    const d = await db()
    const projects = (await d.getAll('projects')) as Project[]
    // REFUSE on an empty read. Zero projects is indistinguishable from a failed
    // or not-yet-migrated read, and treating it as "nothing is reachable" would
    // delete every byte of media he owns. A real empty install has no blobs to
    // sweep anyway, so declining costs nothing and the downside is unbounded.
    if (projects.length === 0) return result
    result.projectsScanned = projects.length

    const allKeys = (await d.getAllKeys('blobs')) as string[]
    result.examined = allKeys.length
    if (allKeys.length === 0) return result

    // ANYTHING WRITTEN THIS SESSION IS OFF LIMITS. An import puts the bytes in
    // storage before the asset reaches the project and long before the project
    // reaches the disk, so a file that is still importing is invisible to every
    // stored document. That gap is how a running import lost its footage.
    const fresh = blobKeysWrittenThisSession()
    const keys = allKeys.filter((k) => !fresh.has(k))
    if (keys.length === 0) return result

    // ⛔ THE UNION IS EVERY DOCUMENT HE CAN STILL GET BACK TO, not only the ones
    // on disk. Deleting a bin item saves a project without it, and one Ctrl+Z
    // brings the item back; sweeping against the saved copies alone threw the
    // bytes away in between, so the undo restored a card with nothing behind it
    // and the media was gone for good. The open project counts for the same
    // reason: it can be seconds ahead of what was written.
    //
    // Snapshots share structure, so the same document object appears in many
    // commands. Deduping by identity keeps a 200 step history down to the
    // handful of distinct documents it really holds.
    const { project: liveProject, history } = useStore.getState()
    const documents = new Set<Project>([liveProject, ...projects])
    for (const c of [...history.undo, ...history.redo]) {
      documents.add(c.before)
      documents.add(c.after)
    }

    // Intersect: a key must be an orphan of EVERY document to be an orphan at all.
    let orphans = keys
    for (const doc of documents) {
      if (orphans.length === 0) break
      const stillOrphan = new Set(orphanedBlobKeys(orphans, doc))
      orphans = orphans.filter((k) => stillOrphan.has(k))
    }
    if (orphans.length === 0) return result

    for (const key of orphans) {
      try {
        await d.delete('blobs', key)
        result.removed++
      } catch {
        // One stubborn key must not abandon the rest of the sweep.
      }
    }
    if (result.removed > 0) {
      console.log(
        `OL Premiere: reclaimed ${result.removed} unused media file(s) from storage (${projects.length} projects checked)`,
      )
    }
  } catch (err) {
    console.warn('OL Premiere: storage sweep skipped', err)
  }
  return result
}
