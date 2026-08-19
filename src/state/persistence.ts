// Local-first persistence: the project document + media blobs live in
// IndexedDB. Nothing ever leaves the machine.

import { openDB, type IDBPDatabase } from 'idb'
import { migrateProjectEffects } from '../engine/effects/migrate'
import { planSequenceSplit } from './sequenceSplit'
import { useToasts } from './toasts'
import { migrateProject, type Project } from '../engine/types'
import { useStore } from './store'

const DB_NAME = 'reel'
// v2 adds the global Library ('library' media entries + 'presets' effect
// stacks), content that deliberately OUTLIVES any project document.
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase> | null = null

export function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      // Guarded, not versioned-if-chains: upgrade re-runs the whole list for a
      // v1 user, and createObjectStore throws on a store that already exists.
      // David's real projects live in this DB; a crash here bricks the app.
      const ensure = (name: string): void => {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name)
      }
      ensure('projects')
      ensure('blobs')
      ensure('meta')
      ensure('library')
      ensure('presets')
    },
  })
  return dbPromise
}

export async function saveProject(p: Project): Promise<void> {
  const d = await db()
  const tx = d.transaction(['projects', 'meta'], 'readwrite')
  void tx.objectStore('projects').put(p, p.id)
  void tx.objectStore('meta').put(p.id, 'lastProjectId')
  await tx.done
}

export async function loadLastProject(): Promise<Project | null> {
  const d = await db()
  const id = (await d.get('meta', 'lastProjectId')) as string | undefined
  if (!id) return null
  return loadProjectById(id)
}

/** Load one project by id (projects are keyed individually, so a collab join
 * never overwrites the solo project; Leave restores it through this). */
export async function loadProjectById(id: string): Promise<Project | null> {
  const d = await db()
  const p = (await d.get('projects', id)) as Project | undefined
  // Shape migration first (tracks/mixer fields), then the colour bag -> effect
  // stack move. Both are idempotent, so a re-load is free.
  if (!p) return null
  return splitLegacySequences(migrateProjectEffects(migrateProject(p)))
}

/**
 * One-time conversion for projects saved while sequences existed: every extra
 * sequence holding real work is written out as its own project (its media
 * copied to fresh blob keys so the two can be deleted independently), and
 * empty extras are dropped. Idempotent: a project already down to one
 * sequence takes the fast path and touches nothing.
 */
async function splitLegacySequences(project: Project): Promise<Project> {
  const plan = planSequenceSplit(project, Date.now())
  if (plan.spawned.length === 0 && plan.droppedEmpty === 0) return project

  // A CONVERSION THAT RUNS TWICE MUST NEVER EAT AN EDIT.
  //
  // The reduced original is written LAST, so a run that dies part way leaves
  // the source holding every sequence and simply runs again next load. The ids
  // are derived from the input (see derivedId in sequenceSplit.ts) so the retry
  // lands on its own earlier output instead of spawning a second copy of
  // everything.
  //
  // But between those two runs he can OPEN a rescued project and work in it,
  // and then the retry would overwrite an hour of his editing with the original
  // sequence, silently, and stamp it as the freshest project in the list. The
  // duplicate this replaced was clutter; that would be destruction. So a spawn
  // whose id is already taken by something NEWER is left exactly where it is.
  // projectFile.ts guards its import path the same way.
  const fresh: typeof plan.spawned = []
  for (const spawn of plan.spawned) {
    const existing = await loadRaw(spawn.id)
    if (existing && existing.updatedAt >= spawn.updatedAt) continue
    fresh.push(spawn)
  }

  for (const { from, to } of plan.blobCopies) {
    // Only for spawns we are actually going to write. Copying a blob for a
    // project we just decided to leave alone would clobber media he has since
    // relinked, before any document write could stop it.
    if (!fresh.some((s) => Object.values(s.assets ?? {}).some((a) => a.blobKey === to || a.thumbnailKey === to))) {
      continue
    }
    const blob = await getBlob(from)
    // A missing source blob means the media was already gone; the spawned
    // project keeps the asset entry and shows it as offline, exactly like any
    // other missing file, rather than failing the whole conversion.
    if (blob) await putBlob(to, blob)
  }
  for (const spawn of fresh) await saveProject(spawn)
  await saveProject(plan.kept)

  if (plan.spawned.length > 0) {
    useToasts
      .getState()
      .show(
        `Sequences are now separate projects: ${plan.spawned.length} moved out. Find them in Projects.`,
      )
  }
  return plan.kept
}

/** The stored document for an id, without running any migration over it. */
async function loadRaw(id: string): Promise<Project | undefined> {
  try {
    return (await (await db()).get('projects', id)) as Project | undefined
  } catch {
    return undefined
  }
}

