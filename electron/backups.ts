// Automatic project backups, written to ORDINARY FILES on disk.
//
// Why this exists, in one line: on 2026-07-26 an edit was lost, and the only
// thing that survived was a file the user had happened to save by hand.
//
// Everything else failed at once. The app's own save reported success while
// writing nothing (the flushSave bug, fixed in 0.1.11). The media survived in
// browser storage but the project record did not, so 9 GB of footage sat there
// with nothing pointing at it. Then the browser's storage housekeeping swept the
// orphaned media, because from its point of view nobody wanted it. At no point
// did anything say a word.
//
// The lesson is not "fix that bug". It is that a project living ONLY inside
// browser storage has a single point of failure that the user cannot see, cannot
// check, and cannot back up. A plain file in a normal folder survives all of it:
// a bug in our save path, a corrupt database, a profile that gets renamed, the
// browser deciding to reclaim space, and someone moving folders around by hand.
//
// So: the document is written to disk on a timer, and kept in a rotation. The
// MEDIA is not copied — a full self-contained project is over a gigabyte, and
// writing that every few minutes would be its own disaster. What is saved is the
// edit: every clip, cut, effect, keyframe and caption, plus the name of each
// media file it needs. That is the part that cannot be recreated. Footage can be
// re-imported; four hundred decisions cannot.

import { app } from 'electron'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** How many backups to keep. Small files, so keep enough to walk back a session. */
const KEEP = 40

/**
 * Documents, not userData: a backup that lives inside the thing it protects is
 * not a backup. userData is exactly what gets renamed, swept, reset by a
 * reinstall, or wiped when a profile goes wrong — the folder this whole feature
 * exists because of. Documents is somewhere the user can find, copy, and sync.
 */
export function backupDir(): string {
  return path.join(app.getPath('documents'), 'OL Premiere Backups')
}

/** `2026-07-26_1743-05_my-edit.olpbak` — sorts chronologically, reads plainly. */
function fileName(projectName: string, when: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}_${p(when.getHours())}${p(when.getMinutes())}-${p(when.getSeconds())}`
  const safe = (projectName || 'project').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 40) || 'project'
  return `${stamp}_${safe}.olpbak`
}

/**
 * Write one backup and prune the oldest beyond KEEP. Returns the path written.
 *
 * Pruning happens AFTER the new file is safely written, never before: the
 * failure mode to avoid is deleting an old backup and then failing to write the
 * new one, which would spend a good backup to gain nothing.
 */
export async function writeBackup(projectName: string, json: string): Promise<string> {
  const dir = backupDir()
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, fileName(projectName, new Date()))
  await writeFile(target, json, 'utf8')

  const entries = await readdir(dir)
  const mine = entries.filter((f) => f.endsWith('.olpbak'))
  if (mine.length > KEEP) {
    const withTime = await Promise.all(
      mine.map(async (f) => {
        try {
          return { f, t: (await stat(path.join(dir, f))).mtimeMs }
        } catch {
          return { f, t: Infinity } // unreadable: treat as newest so it is never the one deleted
        }
      }),
    )
    withTime.sort((a, b) => a.t - b.t)
    for (const { f } of withTime.slice(0, withTime.length - KEEP)) {
      try {
        await unlink(path.join(dir, f))
      } catch {
        // A locked or already-gone file must never fail the backup that just
        // succeeded. Pruning is housekeeping, not the job.
      }
    }
  }
  return target
}

/** Newest first, so a restore UI can offer the most recent without sorting. */
export async function listBackups(): Promise<{ name: string; path: string; sizeBytes: number; modifiedMs: number }[]> {
  const dir = backupDir()
  try {
    const entries = (await readdir(dir)).filter((f) => f.endsWith('.olpbak'))
    const out = await Promise.all(
      entries.map(async (name) => {
        const p = path.join(dir, name)
        const s = await stat(p)
        return { name, path: p, sizeBytes: s.size, modifiedMs: s.mtimeMs }
      }),
    )
    return out.sort((a, b) => b.modifiedMs - a.modifiedMs)
  } catch {
    return [] // no directory yet = no backups, not an error
  }
}
