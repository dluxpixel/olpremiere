// Where the usage log lives in the BROWSER build: its own small IndexedDB, apart
// from the one the projects are in (never a schema change to that one, so this can
// never put a project at risk). The desktop app writes plain files instead
// (electron/usageFiles.ts); this is the same log with a different home.
//
// If the browser will not give us a database (a private window), the batches are
// kept in memory for the session, bounded, so recording still costs nothing and
// the log simply does not outlive the tab.

import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'olpremiere-usage'
const STORE = 'batches'
/** Same rotation as the desktop folder. */
export const WEB_KEEP_DAYS = 90
const MEMORY_BATCHES = 2_000

interface Batch {
  id?: number
  day: string
  lines: string
}

let dbPromise: Promise<IDBPDatabase | null> | null = null
const memory: Batch[] = []
let prunedFor = ''

function db(): Promise<IDBPDatabase | null> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      const s = d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      s.createIndex('day', 'day')
    },
  }).catch(() => null)
  return dbPromise
}

/** `2026-07-06` minus `keepDays`, as a day key. Plain calendar maths on the key itself. */
export function cutoffDay(today: string, keepDays: number): string {
  const [y, m, d] = today.split('-').map(Number)
  const t = new Date(Date.UTC(y!, m! - 1, d!) - keepDays * 86_400_000)
  return t.toISOString().slice(0, 10)
}

/** One day's batch of lines. Never throws: a log that cannot be written must not become an error. */
export async function appendWebUsage(day: string, lines: string): Promise<void> {
  const d = await db()
  if (!d) {
    memory.push({ day, lines })
    if (memory.length > MEMORY_BATCHES) memory.splice(0, memory.length - MEMORY_BATCHES)
    return
  }
  await d.add(STORE, { day, lines } satisfies Batch)
  if (prunedFor !== day) {
    prunedFor = day
    void pruneWebUsage(day).catch(() => undefined)
  }
}

/** Drop whole days older than the rotation. */
export async function pruneWebUsage(today: string, keepDays = WEB_KEEP_DAYS): Promise<void> {
  const d = await db()
  if (!d) return
  const cutoff = cutoffDay(today, keepDays)
  const old = (await d.getAll(STORE)) as Batch[]
  const tx = d.transaction(STORE, 'readwrite')
  for (const b of old) if (b.day < cutoff && b.id !== undefined) void tx.store.delete(b.id)
  await tx.done
}

/** Everything kept, oldest first, one entry per day. */
export async function readWebUsage(): Promise<{ day: string; text: string }[]> {
  const d = await db()
  const batches: Batch[] = d ? await d.getAll(STORE) : [...memory]
  const days = new Map<string, string>()
  for (const b of batches) days.set(b.day, (days.get(b.day) ?? '') + b.lines)
  return [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, text]) => ({ day, text }))
}

/** Hand the whole log to him as one file the report script can read. */
export async function saveWebUsageCopy(): Promise<void> {
  const days = await readWebUsage()
  const blob = new Blob([days.map((x) => x.text).join('')], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ol-premiere-usage-${days.at(-1)?.day ?? 'empty'}.jsonl`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
