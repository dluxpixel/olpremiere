// Turn a recording Chromium cannot open into one it can, ONCE, on import.
//
// His OBS captures are .mkv and Chromium cannot demux Matroska, so the import
// fails at the very front door: probeFile builds a <video>, `loadedmetadata`
// never fires, and no asset is ever created. Converting here means every other
// part of the app, preview, proxy, export, is untouched code that never learns
// Matroska exists.
//
// The policy lives in remuxArgs.ts and is unit tested without spawning anything.
// This file is only the plumbing. See there for WHY the video is copied and why
// opus audio is rebuilt even though MP4 would take it.

import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { sweepProxyDir } from './proxyTemp'
import { convertToMp4, type ConvertResult } from './remuxRun'

/** The bundled ffmpeg.exe: extraResources in prod, vendor/ in dev. Same rule as the proxy. */
function ffmpegPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : path.join(app.getAppPath(), 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')
}

function remuxDir(): string {
  return path.join(app.getPath('userData'), 'remux')
}

let working = 0
/** True while a conversion is running; the updater must not restart underneath one. */
export const remuxBusy = (): boolean => working > 0

/**
 * ⛔ THE OUTPUT IS **NOT** RETURNED WHOLE. A remux is a LOSSLESS copy of his
 * source, so a 6 GB capture comes back as 6 GB: returning that whole would need
 * it in memory twice, in main and in the renderer, and the biggest captures, the
 * ones that most need this, are exactly the ones that would die. So the source
 * streams IN as chunks and the result is read back OUT as chunks, and peak
 * memory is one chunk either way.
 *
 * ⛔ THIS USED TO SAY THE PROXY WAS DIFFERENT BECAUSE "a proxy is small by
 * construction". It is not, and that sentence cost him every preview copy he
 * never got: measured 2026-08-22, his own capture makes a 423 MB one. Both paths
 * now read back in chunks and there is no difference left to explain.
 */
interface Job {
  inPath: string
  outPath: string
  handle: FileHandle | null
}
const jobs = new Map<string, Job>()

/**
 * Delete temps left by a conversion that never finished. Safe at startup and
 * only at startup, when `jobs` is empty so every temp belongs to a finished run.
 *
 * The proxy folder taught this the expensive way: a build that died mid-run left
 * a 427 MB copy of his own footage sitting on a C drive at 98 percent, and
 * nothing ever looked at the folder again. A remux temp is FULL SIZE, so the
 * same mistake here is measured in gigabytes.
 */
export const sweepRemuxTemps = (): Promise<number> => sweepProxyDir(remuxDir())

/** Open a temp file to stream a source into. Returns the id every later call quotes. */
export async function beginRemux(): Promise<string> {
  const dir = remuxDir()
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  const inPath = path.join(dir, `in-${id}`)
  jobs.set(id, { inPath, outPath: path.join(dir, `out-${id}.mp4`), handle: await open(inPath, 'w') })
  return id
}

/** Append one chunk of the source. */
export async function chunkRemux(id: string, bytes: ArrayBuffer): Promise<void> {
  const job = jobs.get(id)
  if (!job?.handle) throw new Error('remux: unknown upload')
  await job.handle.write(Buffer.from(bytes))
}

/**
 * Convert what was uploaded. The SOURCE temp goes immediately; the OUTPUT stays
 * until `releaseRemux`, because the renderer still has to read it back.
 */
export async function finishRemux(id: string): Promise<ConvertResult> {
  const job = jobs.get(id)
  if (!job?.handle) throw new Error('remux: unknown upload')
  working++
  try {
    await job.handle.close()
    job.handle = null
    return await convertToMp4(ffmpegPath(), job.inPath, job.outPath)
  } finally {
    working--
    // The source copy goes now either way. It is full size and keeping it around
    // for a failure nobody will read is how the proxy folder ate 427 MB.
    await rm(job.inPath, { force: true }).catch(() => undefined)
  }
}

/** Read one slice of the converted file back. */
export async function readRemux(id: string, offset: number, length: number): Promise<ArrayBuffer> {
  const job = jobs.get(id)
  if (!job) throw new Error('remux: unknown job')
  const handle = await open(job.outPath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    // Copy out of the Buffer's pooled backing store: handing the pool itself
    // across the IPC boundary would send whatever else shares that allocation.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Every job at once, because the renderer that owned them is gone.
 *
 * ⛔ A REMUX TEMP IS A FULL SIZE COPY OF HIS SOURCE, so one orphaned by a reload
 * is gigabytes sitting on a drive he keeps close to full. `jobs` lives in main
 * and outlives the page, and nothing can ever ask for those bytes again.
 */
export async function releaseAllRemuxes(): Promise<void> {
  await Promise.all([...jobs.keys()].map((id) => releaseRemux(id)))
}

/** Done reading, or gave up. Never throws, and always removes both temps. */
export async function releaseRemux(id: string): Promise<void> {
  const job = jobs.get(id)
  if (!job) return
  jobs.delete(id)
  await job.handle?.close().catch(() => undefined)
  await rm(job.inPath, { force: true }).catch(() => undefined)
  await rm(job.outPath, { force: true }).catch(() => undefined)
}
