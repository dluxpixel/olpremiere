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
// the wrong place, not an empty one. So do folders that are not the ones the last
// run saw, and a project seen in Trash or the backups last time that is in none
// of the folders now (the ledger keeps both). Only names shaped like an asset id
// are ever looked at; the Library's `lib-` copies and anything else are never
// touched.
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

/**
 * Why a run let nothing go, as one fixed word. His usage log keeps this and never
 * the reason's text: the text can carry a project file's name, and its first
 * words were the same for every folder reason, so a cleanup that stopped for
 * good could not be told from one that stopped once.
 */
export type RefusalCode =
  | 'store-empty'
  | 'hold-unreadable'
  | 'held'
  | 'busy'
  | 'projects-missing'
  | 'trash-missing'
  | 'backups-missing'
  | 'folder-unreadable'
  | 'unreadable-file'
  | 'not-a-file'
  | 'file-too-big'
  | 'no-media-list'
  | 'projects-empty'
  | 'projects-foreign'
  | 'folders-changed'
  | 'project-gone'

export interface SweepResult {
  removed: string[]
  freedBytes: number
  /** Unused copies still inside their 7 days. */
  waiting: number
  /** Why nothing was removed at all, when the run refused. */
  refused?: string
  /** The same, as one fixed word (RefusalCode). */
  code?: RefusalCode
  /** It only has to wait (a copy is being written), so the page tries again later. */
  busy?: boolean
}

/** A run that has to stop, with the word his usage log keeps. */
class Refused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message)
  }
}

/** Which folder it was: where it is, and when it was made. */
interface Place {
  path: string
  born: number
}

interface FolderRead {
  /** Project files read. */
  files: number
  /** The project ids in them. */
  projectIds: Set<string>
  place: Place
}

/**
 * Every asset id one folder of project files uses goes into `used`. Returns how
 * many project files it read, the project ids in them, and which folder it was.
 * Throws a Refused on anything it cannot read, and on a folder that is not there.
 */
async function readProjectFolder(
  dir: string,
  what: 'Projects' | 'Trash' | 'Backups',
  missing: RefusalCode,
  used: Set<string>,
): Promise<FolderRead> {
  let names: string[]
  let born: number
  try {
    born = (await stat(dir)).birthtimeMs
    names = await readdir(dir)
  } catch (err) {
    // ⛔ A FOLDER THAT IS NOT THERE IS NOT AN EMPTY ONE. Documents can move (OneDrive
    // backup switched off, its location changed, the folder renamed by hand), and
    // then every project file is still on the disk, just not here. Read as "no
    // files", that turned every copy only Trash or a backup used into "unused".
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Refused(missing, `the ${what} folder is not there`)
    throw new Refused('folder-unreadable', `the ${what} folder will not open`)
  }
  let files = 0
  const projectIds = new Set<string>()
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.olpbak')) continue
    const file = path.join(dir, name)
    const s = await stat(file).catch(() => null)
    if (!s) throw new Refused('unreadable-file', `${name} will not read`)
    if (!s.isFile()) throw new Refused('not-a-file', `${name} is not a file`)
    if (s.size > MAX_PROJECT_FILE_BYTES) throw new Refused('file-too-big', `${name} is too big to be a project file`)
    let project: { id?: unknown; assets?: unknown } | undefined
    try {
      project = (JSON.parse(await readFile(file, 'utf8')) as { project?: { id?: unknown; assets?: unknown } } | null)
        ?.project
    } catch {
      throw new Refused('unreadable-file', `${name} will not read`)
    }
    if (!project?.assets || typeof project.assets !== 'object') {
      throw new Refused('no-media-list', `${name} does not say what media it uses`)
    }
    for (const id of assetIdsUsedBy(project)) used.add(id.toLowerCase())
    if (typeof project.id === 'string') projectIds.add(project.id)
    files += 1
    // One file at a time, letting his input through between them: this is the
    // main process, the thread that carries his mouse and keys.
    await new Promise((r) => setImmediate(r))
  }
  return { files, projectIds, place: { path: path.resolve(dir), born } }
}

interface Places {
  projects: Place
  trash: Place
  backups: Place
}

interface Ledger {
  /** 'none': no ledger yet. 'broken': there, but it will not read. */
  state: 'none' | 'read' | 'broken'
  /** When each unused copy was first seen unused. */
  unused: Record<string, number>
  /** The folders the last run that went through read, or null before the first. */
  places: Places | null
  /** Every project id any run has seen in Trash or the backups. */
  seen: string[]
}

function readPlace(raw: unknown): Place | null {
  const p = raw as { path?: unknown; born?: unknown } | null
  if (typeof p?.path !== 'string' || typeof p.born !== 'number' || !Number.isFinite(p.born)) return null
  return { path: p.path, born: p.born }
}

function readUnused(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at
  }
  return out
}

async function readLedger(file: string): Promise<Ledger> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const state = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'none' : 'broken'
    return { state, unused: {}, places: null, seen: [] }
  }
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; unused?: unknown; places?: unknown; seen?: unknown } | null
    if (!parsed || typeof parsed !== 'object') throw new Error('not a ledger')
    // The first ledgers were the unused map alone.
    if (parsed.v !== 2) return { state: 'read', unused: readUnused(parsed), places: null, seen: [] }
    const pl = parsed.places as Record<string, unknown> | null | undefined
    const projects = readPlace(pl?.projects)
    const trash = readPlace(pl?.trash)
    const backups = readPlace(pl?.backups)
    return {
      state: 'read',
      unused: readUnused(parsed.unused),
      places: projects && trash && backups ? { projects, trash, backups } : null,
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((id): id is string => typeof id === 'string') : [],
    }
  } catch {
    // One that will not read: every clock starts again, which only ever keeps a
    // copy longer.
    return { state: 'broken', unused: {}, places: null, seen: [] }
  }
}

