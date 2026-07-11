// Local-first persistence: the project document + media blobs live in
// IndexedDB. Nothing ever leaves the machine.

import { openDB, type IDBPDatabase } from 'idb'
import { migrateProjectEffects } from '../engine/effects/migrate'
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
  const p = (await d.get('projects', id)) as Project | undefined
  // Shape migration first (tracks/mixer fields), then the colour bag -> effect
  // stack move. Both are idempotent, so a re-load is free.
  return p ? migrateProjectEffects(migrateProject(p)) : null
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

/** Hydrate the last project and start debounced autosave. Call once at boot. */
export function initPersistence(): void {
  loadLastProject()
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
}
