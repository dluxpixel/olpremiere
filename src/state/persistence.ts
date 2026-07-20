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
// stacks) — content that deliberately OUTLIVES any project document.
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

/** Load one project by id (projects are keyed individually — a collab join
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

  for (const { from, to } of plan.blobCopies) {
    const blob = await getBlob(from)
    // A missing source blob means the media was already gone; the spawned
    // project keeps the asset entry and shows it as offline, exactly like any
    // other missing file, rather than failing the whole conversion.
    if (blob) await putBlob(to, blob)
  }
  for (const spawn of plan.spawned) await saveProject(spawn)
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

/** Light listing for the Projects picker (docs are blob-free JSON — cheap). */
export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  assetCount: number
  clipCount: number
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
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
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

export async function putBlob(key: string, blob: Blob): Promise<void> {
  const d = await db()
  await d.put('blobs', blob, key)
}

export async function getBlob(key: string): Promise<Blob | null> {
  const d = await db()
  return ((await d.get('blobs', key)) as Blob | undefined) ?? null
}

const AUTOSAVE_DEBOUNCE_MS = 1000
let saveTimer: number | undefined

async function flushSave(): Promise<void> {
  const { setUI } = useStore.getState()
  setUI({ saveState: 'saving' })
  try {
    await saveProject(useStore.getState().project)
    setUI({ saveState: 'saved' })
  } catch (err) {
    console.error('OL Studio autosave failed', err)
    setUI({ saveState: 'unsaved' })
  }
}

/** Save immediately (Ctrl+S). */
export function saveNow(): Promise<void> {
  window.clearTimeout(saveTimer)
  return flushSave()
}

/**
 * Hydrate the last project and start debounced autosave. Call once at boot.
 * Returns the hydration promise — anything that must see the REAL project
 * (e.g. joining a collab room from the URL) awaits it.
 */
export function initPersistence(): Promise<void> {
  const hydrated = loadLastProject()
    .then((p) => {
      const s = useStore.getState()
      // Only hydrate if the user hasn't already started editing.
      if (p && s.history.undo.length === 0) s.setProject(p)
    })
    .catch((err) => console.error('OL Studio project load failed', err))

  useStore.subscribe(
    (s) => s.project,
    () => {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => void flushSave(), AUTOSAVE_DEBOUNCE_MS)
    },
  )
  return hydrated
}