/** Light listing for the Projects picker (docs are blob-free JSON, so it's cheap). */
export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  assetCount: number
  clipCount: number
  /** Set only on finished work he has archived. Absent means active. */
  archivedAt?: number
  /** Set on work parked for later. Absent means it is what he is on now. */
  laterAt?: number
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const d = await db()
  const all = (await d.getAll('projects')) as Project[]
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      assetCount: Object.keys(p.assets ?? {}).length,
      clipCount: Object.values(p.sequences ?? {}).reduce(
        (n, sq) => n + sq.tracks.reduce((m, t) => m + t.clips.length, 0),
        0,
      ),
      ...(p.archivedAt ? { archivedAt: p.archivedAt } : {}),
      ...(p.laterAt ? { laterAt: p.laterAt } : {}),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The three shelves. Finished wins over Later: a project he has filed away is
 * finished whatever else was set on it, so a row can never appear twice.
 */
export function activeProjects(all: readonly ProjectSummary[]): ProjectSummary[] {
  return all.filter((p) => !p.archivedAt && !p.laterAt)
}

/** Parked for later: live work he is not on today. Newest parked first. */
export function laterProjects(all: readonly ProjectSummary[]): ProjectSummary[] {
  return all.filter((p) => !p.archivedAt && p.laterAt).sort((a, b) => (b.laterAt ?? 0) - (a.laterAt ?? 0))
}

