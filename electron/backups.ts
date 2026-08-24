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
// MEDIA is not copied. A full self-contained project is over a gigabyte, and
// writing that every few minutes would be its own disaster. What is saved is the
// edit: every clip, cut, effect, keyframe and caption, plus the name of each
// media file it needs. That is the part that cannot be recreated. Footage can be
// re-imported; four hundred decisions cannot.

import { app } from 'electron'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** How many backups to keep. Small files, so keep enough to walk back a session. */
const KEEP = 40

/**
 * Documents, not userData: a backup that lives inside the thing it protects is
 * not a backup. userData is exactly what gets renamed, swept, reset by a
 * reinstall, or wiped when a profile goes wrong: the folder this whole feature
 * exists because of. Documents is somewhere the user can find, copy, and sync.
 *
 * ⛔ A THROWAWAY PROFILE GETS ITS OWN FOLDER, AND THIS IS NOT A DETAIL.
 *
 * `--user-data-dir` moves the saved projects somewhere disposable, which is how
 * the test harnesses and the lab build keep away from his editor. It does NOT
 * move Documents. So every automated run was writing its fixture backups into
 * HIS backup folder, and with a rotation of forty the fixtures pushed his real
 * ones out: on 2026-08-19 roughly half of what was left in there belonged to a
 * caption harness rather than to him. A safety net that a test run can empty is
 * not one. So the moment the profile is not the real one, the backups follow it
 * instead, and his folder is only ever written by his app.
 */
export function backupDir(): string {
  // ⛔ ONLY HIS APP WRITES INTO HIS DOCUMENTS. Nothing else, not a test run and
  // not the bench copy. His words, 2026-08-20: *"make sure i dont ever
  // accidentally click your version."* A folder of mine sitting beside his in
  // Documents is a smaller version of the same mistake, so the lab keeps its
  // backups inside its own profile where he will never meet them.
  const throwaway = process.argv.some((a) => a.startsWith('--user-data-dir='))
  const name = app.getName()
  if (throwaway || name.toLowerCase().includes('lab')) return path.join(app.getPath('userData'), 'Backups')
  return path.join(app.getPath('documents'), `${name} Backups`)
}

/**
 * `2026-07-26_1743-05_ab9fe413_my-edit.olpbak`, which sorts chronologically and
 * reads plainly.
 *
 * ⛔ THE PROJECT ID IS IN THE NAME BECAUSE EVERY PROJECT OF HIS IS CALLED THE
 * SAME THING. The stamp is seconds-resolution and `backupEveryProject` writes
 * the whole shelf in one tight loop, so several land inside the same second,
 * and a name built from the timestamp and "Untitled Project" is the same name
 * for all of them. `writeFile` then overwrites, and the sweep still records
 * every one as written, so the losers are marked done and never retried. A
 * finished project never changes again, so its fingerprint never changes, and
 * it would sit there unbacked forever. Found 2026-08-24, after the wipe that
 * cost him three days, in the very code added to stop that happening again.
 */
function fileName(projectName: string, when: Date, projectId?: string): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}_${p(when.getHours())}${p(when.getMinutes())}-${p(when.getSeconds())}`
  const safe = (projectName || 'project').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 40) || 'project'
  const short = (projectId ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return short ? `${stamp}_${short}_${safe}.olpbak` : `${stamp}_${safe}.olpbak`
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
  // The id is already in the bytes being written, so this costs one parse and
  // no new IPC. A file that will not parse keeps the old name rather than
  // failing the backup: a backup with a colliding name still beats none.
  let projectId: string | undefined
  try {
    projectId = (JSON.parse(json) as { project?: { id?: string } })?.project?.id
  } catch {
    projectId = undefined
  }
  const target = path.join(dir, fileName(projectName, new Date(), projectId))
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
    // ⛔ NEVER DELETE THE LAST COPY A PROJECT HAS.
    //
    // 2026-08-23: his store was wiped and his finished work was simply gone,
    // because only the OPEN project was ever backed up and the forty slots were
    // all versions of it. Now that every project is written, a straight
    // newest-forty prune would do the same damage a different way: an edit he
    // finished last month, correctly written once and never changed again, would
    // age out while forty copies of today's edit crowd it out.
    //
    // So a file is only ever pruned when a NEWER file for the same project
    // exists. Read from the file itself, not from its name: every one of his is
    // called "Untitled Project".
    const newestOf = new Map<string, string>()
    const idOf = new Map<string, string>()
    for (const { f } of [...withTime].reverse()) {
      const id = await projectIdIn(path.join(dir, f))
      if (!id) continue
      idOf.set(f, id)
      if (!newestOf.has(id)) newestOf.set(id, f)
    }
    let over = withTime.length - KEEP
    for (const { f } of withTime) {
      if (over <= 0) break
      const id = idOf.get(f)
      // Unreadable, or the only copy this project has: it stays.
      if (!id || newestOf.get(id) === f) continue
      try {
        await unlink(path.join(dir, f))
        over -= 1
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

/**
 * The project id inside a backup file, or null when it cannot be read.
 *
 * ⛔ READ FROM THE FILE, NOT FROM THE NAME. Every one of his backups is called
 * "Untitled Project", so the name says nothing about which edit it holds, and a
 * prune that grouped by name would treat all of them as one project and delete
 * the last copy of everything else.
 *
 * Only the id is taken, and a file that will not parse is treated as unknown so
 * that it is never the one thrown away.
 */
async function projectIdIn(file: string): Promise<string | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { project?: { id?: string } }
    const id = parsed?.project?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}
