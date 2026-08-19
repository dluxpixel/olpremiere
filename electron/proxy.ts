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
// works. Size is capped by a PIXEL budget rather than a line count, so a picture
// standing on its end keeps its detail instead of losing two thirds of it.
//
// The transcode runs on the graphics card when the machine has one, and always
// at idle priority, so building the fast preview cannot slow down the preview.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as osConstants, setPriority } from 'node:os'
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
 * How big a preview copy may be, in PIXELS rather than in LINES.
 *
 * The speed still comes from the keyframe spacing, not from the pixels.
 * Measured on the cut-heavy case: 720p wrong-frame rate 8%, 1080p 14%, against
 * 90% before either. Six points is not worth a softer preview, so this stays as
 * large as the preview can actually show.
 *
 * ⛔ IT WAS A HEIGHT, AND A HEIGHT IS THE WRONG SHAPE FOR A VERTICAL SHORT. The
 * old cap was 1080 LINES, matching PREVIEW_BASE_MAX_H, and its last line claimed
 * nothing above it was ever shown. That went stale the day the frame cache
 * raised its OWN cap to the sequence height, because capping a 1920 tall short
 * to 1080 softened every paused frame (frameCache.ts). A 1080x1920 short came
 * out of here at 608x1080 and every frame the cache served was stretched 1.78x
 * back up into the sequence raster: soft picture, on the one format he publishes.
 *
 * 1920*1080 is the SAME budget the old cap already handed a landscape source,
 * which was never downscaled at all, so this raises no ceiling anywhere: not
 * decoder memory, not proxy bytes, not the whole-file read in finishProxy. 4K
 * still lands on exactly 1920x1080. It only stops turning the raster on its side
 * from costing two thirds of the picture.
 */
const PROXY_MAX_PIXELS = 1920 * 1080
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

/**
 * MEASURED ON HIS MACHINE, 2026-08-19, 72 seconds of 1080p through this exact
 * filter chain. i9-13900HX, 32 threads, RTX 4060 Laptop.
 *
 * | encoder      | wall  | processor time | cores busy | proxy size |
 * | ------------ | ----- | -------------- | ---------- | ---------- |
 * | libx264      | 7.7 s | 81 s           | **10.6**   | 51 MB      |
 * | h264_qsv     | 8.8 s | 24 s           | **2.7**    | 57 MB      |
 * | h264_nvenc   | fails: his driver offers nvenc API 13.0, ffmpeg wants 13.1  |
 *
 * ⛔ THE NUMBER THAT MATTERS IS CORES BUSY, NOT WALL CLOCK. A preview copy is
 * built while he is editing, and libx264 takes ten cores to do it: that is the
 * thing that has been making the picture stutter for the first minutes after a
 * big import, and the pause in proxyMedia.ts can only ever stop the NEXT file,
 * never the one already running. QuickSync does the same job on a quarter of the
 * processor for 15% more wall clock and 11% more disk. On forty imported clips
 * the wait is unchanged and the machine is handed back.
 *
 * ⛔ AND FOUR AT ONCE IS NOT THE ANSWER, which is worth writing down because it
 * looks obvious. Measured on the same file: four copies one after another took
 * 30.3 s, four at once took 28.2 s, two at once 26.8 s. libx264 already spreads
 * one file across the machine, so parallel workers buy about a tenth and cost a
 * full extra temp copy of a multi-gigabyte capture on a drive that has been at
 * 98 percent. Not worth it. The queue stays serial on purpose.
 *
 * The ladder is tried once and the answer sticks for the session: a machine with
 * no Intel graphics should not pay a dead spawn per imported file.
 */
let encoderChoice: 'qsv' | 'nvenc' | 'software' | null = null

/** Video arguments for the software encoder: exactly what this file always used. */
const SOFTWARE_VIDEO_ARGS = [
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
]

