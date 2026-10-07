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
//    beside the app's settings), and its own file is 7 days old too,
//  - the cleanup is not held: a morning that says the store lost something
//    stands it down for 30 days (holdSweep).
// Any file in those folders that cannot be read or parsed stops the whole run:
// a project it cannot read might use anything. So does a folder that is not
// there, or a Projects folder that does not hold the store's projects: that is
// the wrong place, not an empty one. Only names shaped like an asset id are ever
// looked at; the Library's `lib-` copies and anything else are never touched.
//
// ⛔ IT DELETES ONLY IN THIS PROFILE'S OWN FOLDER. What it reads (the store, the
// Projects folder, the backups) belongs to the profile it runs in, so what it
// may delete must too. mediaStore also READS older profile folders as a fallback,
// and a throwaway or lab profile, which sees none of his projects, once counted
// every copy of his footage in his real folder as unused.
//
// Free of 'electron', so every one of those rules runs under test on real files.

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { assetIdsUsedBy } from './assetIdsUsed'
import { inTurn, replaceFile } from './durableWrite'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a copy must have been unused, and its file untouched, before it goes. */
export const UNUSED_FOR_MS = 7 * DAY_MS

/** How long a morning that says the store lost something stands the cleanup down. */
export const HOLD_FOR_MS = 30 * DAY_MS

/**
 * No project file of his comes anywhere near this: they are the document only,
 * about 100 KB. A bundle renamed to `.olpbak` is gigabytes, and main would read
 * it whole before the parse failed, on the thread that carries his input.
 */
export const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024

/** What `newId` makes (crypto.randomUUID). Nothing else in the folder is ever touched. */
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SweepPlaces {
  /**
   * This profile's own folder (userData). Its `media` folder is the ONLY folder a
   * run may delete from, and the ledger and the hold live beside it.
   */
  profileDir: string
  /** The Projects folder. Its Trash is the `Trash` folder inside it. */
  projectsDir: string
  /** The rotating backups. */
  backupDir: string
}

/** The one folder a run may delete from: this profile's spare copies (mediaStore.mediaDir). */
export function spareCopyDir(places: Pick<SweepPlaces, 'profileDir'>): string {
  return path.join(places.profileDir, 'media')
}

/** When each unused copy was first seen unused. */
export function ledgerFile(places: Pick<SweepPlaces, 'profileDir'>): string {
  return path.join(places.profileDir, 'spare-copies-unused.json')
}

/** Until when the cleanup stands down, and why. */
export function holdFile(places: Pick<SweepPlaces, 'profileDir'>): string {
  return path.join(places.profileDir, 'spare-copies-hold.json')
}

/** What the page read from its store. */
export interface StoreUse {
  /** Every project in the store, by id. */
  projectIds: readonly string[]
  /** Every asset id they, the open edit and its undo steps use. */
  assetIds: readonly string[]
}

export interface SweepResult {
  removed: string[]
  freedBytes: number
  /** Unused copies still inside their 7 days. */
  waiting: number
  /** Why nothing was removed at all, when the run refused. */
  refused?: string
  /** It only has to wait (a copy is being written), so the page tries again later. */
  busy?: boolean
}

/**
 * Every asset id one folder of project files uses, and the project ids in it.
 * Returns how many project files it read. Throws on anything it cannot read,
 * and on a folder that is not there.
 */
async function readProjectFolder(
  dir: string,
  what: string,
  used: Set<string>,
  projectIds?: Set<string>,
): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    // ⛔ A FOLDER THAT IS NOT THERE IS NOT AN EMPTY ONE. Documents can move (OneDrive
    // backup switched off, its location changed, the folder renamed by hand), and
    // then every project file is still on the disk, just not here. Read as "no
    // files", that turned every copy only Trash or a backup used into "unused".
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(`the ${what} folder is not there`)
    throw err
  }
  let files = 0
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.olpbak')) continue
    const file = path.join(dir, name)
    const s = await stat(file)
    if (!s.isFile()) throw new Error(`${name} is not a file`)
    if (s.size > MAX_PROJECT_FILE_BYTES) throw new Error(`${name} is too big to be a project file`)
    const project = (JSON.parse(await readFile(file, 'utf8')) as { project?: { id?: unknown; assets?: unknown } })
      ?.project
    if (!project?.assets || typeof project.assets !== 'object') throw new Error(`${name} does not say what media it uses`)
    for (const id of assetIdsUsedBy(project)) used.add(id.toLowerCase())
    if (typeof project.id === 'string') projectIds?.add(project.id)
    files += 1
    // One file at a time, letting his input through between them: this is the
    // main process, the thread that carries his mouse and keys.
    await new Promise((r) => setImmediate(r))
  }
  return files
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

interface Hold {
  until: number
  why: string
}

