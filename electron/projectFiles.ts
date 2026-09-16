// Every project, as a plain file on disk, kept current on EVERY save.
//
// This is not a backup. The rotating backups in `backups.ts` are a history, one
// file every couple of minutes, forty kept. This folder holds ONE file per
// project, always the latest state, written on the same debounced save that
// writes the browser store. When the browser store is gone, this is the store.
//
// Why a second copy of the same document, on 2026-09-14: the browser engine has
// torn down its own database under the running app three times since July
// (2026-07-26, 2026-08-19, 2026-08-23), and once more between 2026-08-24 and
// 2026-09-12. Each time the app opened blank. The recovery that reads the
// rotating backups helped twice and then, the fourth time, brought back a two
// clip project and left the 112 clip one on disk unrecovered, because it judged
// that one a shell. His words that morning: *"im afraid you keep fucking up my
// saves ... make sure i never lose a save again."*
//
// So the rule is now simpler than any recovery heuristic: a project is a file.
// The browser store is a cache of these files. At boot, and whenever the list
// is read, any file whose project is not in the store is put back, with its
// own id and its own name, no "(recovered)" suffix, no judgement about its
// media. Nothing is ever deleted here except on his own delete, and even that
// only moves the file into `Trash`.
//
// The document only. Media bytes have their own spare copy (`mediaStore.ts`)
// and are put back on the edit when it opens. A 100 KB JSON every second is
// nothing; a multi gigabyte bundle every second would be its own disaster.

import { app } from 'electron'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Documents, for the same reason the backups live there: a copy that lives
 * inside the browser profile dies with the browser profile. A throwaway profile
 * (the e2e harness, the cold start check) and the lab build keep their files
 * under their own userData, so a test run can never write into his folder.
 */
export function projectDir(): string {
  const throwaway = process.argv.some((a) => a.startsWith('--user-data-dir='))
  const name = app.getName()
  if (throwaway || name.toLowerCase().includes('lab')) return path.join(app.getPath('userData'), 'Projects')
  return path.join(app.getPath('documents'), `${name} Projects`)
}

const EXT = '.olpbak'

/** The eight characters that tie a file to its project whatever he renames it to. */
export function shortId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 8)
}

/**
 * `Green_ab9fe413.olpbak`: his name first so Explorer reads well, the id last so
 * a rename can find the old file. The same shape the backups use, so a file
 * from either folder opens in the Recover shelf.
 */
export function projectFileName(projectName: string, id: string): string {
  // Letters and digits from any language stay, so a project named in Czech keeps its name on disk.
  const safe = (projectName || 'project').replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().slice(0, 40) || 'project'
  return `${safe}_${shortId(id)}${EXT}`
}

/** True for a file this module would have written for `id`, under any name. */
function belongsTo(fileName: string, id: string): boolean {
  return fileName.endsWith(`_${shortId(id)}${EXT}`)
}

/**
 * Write the file for one project, and only then let go of the old one.
 *
 * ⛔ WRITTEN BESIDE, THEN RENAMED OVER. A save that is cut off half way (the
 * updater killing the app, a power cut) must never leave a half file where the
 * only copy was. The rename is atomic on NTFS, so the file on disk is always
 * either the previous complete state or the new complete state.
 */
export async function writeProjectFile(id: string, projectName: string, json: string): Promise<string> {
  const dir = projectDir()
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, projectFileName(projectName, id))
  const tmp = `${target}.tmp`
  await writeFile(tmp, json, 'utf8')
  await rename(tmp, target)
  // A rename of the project leaves the file under its old name behind. Clear it
  // now that the new one is safely down.
  const mine = path.basename(target)
  for (const f of await readdir(dir)) {
    if (f === mine || !belongsTo(f, id)) continue
    try {
      await unlink(path.join(dir, f))
    } catch {
      // still there under two names: a nuisance, never a loss
    }
  }
  return target
}

export interface ProjectFileEntry {
  id: string
  name: string
  path: string
  updatedAt: number
  sizeBytes: number
}

interface Parsed {
  id: string
  name: string
  updatedAt: number
}

/** Parsed once per (path, mtime): a rename or a rewrite changes the mtime. */
const parsedCache = new Map<string, { mtimeMs: number; parsed: Parsed | null }>()

async function parseHeader(file: string, mtimeMs: number): Promise<Parsed | null> {
  const hit = parsedCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed
  let parsed: Parsed | null = null
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      project?: { id?: unknown; name?: unknown; updatedAt?: unknown }
    }
    const p = raw?.project
    if (p && typeof p.id === 'string' && p.id.length > 0) {
      parsed = {
        id: p.id,
        name: typeof p.name === 'string' ? p.name : 'Untitled Project',
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : mtimeMs,
      }
    }
  } catch {
    parsed = null // a half file or not ours: listed by nobody, deleted by nobody
  }
  parsedCache.set(file, { mtimeMs, parsed })
  return parsed
}

/**
 * Every project file, newest first. One entry per project id: if two files
 * claim the same id (a rename whose cleanup failed), the newer one speaks.
 */
export async function listProjectFiles(): Promise<ProjectFileEntry[]> {
  const dir = projectDir()
  let names: string[]
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(EXT))
  } catch {
    return [] // no folder yet means no projects, not an error
  }
  const byId = new Map<string, ProjectFileEntry>()
  for (const name of names) {
    const file = path.join(dir, name)
    let s
    try {
      s = await stat(file)
    } catch {
      continue
    }
    const parsed = await parseHeader(file, s.mtimeMs)
    if (!parsed) continue
    const entry: ProjectFileEntry = {
      id: parsed.id,
      name: parsed.name,
      path: file,
      updatedAt: parsed.updatedAt,
      sizeBytes: s.size,
    }
    const seen = byId.get(parsed.id)
    if (!seen || seen.updatedAt < entry.updatedAt) byId.set(parsed.id, entry)
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * His delete. The file moves into `Trash` under a timestamp rather than being
 * unlinked, because "I deleted the wrong one" is the one mistake this whole
 * folder exists to make survivable.
 */
export async function trashProjectFile(id: string): Promise<number> {
  const dir = projectDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const mine = names.filter((f) => belongsTo(f, id))
  if (mine.length === 0) return 0
  const trash = path.join(dir, 'Trash')
  await mkdir(trash, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let moved = 0
  for (const f of mine) {
    try {
      await rename(path.join(dir, f), path.join(trash, `${stamp}_${f}`))
      moved += 1
    } catch {
      // left in place: it comes back on the next list, and he deletes it again
    }
  }
  return moved
}

/**
 * The read guard. The renderer may only read back what this module wrote:
 * inside the folder, our extension, no `Trash`. The folder must not become a
 * file read primitive for a buggy or compromised renderer.
 */
export function isProjectFilePath(filePath: string): boolean {
  const dir = path.resolve(projectDir())
  const target = path.resolve(filePath)
  return target.startsWith(dir + path.sep) && target.endsWith(EXT) && path.dirname(target) === dir
}
