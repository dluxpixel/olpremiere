// Say something when the stored data does not add up.
//
// This is the other half of the 2026-07-26 loss, and the more important half.
// The app opened a store holding gigabytes of media and ZERO projects, and
// reported "No media yet": cheerful, instant, and wrong. Nothing was checked and
// nothing was said, so the user spent hours believing their edit was deleted when
// what had actually happened was that the project record never persisted.
//
// A fast startup that verifies nothing is not fast, it is silent. One cheap
// count-and-compare at boot is the difference between "your data looks wrong,
// here is where your backups are" and a blank timeline that explains nothing.

import { db } from './persistence'

export interface IntegrityReport {
  projectCount: number
  blobCount: number
  /** Media exists but nothing references it: the exact state that hid the loss. */
  orphanedMedia: boolean
  /** Storage is readable but completely empty, meaning a genuinely new install. */
  empty: boolean
}

/**
 * Count what is actually in storage. Cheap: counts only, never reads a blob.
 *
 * Deliberately tolerant. If this throws, the app must still start. A broken
 * integrity check that blocks boot would be a worse bug than the one it exists
 * to report.
 *
 * It validates COUNTS, never document shape, so nothing here can strip a field
 * off a keyframe. Anything added to this file that walks a project and rejects
 * or rewrites what it does not recognise has to carry `Keyframe.curve`, or a
 * hand-shaped curve is flattened back to its named ease on load and the only
 * symptom is that a project he already shipped from opens moving differently.
 */
export async function checkIntegrity(): Promise<IntegrityReport | null> {
  try {
    const d = await db()
    const [projectCount, blobCount] = await Promise.all([d.count('projects'), d.count('blobs')])
    return {
      projectCount,
      blobCount,
      // A handful of stray blobs is normal (a thumbnail, a half-finished import).
      // Many blobs and no project at all is not: that is an edit whose document
      // is missing, which is precisely what went unreported.
      orphanedMedia: projectCount === 0 && blobCount >= 3,
      empty: projectCount === 0 && blobCount === 0,
    }
  } catch {
    return null
  }
}

/** The sentence the user sees. Null when everything is fine. */
export function integrityMessage(r: IntegrityReport | null): string | null {
  if (!r || r.empty || !r.orphanedMedia) return null
  return `Your media is here (${r.blobCount} files) but no project references it. An edit may have failed to save. Check your backups before making changes.`
}
