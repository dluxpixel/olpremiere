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
 * Everywhere a copy might be, newest arrangement first.
 *
 * ⛔ BECAUSE `userData` IS NOT AS FIXED AS IT LOOKS. This app has already renamed
 * its own profile once (`reel` to `OL Premiere`, see main.ts), a `--user-data-dir`
 * moves it wholesale, and on 2026-08-23 his app reported no spare copies while
 * 23 files and 7.1 GB sat in the folder the default path resolves to. Reading the
 * one place and calling it settled is what turned that into two more days.
 *
 * The fallbacks are DERIVED, never guessed: the roaming folder under the app's
 * own name, and the legacy profile this app is already known to have used. A
 * folder that is not there costs one failed `readdir`.
 */
function mediaDirs(): string[] {
  const dirs = [mediaDir()]
  try {
    const roaming = app.getPath('appData')
    for (const name of [app.getName(), 'OL Premiere', 'reel']) {
      const d = path.join(roaming, name, 'media')
      if (!dirs.includes(d)) dirs.push(d)
    }
  } catch {
    // getPath can throw before the app is ready; the primary is enough then.
  }
  return dirs
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

/**
 * Which assets have a copy on disk, and how big each one is.
 *
 * ⛔ IT REPORTS THE FOLDER IT LOOKED IN AND WHY IT FOUND NOTHING. This swallowed
 * its own `readdir` error and answered with an empty list, which reads everywhere
 * downstream as "there are no copies". On 2026-08-23 his app said exactly that
 * while 23 files and 7.1 GB sat in the folder I had filled, and there was no way
 * to tell a missing folder from an unreadable one from the wrong path entirely.
 * A repair that cannot say WHERE it looked cannot be debugged from his side of
 * the screen, and he has spent days on that.
 */
export async function listMedia(): Promise<{ dir: string; error?: string; files: { id: string; size: number }[] }> {
  const tried: string[] = []
  for (const dir of mediaDirs()) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      tried.push(`${dir} (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    const files: { id: string; size: number }[] = []
    let skipped = 0
    for (const name of names) {
      if (!SAFE_ID.test(name)) {
        skipped += 1
        continue
      }
      const s = await stat(path.join(dir, name)).catch(() => null)
      if (s?.isFile() && s.size > 0) files.push({ id: name, size: s.size })
      else skipped += 1
    }
    // ⛔ THE FIRST FOLDER THAT ACTUALLY HAS SOMETHING WINS, and which one it was
    // is reported. Reading only the default path is what left him staring at
    // "there are no spare copies" with 7.1 GB of them on the disk.
    if (files.length > 0) return { dir, files }
    tried.push(`${dir} (${names.length} files, none usable, ${skipped} skipped)`)
  }
  return { dir: tried.join(' | '), error: 'no spare copies found', files: [] }
}

/** Where a NEW copy goes. Always the primary, whatever the fallbacks turned up. */
export function mediaWriteDir(): string {
  return mediaDir()
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
  // ⛔ NEVER REPLACE A LIVE WRITER. This used to remove the part file the first
  // writer still held open and take over its slot, so the rest of that stream
  // was written through the second handle and the rename published two
  // interleaved streams under the asset's real name. The renderer refuses to
  // start a second write for one id, and this is the half that survives a
  // renderer reload, which the renderer's own guard cannot.
  if (writers.has(assetId)) return false
  await mkdir(mediaDir(), { recursive: true })
  const tmp = `${final}.part`
  await rm(tmp, { force: true }).catch(() => undefined)
  writers.set(assetId, { handle: await open(tmp, 'w'), tmp, final })
  return true
}

/**
 * Abandon every open write and leave no part files behind.
 *
 * The page going away is the moment those writes are certainly dead, and without
 * this a reload mid import would pin that asset's writer slot for the life of
 * the main process, so the guard above would refuse it forever.
 */
export async function dropWriters(): Promise<void> {
  for (const assetId of [...writers.keys()]) await cancelMedia(assetId)
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
  // ⛔ FLUSH BEFORE THE RENAME. NTFS journals metadata, not data: the rename and
  // the file's length become durable well before its contents do. The part file
  // dance protects against the PROCESS dying, and this protects against the
  // MACHINE dying, which is the worse of the two, because a leftover part file
  // is swept and written again while a full length file of zeros under the real
  // name is indistinguishable from good footage to every reader in the app.
  // One flush per import, at the end, not per chunk.
  await w.handle.datasync().catch(() => undefined)
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
  if (!SAFE_ID.test(assetId)) return null
  // ⛔ THE SAME FOLDERS `listMedia` SEARCHES, or a copy it found would be one this
  // cannot open, which is a worse failure than not finding it at all.
  let handle: FileHandle | null = null
  for (const dir of mediaDirs()) {
    handle = await open(path.join(dir, assetId), 'r').catch(() => null)
    if (handle) break
  }
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
  if (!SAFE_ID.test(assetId)) return
  // Every folder it could be in, or a delete would leave a copy behind that the
  // next repair would happily put back.
  for (const dir of mediaDirs()) await rm(path.join(dir, assetId), { force: true }).catch(() => undefined)
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
  return (await listMedia()).files.reduce((n, m) => n + m.size, 0)
}

export { createReadStream }