/**
 * Intel QuickSync, on the processor's own graphics.
 *
 * global_quality 26 was picked by measurement rather than by matching the crf
 * number: 24 gave 67 MB, 26 gave 57 MB and 28 gave 46 MB against libx264's 51 MB
 * on the same 72 seconds. 26 keeps the preview a shade cleaner than the software
 * copy for 11 percent more disk.
 *
 * ⛔ -g ALONE IS ENOUGH HERE and the libx264 spellings are not. QuickSync ignores
 * -keyint_min and -sc_threshold; passing them is accepted in silence, which would
 * look like a short GOP and not be one. Counted rather than assumed: 180 I frames
 * in 2160, one every twelve, the same as the software copy.
 */
const QSV_VIDEO_ARGS = ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '26', '-g', String(PROXY_GOP)]

/**
 * NVIDIA, for a machine with a card and no Intel graphics.
 *
 * ⛔ -no-scenecut IS THE NVENC SPELLING OF -sc_threshold 0. Handing nvenc the
 * libx264 option is accepted and ignored, which would put keyframes back on scene
 * changes and quietly undo the one thing a preview copy is for.
 */
const NVENC_VIDEO_ARGS = [
  '-c:v',
  'h264_nvenc',
  '-preset',
  'p4',
  '-rc',
  'constqp',
  '-qp',
  '24',
  '-g',
  String(PROXY_GOP),
  '-keyint_min',
  String(PROXY_GOP),
  '-no-scenecut',
  '1',
  '-pix_fmt',
  'yuv420p',
]

const VIDEO_ARGS = {
  qsv: QSV_VIDEO_ARGS,
  nvenc: NVENC_VIDEO_ARGS,
  software: SOFTWARE_VIDEO_ARGS,
} as const

function proxyArgs(inPath: string, outPath: string, encoder: 'qsv' | 'nvenc' | 'software'): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inPath,
    // Height from the pixel budget at the source's own aspect: w*h <= B with
    // w = h*iw/ih gives h <= sqrt(B*ih/iw). Never upscaled (the min with ih), and
    // forced EVEN, which the old min(1080,ih) was not: an odd height source
    // produced an odd height and the encoder refuses it. Width follows from -2,
    // so the aspect is kept and stays even too.
    '-vf',
    `scale=-2:'trunc(min(ih,sqrt(${PROXY_MAX_PIXELS}*ih/iw))/2)*2'`,
    ...VIDEO_ARGS[encoder],
    // Preview audio comes from the Web Audio graph, decoded from the original.
    '-an',
    '-movflags',
    '+faststart',
    outPath,
  ]
}

function spawnFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    // ⛔ IT RUNS BELOW EVERYTHING ELSE, ON PURPOSE. The pause in
    // src/engine/proxyMedia.ts can only stop the NEXT copy starting; it has no
    // handle on this one, and on a long recording this one is minutes of work. So
    // rather than trying to stop it, make it unable to take a core the preview
    // wants: Windows schedules strictly by priority, so an idle-priority encoder
    // thread is preempted the moment a renderer decode thread is ready. On an idle
    // machine nothing else is ready and the copy still gets everything, so this
    // costs nothing when he is not watching. Best effort, and a failure here only
    // means the old behaviour continues.
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_LOW)
      } catch {
        // Still correct, just louder.
      }
    }
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

/** Human name for the log line, so a machine's answer is visible in the console. */
const ENCODER_NAME = {
  qsv: "the processor's built in graphics",
  nvenc: 'the graphics card',
  software: 'the processor',
} as const

async function runFfmpeg(inPath: string, outPath: string): Promise<void> {
  if (encoderChoice) {
    await spawnFfmpeg(proxyArgs(inPath, outPath, encoderChoice))
    return
  }
  for (const candidate of ['qsv', 'nvenc', 'software'] as const) {
    try {
      await spawnFfmpeg(proxyArgs(inPath, outPath, candidate))
      encoderChoice = candidate
      console.log(`OL Premiere: preview copies are being built on ${ENCODER_NAME[candidate]}`)
      return
    } catch (err) {
      if (candidate === 'software') throw err
      // Try the next rung. Nothing is reported to him: a machine without Intel
      // graphics or without a card is not a fault, and the software copy is
      // exactly what he had before.
      console.warn(`OL Premiere: preview copies cannot use ${ENCODER_NAME[candidate]}`, err)
    }
  }
}