/** Archived, newest ARCHIVED first, which is the order he last touched them as finished work. */
export function archivedProjects(all: readonly ProjectSummary[]): ProjectSummary[] {
  return all.filter((p) => p.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/**
 * Mark a project finished, or bring it back. Writes ONLY the flag: the stored
 * document is read, stamped and put back, so archiving can never rewrite,
 * migrate or lose the edit itself.
 *
 * Deliberately does NOT touch `updatedAt`. That field means "when he last
 * changed the edit", and filing something away is not changing it; bumping it
 * would reorder his active list every time he tidied up.
 */
/**
 * Park a project for later, or bring it back to what he is working on now.
 * Writes ONLY the flag, exactly like setProjectArchived, so moving a project
 * between shelves can never rewrite or lose the edit itself. Deliberately does
 * NOT touch updatedAt: parking is not editing.
 */
export async function setProjectLater(id: string, later: boolean): Promise<void> {
  const d = await db()
  const p = (await d.get('projects', id)) as Project | undefined
  if (!p) return
  const next: Project = { ...p }
  if (later) next.laterAt = Date.now()
  else delete next.laterAt
  await d.put('projects', next, id)
  stampOpenProject(id, 'laterAt', later)
}

/**
 * Put the same shelf flag on the OPEN project, when it is the one being moved.
 *
 * ⛔ WITHOUT THIS THE NEXT AUTOSAVE UNDID THE MOVE, and moving the project he
 * has open is allowed on purpose. These two functions write the flag straight
 * onto the stored record, and the record in memory never hears about it; the
 * autosave a second later is a whole-document `put`, so it wrote the project
 * back with no flag on it. He filed a finished project away, carried on editing,
 * and found it sitting at the top of his active list again.
 *
 * Written with the store's raw setter rather than through `dispatch` or
 * `setProject`: filing a project is not an edit, so it must not become an undo
 * step, and it must not throw away the undo stack he is still using. Changing
 * the project object is what wakes the autosave, so the flag reaches the disk on
 * its own even if this call and the put above ever disagreed.
 */
function stampOpenProject(id: string, field: 'laterAt' | 'archivedAt', on: boolean): void {
  const live = useStore.getState().project
  if (live.id !== id) return
  const next: Project = { ...live }
  if (on) next[field] = Date.now()
  else delete next[field]
  useStore.setState({ project: next })
}

export async function setProjectArchived(id: string, archived: boolean): Promise<void> {
  const d = await db()
  const p = (await d.get('projects', id)) as Project | undefined
  if (!p) return
  const next: Project = { ...p }
  if (archived) next.archivedAt = Date.now()
  else delete next.archivedAt
  // The 'projects' store uses OUT-OF-LINE keys, so the id must be passed. Without
  // it, put() throws DataError and the archive silently does nothing.
  await d.put('projects', next, id)
  stampOpenProject(id, 'archivedAt', archived)
}

/**
 * Delete a project AND its media bytes. Blobs are per-project copies
 * ('asset/<id>', 'thumb/<id>'); the Library keeps its own 'lib/*' copies, so
 * this never touches saved Library media.
 */
export async function deleteProject(id: string): Promise<void> {
  const d = await db()
  const p = (await d.get('projects', id)) as Project | undefined
  const tx = d.transaction(['projects', 'blobs', 'meta'], 'readwrite')
  void tx.objectStore('projects').delete(id)
  if (p) {
    const blobs = tx.objectStore('blobs')
    for (const asset of Object.values(p.assets ?? {})) {
      void blobs.delete(asset.blobKey)
      if (asset.thumbnailKey) void blobs.delete(asset.thumbnailKey)
    }
  }
  const meta = tx.objectStore('meta')
  const last = (await meta.get('lastProjectId')) as string | undefined
  if (last === id) void meta.delete('lastProjectId')
  await tx.done
}

/**
 * Every media key written since the app opened.
 *
 * THE SWEEP MUST NEVER TOUCH ONE OF THESE. An import writes the bytes first and
 * only then puts the asset in the project, and the project is only written to
 * disk a moment after that. In the gap the key is reachable from NO stored
 * project, which is the sweep's entire definition of rubbish: importing forty
 * files while the boot sweep ran deleted the footage of whichever ones were
 * mid-flight, and the bin showed cards with nothing behind them.
 *
 * A key written this session is either in use or about to be, so keeping the
 * lot costs one session's worth of housekeeping and closes the race completely.
 */
const writtenThisSession = new Set<string>()

/** Read-only view for the sweep. */
export function blobKeysWrittenThisSession(): ReadonlySet<string> {
  return writtenThisSession
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  writtenThisSession.add(key)
  const d = await db()
  await d.put('blobs', blob, key)
}

export async function getBlob(key: string): Promise<Blob | null> {
  const d = await db()
  return ((await d.get('blobs', key)) as Blob | undefined) ?? null
}

/**
 * Drop one blob's bytes. Used to roll back a half-written import: media that no
 * project document references is invisible to the user and reclaimed by nothing,
 * so an aborted write has to clean up after itself rather than leave gigabytes
 * parked in the origin's quota.
 */
export async function deleteBlob(key: string): Promise<void> {
  const d = await db()
  await d.delete('blobs', key)
}

const AUTOSAVE_DEBOUNCE_MS = 1000
let saveTimer: number | undefined
/** True once a background autosave has failed, until one succeeds again. */
let autosaveFailing = false

/**
 * Write the open project. REJECTS when the write fails. Every caller has to
 * decide what a failed save means for it, because the failure modes here
 * (origin quota exhausted, disk full, a wiped/blocked IndexedDB) all mean the
 * user's edits exist ONLY in memory. Swallowing the error made a failed save
 * indistinguishable from a successful one at every call site: Ctrl+S showed a
 * green "Project saved", the updater relaunched the app, and opening another
 * project overwrote the unsaved one.
 */
async function flushSave(): Promise<void> {
  const { setUI } = useStore.getState()
  setUI({ saveState: 'saving' })
  try {
    await saveProject(useStore.getState().project)
    setUI({ saveState: 'saved' })
  } catch (err) {
    console.error('OL Premiere autosave failed', err)
    setUI({ saveState: 'unsaved' })
    throw err
  }
}

/** Save immediately (Ctrl+S). Rejects when the write failed (see flushSave). */
export function saveNow(): Promise<void> {
  window.clearTimeout(saveTimer)
  return flushSave()
}

/**
 * Hydrate the last project and start debounced autosave. Call once at boot.
 * Returns the hydration promise: anything that must see the REAL project
 * (e.g. joining a collab room from the URL) awaits it.
 */
export function initPersistence(): Promise<void> {
  // Ask the browser to make this origin's storage DURABLE, so projects + media
  // aren't silently evicted under storage pressure (or by a "clear site data"
  // heuristic). Best-effort, and ignored where unsupported. Matters most before a
  // web→desktop migration, where un-backed work must not vanish.
  try {
    void navigator.storage?.persist?.()
  } catch {
    // ignore
  }

  const hydrated = loadLastProject()
    .then((p) => {
      const s = useStore.getState()
      // Only hydrate if the user hasn't already started editing.
      if (p && s.history.undo.length === 0) s.setProject(p)
    })
    .catch((err) => console.error('OL Premiere project load failed', err))

  useStore.subscribe(
    (s) => s.project,
    () => {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        flushSave().then(
          () => {
            autosaveFailing = false
          },
          () => {
            // Say it ONCE per failure streak. The save indicator's "Unsaved" dot
            // is the same thing it shows for a second after every edit, so on its
            // own it cannot tell the user their work is no longer being written.
            if (autosaveFailing) return
            autosaveFailing = true
            useToasts.getState().show('Could not save. Your work is only in memory', 'danger', {
              label: 'Back up to a file',
              // Imported lazily: projectFile reads blobs back out of THIS module.
              onClick: () => void import('./projectFile').then((m) => m.exportProjectToFile()),
            })
          },
        )
      }, AUTOSAVE_DEBOUNCE_MS)
    },
  )
  return hydrated
}
