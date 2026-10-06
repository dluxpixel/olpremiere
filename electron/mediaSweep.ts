// Letting go of spare copies nothing uses, once nothing has used them for a week.
//
// ⛔ HIS CALL, 2026-10-06: *"every 7 days"*. The spare copy folder (mediaStore.ts)
// only ever grew: on his drive, 97% full, it held 16.83 GB, of which 0.75 GB
// belonged to nothing at all. The copies are the second home of his footage, so
// this is written the other way round from a cleanup: it keeps everything it
// cannot PROVE is unused, and lets go only of what it can.
//
// A copy goes only when ALL of these hold:
//  - no project in the store uses it (the page sends that list, and refuses to
//    when the store reads empty),
//  - no project file in Projects or Projects\Trash uses it (Trash protects for
//    as long as the file is there),
//  - no backup file uses it,
//  - it has been seen unused by this sweep for 7 days in a row (a small ledger
//    beside the app's settings), and its own file is 7 days old too.
// Any file in those folders that cannot be read or parsed stops the whole run:
// a project it cannot read might use anything. Only names shaped like an asset
// id are ever looked at; the Library's `lib-` copies and anything else are
// never touched.
//
// Free of 'electron', so every one of those rules runs under test on real files.

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { replaceFile } from './durableWrite'

/** How long a copy must have been unused, and its file untouched, before it goes. */
export const UNUSED_FOR_MS = 7 * 24 * 60 * 60 * 1000

/** What `newId` makes (crypto.randomUUID). Nothing else in the folder is ever touched. */
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SweepPlaces {
  /** Every folder a spare copy may be in (mediaStore's own list). */
  mediaDirs: readonly string[]
  /** Projects and Projects\Trash. */
  projectDirs: readonly string[]
  /** The rotating backups. */
  backupDirs: readonly string[]
  /** When each unused copy was first seen unused. */
  ledgerFile: string
}

export interface SweepResult {
  removed: string[]
  freedBytes: number
  /** Unused copies still inside their 7 days. */
  waiting: number
  /** Why nothing was removed at all, when the run refused. */
  refused?: string
}

/** Every asset id a folder of project files uses. Throws on anything it cannot read. */
async function assetIdsIn(dir: string, into: Set<string>): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    // No folder yet means no files in it. Anything else is a folder it cannot see into.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
  for (const name of names) {
    if (!name.endsWith('.olpbak')) continue
    const raw = await readFile(path.join(dir, name), 'utf8')
    const assets = (JSON.parse(raw) as { project?: { assets?: unknown } })?.project?.assets
    if (!assets || typeof assets !== 'object') throw new Error(`${name} does not say what media it uses`)
    for (const [key, a] of Object.entries(assets as Record<string, unknown>)) {
      into.add(key)
      const id = (a as { id?: unknown } | null)?.id
      if (typeof id === 'string') into.add(id)
    }
    // One file at a time, letting his input through between them: this is the
    // main process, the thread that carries his mouse and keys.
    await new Promise((r) => setImmediate(r))
  }
}

async function readLedger(file: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at
    }
    return out
  } catch {
    // No ledger, or one that will not read: every clock starts again, which only
    // ever keeps a copy longer.
    return {}
  }
}

/**
 * One run. `store` is what the page read from its store: how many projects, and
 * every asset id they (and the open edit, and its undo steps) use.
 */
export async function sweepUnusedSpareCopies(
  places: SweepPlaces,
  store: { projects: number; assetIds: readonly string[] },
  now = Date.now(),
): Promise<SweepResult> {
  const refuse = (why: string): SweepResult => ({ removed: [], freedBytes: 0, waiting: 0, refused: why })
  // A store that reads empty is the morning it was wiped, not a shelf with nothing on it.
  if (store.projects <= 0) return refuse('the store has no projects')
  const used = new Set(store.assetIds)
  try {
    for (const dir of [...places.projectDirs, ...places.backupDirs]) await assetIdsIn(dir, used)
  } catch (err) {
    return refuse(`could not read every project file: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Every copy, in every folder, by id: its total size and its newest write.
  const copies = new Map<string, { size: number; mtimeMs: number }>()
  for (const dir of places.mediaDirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!ASSET_ID.test(name)) continue
      const s = await stat(path.join(dir, name)).catch(() => null)
      if (!s?.isFile()) continue
      const seen = copies.get(name)
      copies.set(name, { size: (seen?.size ?? 0) + s.size, mtimeMs: Math.max(seen?.mtimeMs ?? 0, s.mtimeMs) })
    }
  }

  const ledger = await readLedger(places.ledgerFile)
  const next: Record<string, number> = {}
  const removed: string[] = []
  let freedBytes = 0
  for (const [id, copy] of copies) {
    // Used again, or still: off the ledger, so a later unused spell starts at zero.
    if (used.has(id)) continue
    const since = ledger[id] ?? now
    const unusedLongEnough = now - since >= UNUSED_FOR_MS
    const untouchedLongEnough = now - copy.mtimeMs >= UNUSED_FOR_MS
    if (!unusedLongEnough || !untouchedLongEnough) {
      next[id] = Math.min(since, now)
      continue
    }
    let gone = true
    for (const dir of places.mediaDirs) {
      await rm(path.join(dir, id), { force: true }).catch(() => {
        gone = false
      })
    }
    if (gone) {
      removed.push(id)
      freedBytes += copy.size
    } else next[id] = since
  }
  await replaceFile(places.ledgerFile, JSON.stringify(next)).catch(() => undefined)
  return { removed, freedBytes, waiting: Object.keys(next).length }
}
