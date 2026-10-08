// A voice take, written to disk a second at a time WHILE he records.
//
// ⛔ A CRASH IN THE MIDDLE OF A TAKE USED TO LOSE ALL OF IT. The recorder held
// every byte in memory until Stop, and then until Add: a renderer that died (his
// notes have RAM at 99 percent) took the whole take with it, and the restart
// hold only guards a restart, never a crash. Now each second of the take lands
// here as it is recorded, and stays until the take is in the bin or thrown away.
// A take still here at the next launch is offered back.
//
// Its own small IndexedDB, apart from the projects (the usage log does the same):
// never a schema change to the database his projects live in, and the storage
// sweep and the boot count of that database never see these bytes.
//
// Nothing here may break a recording. A write that fails (his drive is nearly
// full) stops the draft for that take, and the take itself goes on in memory
// exactly as it always did.

import { openDB, type IDBPDatabase } from 'idb'

/** The four calls a draft needs. A seam so the tests can hold drafts in memory. */
export interface DraftStore {
  put(key: string, blob: Blob): Promise<void>
  keys(): Promise<string[]>
  get(key: string): Promise<Blob | undefined>
  delete(key: string): Promise<void>
}

const DB_NAME = 'olpremiere-take-drafts'
const STORE = 'chunks'

function idbStore(): DraftStore {
  let dbPromise: Promise<IDBPDatabase> | null = null
  const db = (): Promise<IDBPDatabase> =>
    (dbPromise ??= openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
      },
    }))
  return {
    put: async (key, blob) => void (await (await db()).put(STORE, blob, key)),
    keys: async () => ((await (await db()).getAllKeys(STORE)) as string[]).map(String),
    get: async (key) => (await (await db()).get(STORE, key)) as Blob | undefined,
    delete: async (key) => (await db()).delete(STORE, key),
  }
}

/** Where drafts are kept. Tests swap `current` for an in-memory store. */
export const draftStore: { current: DraftStore } = { current: idbStore() }

/** The chunks of one take sort in recording order by key. */
const chunkKey = (id: string, i: number): string => `${id}/${String(i).padStart(7, '0')}`
const idOf = (key: string): string => key.slice(0, key.lastIndexOf('/'))

/** One take's draft, written in order, a chunk at a time. */
export interface TakeDraft {
  id: string
  /** Queue a chunk. Never throws, never waits. */
  add(chunk: Blob): void
}

/** Every write and delete runs in this one line, so a clear never races a write. */
let queue: Promise<void> = Promise.resolve()

/** Drafts begun in this run: never "left over", even if the offer reads them mid take. */
const startedThisRun = new Set<string>()

export function startDraft(): TakeDraft {
  const id = `take-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  startedThisRun.add(id)
  let n = 0
  let broken = false
  return {
    id,
    add(chunk) {
      if (broken || chunk.size === 0) return
      const key = chunkKey(id, n++)
      // In order, one at a time, and the first failure ends the draft: a gap in
      // the middle would make the file unreadable, a missing tail does not.
      queue = queue.then(async () => {
        if (broken) return
        try {
          await draftStore.current.put(key, chunk)
        } catch (err) {
          broken = true
          console.warn('OL Premiere: the take could not be saved as it records', err)
        }
      })
    },
  }
}

/** Forget a take's draft: it is in the bin now, or he threw it away. */
export function clearDraft(id: string | undefined): Promise<void> {
  if (!id) return Promise.resolve()
  queue = queue.then(async () => {
    try {
      const keys = (await draftStore.current.keys()).filter((k) => idOf(k) === id)
      for (const k of keys) await draftStore.current.delete(k)
    } catch {
      // Housekeeping: a draft that will not go is offered again, never an error.
    }
  })
  return queue
}

/** Takes still on disk from an earlier run of the app, each as one file's bytes. */
export async function leftoverDrafts(): Promise<{ id: string; blob: Blob }[]> {
  await queue
  const keys = (await draftStore.current.keys()).sort()
  const ids = [...new Set(keys.map(idOf))].filter((id) => !startedThisRun.has(id))
  const out: { id: string; blob: Blob }[] = []
  for (const id of ids) {
    const parts: Blob[] = []
    for (const k of keys) {
      if (idOf(k) !== id) continue
      const b = await draftStore.current.get(k)
      if (b) parts.push(b)
    }
    if (parts.length === 0) continue
    // The recorder stamps every chunk with its type, so the first says what the file is.
    out.push({ id, blob: new Blob(parts, { type: parts[0]!.type || 'audio/webm' }) })
  }
  return out
}