function writeLedger(file: string, ledger: Pick<Ledger, 'unused' | 'places' | 'seen'>): Promise<void> {
  return replaceFile(file, JSON.stringify({ v: 2, unused: ledger.unused, places: ledger.places, seen: ledger.seen }))
}

/**
 * The same folder: the same place, made at the same moment. A folder made again
 * where the old one was has a new moment; one moved back to where it was, on the
 * same drive, has its old one.
 */
function samePlace(a: Place, b: Place): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  return fold(a.path) === fold(b.path) && a.born === b.born
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
  const refuse = (code: RefusalCode, why: string): SweepResult => ({
    removed: [],
    freedBytes: 0,
    waiting: 0,
    refused: why,
    code,
  })
  // A store that reads empty is the morning it was wiped, not a shelf with nothing on it.
  if (store.projectIds.length <= 0) return refuse('store-empty', 'the store has no projects')

  let hold: Hold | null
  try {
    hold = await readHold(holdFile(places))
  } catch {
    return refuse('hold-unreadable', 'the hold on the cleanup does not read')
  }
  if (hold && hold.until > now) {
    return refuse('held', `held until ${new Date(hold.until).toISOString().slice(0, 10)}: ${hold.why}`)
  }

  // Lower case on both sides: a copy put back by hand under another case is still his.
  const inStore = new Set(store.assetIds.map((id) => id.toLowerCase()))
  const ledgerPath = ledgerFile(places)
  const ledger = await readLedger(ledgerPath)

  // ⛔ A RUN THAT STOPS STILL TAKES WHAT THE STORE USES OFF THE LEDGER. Its 7 days
  // are 7 days IN A ROW: a copy used again during a stretch of stopped runs (a torn
  // backup, a missing Trash) kept its old stamp and went at the first run that got
  // through, with no grace at all. Taking an id off only ever keeps a copy longer,
  // and the page's list is good even when the folders are not. Everything else on
  // the ledger, the folders it saw included, is left as it was.
  const refuseKeeping = async (code: RefusalCode, why: string): Promise<SweepResult> => {
    if (ledger.state === 'read') {
      const unused: Record<string, number> = {}
      let dropped = false
      for (const [name, at] of Object.entries(ledger.unused)) {
        if (inStore.has(name.toLowerCase())) dropped = true
        else unused[name] = at
      }
      if (dropped) await writeLedger(ledgerPath, { ...ledger, unused }).catch(() => undefined)
    }
    return refuse(code, why)
  }

  const used = new Set(inStore)
  let read: { projects: FolderRead; trash: FolderRead; backups: FolderRead }
  try {
    const projects = await readProjectFolder(places.projectsDir, 'Projects', 'projects-missing', used)
    // A saved project always writes its file, so a store with projects beside a
    // Projects folder holding none of them is the wrong folder, not an empty one.
    if (projects.files === 0) throw new Refused('projects-empty', 'the Projects folder holds no project files')
    if (!store.projectIds.some((id) => projects.projectIds.has(id))) {
      throw new Refused('projects-foreign', 'no file in the Projects folder is a project in the store')
    }
    const trash = await readProjectFolder(path.join(places.projectsDir, 'Trash'), 'Trash', 'trash-missing', used)
    const backups = await readProjectFolder(places.backupDir, 'Backups', 'backups-missing', used)
    read = { projects, trash, backups }
  } catch (err) {
    return refuseKeeping(
      err instanceof Refused ? err.code : 'unreadable-file',
      `could not read every project file: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ⛔ THE SAME FOLDERS AS LAST TIME, OR NOTHING GOES. The app makes all three again
  // by itself: Projects on the next save, Backups on the next backup, Trash on his
  // next delete. After Documents moves (OneDrive backup switched off, its location
  // changed, the folder moved by hand), one delete was enough for every check above
  // to pass while the real Trash and backups sat somewhere else, and every copy
  // only they used went 7 days later without a word. So the ledger keeps which
  // folders the last run read, and every project it ever saw in Trash or the
  // backups: Trash is never emptied by the app, and the backups never lose a
  // project's last copy, so in his use that list only grows.
  const placesNow: Places = {
    projects: read.projects.place,
    trash: read.trash.place,
    backups: read.backups.place,
  }
  const last = ledger.places
  if (last && !(['projects', 'trash', 'backups'] as const).every((k) => samePlace(last[k], placesNow[k]))) {
    return refuseKeeping('folders-changed', 'the project folders are not the ones it saw before')
  }
  const anywhere = new Set([...read.projects.projectIds, ...read.trash.projectIds, ...read.backups.projectIds])
  const gone = ledger.seen.filter((id) => !anywhere.has(id))
  if (gone.length > 0) {
    return refuseKeeping(
      'project-gone',
      `${gone.length} project${gone.length === 1 ? '' : 's'} seen in Trash or the backups before ${gone.length === 1 ? 'is' : 'are'} in none of the folders now`,
    )
  }
  const seen = [...new Set([...ledger.seen, ...read.trash.projectIds, ...read.backups.projectIds])].sort()

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

  const next: Record<string, number> = {}
  const removed: string[] = []
  let freedBytes = 0
  for (const [name, copy] of copies) {
    // Used again, or still: off the ledger, so a later unused spell starts at zero.
    if (used.has(name.toLowerCase())) continue
    // A hold that has ended starts every clock at its end: what was seen unused
    // before that morning proves nothing about after it.
    const since = Math.max(ledger.unused[name] ?? now, hold?.until ?? 0)
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
  await writeLedger(ledgerPath, { unused: next, places: placesNow, seen }).catch(() => undefined)
  return { removed, freedBytes, waiting: Object.keys(next).length }
}