/** The hold, null when there has never been one. Throws when one is there but will not read. */
async function readHold(file: string): Promise<Hold | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
  const parsed = JSON.parse(raw) as { until?: unknown; why?: unknown } | null
  if (typeof parsed?.until !== 'number' || !Number.isFinite(parsed.until)) throw new Error('the hold does not read')
  return { until: parsed.until, why: typeof parsed.why === 'string' ? parsed.why : '' }
}

/**
 * Stand the cleanup down for 30 days from `now`, and start every clock again
 * when the 30 days end.
 *
 * ⛔ THE MORNING THE STORE LOST SOMETHING IS WHEN IT MUST STAND DOWN, NOT RUN AT
 * MINUTE 3. On 2026-07-26 the media were in the store and the project record was
 * never written, so there was no file and no backup either, and the spare copies
 * became the only trace once the store's own bytes were swept. That is how the
 * 2026-08-23 recovery by hand worked. The page asks for this when a start shows
 * an empty store, puts projects back from their files, or recovers from the
 * backups. A longer hold already in place is kept.
 */
export function holdSweep(places: Pick<SweepPlaces, 'profileDir'>, why: string, now = Date.now()): Promise<void> {
  const file = holdFile(places)
  return inTurn(file, async () => {
    let until = now + HOLD_FOR_MS
    const old = await readHold(file).catch(() => null)
    if (old && old.until > until) until = old.until
    await replaceFile(file, JSON.stringify({ until, why, at: now }))
  })
}

/**
 * One run. `store` is what the page read from its store: every project in it,
 * and every asset id they (and the open edit, and its undo steps) use.
 */
export async function sweepUnusedSpareCopies(
  places: SweepPlaces,
  store: StoreUse,
  now = Date.now(),
): Promise<SweepResult> {
  const refuse = (why: string): SweepResult => ({ removed: [], freedBytes: 0, waiting: 0, refused: why })
  // A store that reads empty is the morning it was wiped, not a shelf with nothing on it.
  if (store.projectIds.length <= 0) return refuse('the store has no projects')

  let hold: Hold | null
  try {
    hold = await readHold(holdFile(places))
  } catch {
    return refuse('the hold on the cleanup does not read')
  }
  if (hold && hold.until > now) {
    return refuse(`held until ${new Date(hold.until).toISOString().slice(0, 10)}: ${hold.why}`)
  }

  // Lower case on both sides: a copy put back by hand under another case is still his.
  const used = new Set(store.assetIds.map((id) => id.toLowerCase()))
  try {
    const inProjects = new Set<string>()
    const files = await readProjectFolder(places.projectsDir, 'Projects', used, inProjects)
    // A saved project always writes its file, so a store with projects beside a
    // Projects folder holding none of them is the wrong folder, not an empty one.
    if (files === 0) throw new Error('the Projects folder holds no project files')
    if (!store.projectIds.some((id) => inProjects.has(id))) {
      throw new Error('no file in the Projects folder is a project in the store')
    }
    await readProjectFolder(path.join(places.projectsDir, 'Trash'), 'Trash', used)
    await readProjectFolder(places.backupDir, 'Backups', used)
  } catch (err) {
    return refuse(`could not read every project file: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Every copy in this profile's folder: its size and when its file last changed.
  const dir = spareCopyDir(places)
  const copies = new Map<string, { size: number; touchedMs: number }>()
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!ASSET_ID.test(name)) continue
    const s = await stat(path.join(dir, name)).catch(() => null)
    if (!s?.isFile()) continue
    // The newest of its times: a copy put back with Explorer, or by hand as on
    // 2026-08-23, keeps its old write time, and only its creation says it is new.
    copies.set(name, { size: s.size, touchedMs: Math.max(s.mtimeMs, s.ctimeMs, s.birthtimeMs) })
  }

  const ledger = await readLedger(ledgerFile(places))
  const next: Record<string, number> = {}
  const removed: string[] = []
  let freedBytes = 0
  for (const [name, copy] of copies) {
    // Used again, or still: off the ledger, so a later unused spell starts at zero.
    if (used.has(name.toLowerCase())) continue
    // A hold that has ended starts every clock at its end: what was seen unused
    // before that morning proves nothing about after it.
    const since = Math.max(ledger[name] ?? now, hold?.until ?? 0)
    const unusedLongEnough = now - since >= UNUSED_FOR_MS
    const untouchedLongEnough = now - copy.touchedMs >= UNUSED_FOR_MS
    if (!unusedLongEnough || !untouchedLongEnough) {
      next[name] = Math.min(since, now)
      continue
    }
    try {
      await rm(path.join(dir, name), { force: true })
      removed.push(name)
      freedBytes += copy.size
    } catch {
      next[name] = since
    }
  }
  await replaceFile(ledgerFile(places), JSON.stringify(next)).catch(() => undefined)
  return { removed, freedBytes, waiting: Object.keys(next).length }
}
