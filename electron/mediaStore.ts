// HIS MEDIA, AS REAL FILES, OUTSIDE THE DATABASE.
//
// ⛔ WHY THIS EXISTS, AND IT IS THE WORST THING THAT HAS HAPPENED TO HIM.
// 2026-08-23: *"This is the reason I haven't opened the app in five days."* The
// browser engine threw its own IndexedDB away and started again, which it does
// on its own and which no code here can prevent or be told about. His project
// records came back from the automatic backups. **His media could not**, because
// the only copy the app had was inside that same database: 1.3 GB of bytes still
// sitting on the disk in Chromium's blob folder, with nothing left able to name
// them. Forty four cuts pointing at footage the app could no longer reach.
//
// So the bytes get a second home that no database rebuild can touch: one file
// per asset, named by the asset's own id, under the app's user data. Written on
// import, read back when the database has lost its copy. A wipe becomes a thing
// the app repairs on the next launch instead of a thing he loses a week to.
//
// ⛔ IT IS A MIRROR, NOT A MOVE. IndexedDB stays the fast path that everything
// already reads. Nothing else in the app learns this folder exists.

import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

export function mediaDir(): string {
  return path.join(app.getPath('userData'), 'media')
}

/**
 * The file for one asset. The id is the whole name.
 *
 * ⛔ THE ID IS VALIDATED, NOT TRUSTED. It arrives from the renderer, and a name
 * carrying a slash or a `..` would write outside the folder. Asset ids are uuids
 * and nothing else has any business here.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
function fileFor(assetId: string): string | null {
  if (!SAFE_ID.test(assetId)) return null
  return path.join(mediaDir(), assetId)
}

/** Which assets have a copy on disk, and how big each one is. */
export async function listMedia(): Promise<{ id: string; size: number }[]> {
  const dir = mediaDir()
  const names = await readdir(dir).catch(() => [] as string[])
  const out: { id: string; size: number }[] = []
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue
    const s = await stat(path.join(dir, name)).catch(() => null)
    if (s?.isFile() && s.size > 0) out.push({ id: name, size: s.size })
  }
  return out
}

// Writing streams in, exactly like every other big-file path in this app: his
// captures are gigabytes and a whole-file buffer would die on the ones that
// matter most.
const writers = new Map<string, { handle: FileHandle; tmp: string; final: string }>()

/**
 * Start writing one asset's copy.
 *
 * ⛔ IT WRITES TO A TEMP AND RENAMES ON THE LAST BYTE. A half written file that
 * carried the asset's real name would be served as though it were whole, and the
 * one thing this folder must never do is hand back a truncated source.
 */
export async function beginMedia(assetId: string): Promise<boolean> {
  const final = fileFor(assetId)
  if (!final) return false
  await mkdir(mediaDir(), { recursive: true })
  const tmp = `${final}.part`
  await rm(tmp, { force: true }).catch(() => undefined)
  writers.set(assetId, { handle: await open(tmp, 'w'), tmp, final })
  return true
}

export async function chunkMedia(assetId: string, bytes: ArrayBuffer): Promise<void> {
  const w = writers.get(assetId)
  if (!w) throw new Error('media: unknown write')
  await w.handle.write(Buffer.from(bytes))
}

/** Close and put the file under its real name. */
export async function finishMedia(assetId: string): Promise<number> {
  const w = writers.get(assetId)
  if (!w) throw new Error('media: unknown write')
  writers.delete(assetId)
  await w.handle.close()
  const { rename } = await import('node:fs/promises')
  await rename(w.tmp, w.final)
  return (await stat(w.final)).size
}

/** Abandon a write and leave nothing behind. */
export async function cancelMedia(assetId: string): Promise<void> {
  const w = writers.get(assetId)
  if (!w) return
  writers.delete(assetId)
  await w.handle.close().catch(() => undefined)
  await rm(w.tmp, { force: true }).catch(() => undefined)
}

/** Read one slice of an asset's copy back. */
export async function readMedia(assetId: string, offset: number, length: number): Promise<ArrayBuffer | null> {
  const file = fileFor(assetId)
  if (!file) return null
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    // Copy out of the pooled backing store: handing the pool across IPC would
    // send whatever else shares that allocation.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Drop an asset's copy, for when he deletes the media for good. */
export async function deleteMedia(assetId: string): Promise<void> {
  const file = fileFor(assetId)
  if (!file) return
  await rm(file, { force: true }).catch(() => undefined)
}

/** Half written files from a run that died. Startup only, when no write is live. */
export async function sweepMediaTemps(): Promise<number> {
  const dir = mediaDir()
  const names = await readdir(dir).catch(() => [] as string[])
  let gone = 0
  for (const name of names) {
    if (!name.endsWith('.part')) continue
    await rm(path.join(dir, name), { force: true }).catch(() => undefined)
    gone += 1
  }
  return gone
}

/** Bytes on disk for every asset copy, so the size of this can be reported honestly. */
export async function mediaBytes(): Promise<number> {
  return (await listMedia()).reduce((n, m) => n + m.size, 0)
}

export { createReadStream }
