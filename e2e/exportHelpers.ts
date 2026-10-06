import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import type { Page } from '@playwright/test'

/**
 * Shrink the sequence so a test export encodes in seconds.
 *
 * Export has no settings any more: one button, and the app picks everything.
 * The raster follows the SEQUENCE (and a sub-HD sequence is never upscaled), so
 * this is how a spec asks for a small file. It used to pick "SD" in a dropdown
 * that no longer exists. Refit is off: the clips must stay exactly as the test
 * placed them.
 */
export async function shrinkSequence(page: Page, width = 640, height = 360): Promise<void> {
  await page.evaluate(
    async ({ w, h }) => {
      const storeMod = '/src/state/store.ts'
      const { setActiveSequenceFormat } = (await import(/* @vite-ignore */ storeMod)) as {
        setActiveSequenceFormat: (w: number, h: number, refit?: boolean) => void
      }
      setActiveSequenceFormat(w, h, false)
    },
    { w: width, h: height },
  )
}

// ---------------------------------------------------------------------------
// Reading an exported file back with the bundled ffmpeg, which is the one the desktop app encodes
// with. There is no ffprobe in the bundle, so everything below is read off ffmpeg's own report, the
// container's bytes, or decoded pixels. Used by the phone shape spec (e2e/phone-format.spec.ts) and
// its unit twin (src/engine/export/phoneExport.test.ts), so both measure a file the same way.

/** The bundled ffmpeg, relative to the repo root where playwright and vitest both run. */
export const FFMPEG = path.join('vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')

export const ffmpegAvailable = (): boolean => fs.existsSync(FFMPEG)

export interface FfmpegResult {
  code: number | null
  /** Everything ffmpeg wrote to stdout (raw pixels when asked for them). */
  out: Buffer
  /** Everything it wrote to stderr: its report and its log. */
  err: string
}

/**
 * Run the bundled ffmpeg once, with no console window and BELOW_NORMAL priority so a test never
 * lags the machine it runs on. `feed` writes to its stdin, honouring backpressure.
 */
export function runFfmpeg(args: string[], feed?: (stdin: Writable) => Promise<void>): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Best effort: the run is still correct, only louder on the machine.
    }
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('latin1')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }))
    // ffmpeg can quit before it has read everything (a bad argument): that is the exit code's to say.
    child.stdin.on('error', () => undefined)
    if (feed) feed(child.stdin).then(() => child.stdin.end(), reject)
    else child.stdin.end()
  })
}

/**
 * The H.264 level an MP4 declares, as ffmpeg and the spec write it times ten (51 is level 5.1), read
 * from the avcC box's AVCLevelIndication byte. null when the file has no H.264 track.
 *
 * avcC is: version, profile, profile compatibility, level, so the level is the fourth byte after the
 * box name. That is the level a phone's decoder is told, and it is the same value as the stream's own
 * parameter set, which x264 and the browser's encoder both write.
 */
export function avcLevelOf(file: Buffer): number | null {
  const at = file.indexOf('avcC', 0, 'latin1')
  if (at < 0 || at + 8 > file.length) return null
  return file[at + 7]
}

/** What cropdetect says the picture is: the last crop it settled on, W x H at X, Y. */
export interface Crop {
  w: number
  h: number
  x: number
  y: number
}

/**
 * Ask ffmpeg's cropdetect where the picture is, over the first frames. Black above, below or beside
 * the picture comes back as a smaller crop. `limit` 24 is its own default: black is 16 in the limited
 * range these files are written in, so a band of black reads as black and real footage does not.
 */
export async function cropdetect(file: string, frames = 24): Promise<Crop | null> {
  const r = await runFfmpeg(['-i', file, '-vf', 'cropdetect=limit=24:round=2:reset=0', '-frames:v', String(frames), '-f', 'null', '-'])
  const all = [...r.err.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
  const last = all[all.length - 1]
  return last ? { w: Number(last[1]), h: Number(last[2]), x: Number(last[3]), y: Number(last[4]) } : null
}

/** How many whole rows or columns at each edge are black, from one decoded frame. 0 on all four is "no band". */
export interface Bands {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * Decode one frame at `atS` and count the black rows and columns at each edge, by mean luma per row
 * and per column (at or under 24, the same limit cropdetect uses). A row or column is black only if
 * the whole line of it is, so a dark corner of a real picture is not a band.
 */
export async function edgeBands(file: string, w: number, h: number, atS = 0.5): Promise<Bands> {
  const r = await runFfmpeg(['-v', 'error', '-ss', String(atS), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  if (r.out.length !== w * h) throw new Error(`expected a ${w}x${h} gray frame, got ${r.out.length} bytes: ${r.err.slice(0, 300)}`)
  const BLACK = 24
  const rowMean = (y: number): number => {
    let s = 0
    for (let x = 0; x < w; x++) s += r.out[y * w + x]
    return s / w
  }
  const colMean = (x: number): number => {
    let s = 0
    for (let y = 0; y < h; y++) s += r.out[y * w + x]
    return s / h
  }
  const run = (n: number, at: (i: number) => number): number => {
    let c = 0
    while (c < n && at(c) <= BLACK) c++
    return c
  }
  return {
    top: run(h, (i) => rowMean(i)),
    bottom: run(h, (i) => rowMean(h - 1 - i)),
    left: run(w, (i) => colMean(i)),
    right: run(w, (i) => colMean(w - 1 - i)),
  }
}

/**
 * One decoded frame as packed RGB (3 bytes a pixel, top row first), for reading what colour a
 * given row or column really holds in the file. The file is tagged BT.709, which ffmpeg honours.
 */
export async function framePixels(file: string, w: number, h: number, atS = 0.5): Promise<Buffer> {
  const r = await runFfmpeg(['-v', 'error', '-ss', String(atS), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (r.out.length !== w * h * 3) throw new Error(`expected a ${w}x${h} rgb frame, got ${r.out.length} bytes: ${r.err.slice(0, 300)}`)
  return r.out
}

/** The average colour of row `y` between columns x0 and x1 of a packed RGB frame. */
export function rowColour(rgb: Buffer, w: number, y: number, x0 = 0, x1 = w): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 3
    r += rgb[i]
    g += rgb[i + 1]
    b += rgb[i + 2]
  }
  const n = x1 - x0
  return [r / n, g / n, b / n]
}

/** The width and height ffmpeg reports for a file's first video stream, or null. */
export async function videoSizeOf(file: string): Promise<{ w: number; h: number } | null> {
  const r = await runFfmpeg(['-i', file])
  const m = /Video: .*?, (\d{2,5})x(\d{2,5})[ ,[]/.exec(r.err)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}
