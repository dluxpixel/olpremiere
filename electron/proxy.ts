// Preview proxies: a small, short-GOP copy of an imported video that exists
// ONLY so the preview can jump around it instantly. Export never touches it.
//
// WHY THIS EXISTS, MEASURED
//
// A run of short pieces cut from one recording was the worst case the preview
// had, and it was not a pixel problem. Measured on a 1080p source: one cold
// frame from a scattered position in the file takes about 133 ms to decode,
// because a normal camera file only has a keyframe every couple of seconds and
// everything between them has to be decoded in order to reach the frame that
// was asked for. Cutting to 0.4 s pieces asks for a new scattered frame every
// 400 ms, so the decoder can never catch up, and the picture ran as much as ten
// seconds behind the playhead.
//
// Shrinking the picture does not fix that; shortening the distance between
// keyframes does. A proxy with a keyframe every 12 frames turns "decode two
// seconds of video to reach one frame" into "decode at most twelve small
// frames", which is the difference between missing every cut and hitting it.
//
// The size trade is deliberate: a keyframe-heavy file is bigger per second than
// a normal one, and he has explicitly accepted disk cost for a preview that
// works. Height is capped at preview height, which is all the program monitor
// can show anyway.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { sweepProxyDir } from './proxyTemp'
import { app } from 'electron'

/** The bundled ffmpeg.exe: extraResources in prod, vendor/ in dev. Same rule as native export. */
function ffmpegPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : path.join(app.getAppPath(), 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')
}

/**
 * Frames between keyframes in the proxy. Twelve is the number that matters: it
 * is short enough that the worst random seek decodes twelve small frames, and
 * long enough that the file does not balloon the way all-intra does.
 */
const PROXY_GOP = 12
/**
 * Proxy height, deliberately EQUAL to the preview's own existing cap
 * (PREVIEW_BASE_MAX_H in frameCache.ts) rather than lower.
 *
 * The speed comes from the keyframe spacing, not from the pixels. Measured on
 * the cut-heavy case: 720p wrong-frame rate 8%, 1080p 14%, against 90% before
 * either. Six points is not worth a preview that looks softer than it does
 * today on a large display, and a downscaled proxy would do exactly that when
 * the program monitor is bigger than 720 lines. Nothing above this cap was ever
 * shown, so capping here costs no visible sharpness at all.
 */
const PROXY_HEIGHT = 1080
/**
 * A proxy is only worth building when the source is actually hard to seek. A
 * small file already decodes fast enough, and transcoding it would cost him an
 * import wait for nothing.
 */
export const PROXY_MIN_HEIGHT = 540

let building = 0
/** True while any proxy transcode is running; the updater must not restart underneath one. */
export const proxyBusy = (): boolean => building > 0

function proxyDir(): string {
  return path.join(app.getPath('userData'), 'proxies')
}

// The source arrives in CHUNKS, not in one buffer. His imports are gameplay
// captures measured in gigabytes, and a whole-file ArrayBuffer would have to
// exist twice at once (renderer and main) before ffmpeg saw a byte of it: the
// heaviest files, the ones that need a proxy most, are exactly the ones that
// would have failed. Chunks stream straight to a temp file, so peak memory is
// one chunk regardless of source size. The OUTPUT is returned whole, which is
// safe because a proxy is small by construction.

interface Upload {
  inPath: string
  outPath: string
  handle: FileHandle
}
const uploads = new Map<string, Upload>()

/**
 * Delete temp files left behind by a transcode that never finished.
 *
 * ⛔ FOUND ON HIS MACHINE, 2026-08-12: his proxies folder held ONE file, a
 * **427 MB `in-` temp dated 6 August**, and no `out-` proxy at all. So a build
 * streamed a whole source across, then died before ffmpeg produced anything, and
 * **the 427 MB has been sitting there ever since on a C drive at 98 percent.**
 *
 * The existing cleanup is a `finally` inside `finishProxy`, which is exactly the
 * code that does NOT run when the app is closed or killed mid-transcode. Nothing
 * ever looked at the folder again, so a crash cost him a permanent copy of his
 * own footage.
 *
 * Safe to run at startup and only at startup: `uploads` is empty then, so every
 * temp in there belongs to a run that is already over. Failures are swallowed,
 * because tidying up must never be the thing that stops the app opening.
 */
export const sweepProxyTemps = (): Promise<number> => sweepProxyDir(proxyDir())

/** Open a temp file to stream a source into. Returns the id every later call quotes. */
export async function beginProxy(): Promise<string> {
  const dir = proxyDir()
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  const inPath = path.join(dir, `in-${id}`)
  uploads.set(id, { inPath, outPath: path.join(dir, `out-${id}.mp4`), handle: await open(inPath, 'w') })
  return id
}

/** Append one chunk of the source. */
export async function chunkProxy(id: string, bytes: ArrayBuffer): Promise<void> {
  const up = uploads.get(id)
  if (!up) throw new Error('proxy: unknown upload')
  await up.handle.write(Buffer.from(bytes))
}

/**
 * Transcode what was uploaded and return the preview copy.
 *
 * Runs to completion or throws, and always cleans up both temp files. The
 * caller decides what a failure means; here it must never be fatal, because a
 * missing proxy only means the preview reads the original, which is exactly
 * what it did before proxies existed.
 */
export async function finishProxy(id: string): Promise<ArrayBuffer> {
  const up = uploads.get(id)
  if (!up) throw new Error('proxy: unknown upload')
  uploads.delete(id)
  building++
  try {
    await up.handle.close()
    await runFfmpeg(up.inPath, up.outPath)
    const out = await readFile(up.outPath)
    // Copy out of the Buffer's pooled backing store: handing the pool itself
    // across the IPC boundary would send whatever else shares that allocation.
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
  } finally {
    building--
    await rm(up.inPath, { force: true }).catch(() => undefined)
    await rm(up.outPath, { force: true }).catch(() => undefined)
  }
}

/** Abandon an upload (the renderer gave up, or a chunk failed). Never throws. */
export async function cancelProxy(id: string): Promise<void> {
  const up = uploads.get(id)
  if (!up) return
  uploads.delete(id)
  await up.handle.close().catch(() => undefined)
  await rm(up.inPath, { force: true }).catch(() => undefined)
}

function runFfmpeg(inPath: string, outPath: string): Promise<void> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inPath,
    // Never upscale: a source already shorter than the cap keeps its height.
    '-vf',
    `scale=-2:'min(${PROXY_HEIGHT},ih)'`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    // The whole point. -g caps the keyframe distance; without no-scenecut,
    // ffmpeg is free to place keyframes on scene changes INSTEAD of on the
    // grid, which leaves exactly the long gaps this file exists to remove.
    '-g',
    String(PROXY_GOP),
    '-keyint_min',
    String(PROXY_GOP),
    '-sc_threshold',
    '0',
    // Preview audio comes from the Web Audio graph, decoded from the original.
    '-an',
    '-movflags',
    '+faststart',
    outPath,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`proxy transcode failed (${code}): ${stderr.slice(-500)}`))
    })
  })
}
