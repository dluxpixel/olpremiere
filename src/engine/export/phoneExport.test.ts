// The phone screen shape through the REAL bundled ffmpeg, with the exact arguments the desktop app
// sends: what comes out is the file he posts, so it is checked as a file, not as a list of arguments.
//
// His ask, 2026-10-05: a 1080 x 2112 frame (TikTok and Reels play a video in that shape), exported as
// a clean H.264 file at exactly that size. Two things are NOT obvious from the arguments, and they
// are what this proves:
//
//  1. THE LEVEL. electron/exportArgs.ts pins 4.2 only where the frame fits 8704 macroblocks, and
//     1080 x 2112 is 68 x 132 = 8976. So the level is x264's own choice, and it has to be one a phone
//     decodes. Measured on the bundled binary: veryslow wrote level 5.1 (16 reference frames), slow
//     writes 5.0 (5 reference frames, 2026-10-06). 5.0 or 5.1 is fine; 4.x could not hold the frame.
//  2. THE EDGES. The raw frames go in at the phone raster and come out at it, with no band added.
//
// Slower than most of the suite on purpose: it spawns a real encoder, like electron/sdrMaster.test.ts.
// It runs at BELOW_NORMAL priority and on four threads, so it never lags the machine. Skipped, loudly,
// where the ffmpeg bundle is not present (a fresh worktree has no vendor/).

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildArgs } from '../../../electron/exportArgs'
import type { NativeExportConfig } from '../../../electron/ipc-types'
import { avcLevelOf, cropdetect, edgeBands, ffmpegAvailable, runFfmpeg, videoSizeOf } from '../../../e2e/exportHelpers'
import { EXPORT_KEYFRAME_S, planExport } from './exportPlan'

const W = 1080
const H = 2112
const FRAMES = 12
/** Each check spawns ffmpeg at below normal priority, and the default 5 seconds is too little on a busy machine. */
const CHECK_TIMEOUT_MS = 60_000

/** H.264 Table A-1: the most macroblocks a frame and a second a level allows, for the levels that could be written. */
const LEVELS: Record<number, { maxFs: number; maxMbps: number }> = {
  42: { maxFs: 8704, maxMbps: 522240 },
  50: { maxFs: 22080, maxMbps: 589824 },
  51: { maxFs: 36864, maxMbps: 983040 },
  52: { maxFs: 36864, maxMbps: 2073600 },
}

/** One bright RGBA frame: nothing in it is dark, so any black in the file is a band the export added. */
function brightFrame(): Buffer {
  const buf = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1)
    const r = Math.round(210 - 130 * t)
    const g = 130
    const b = Math.round(80 + 130 * t)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = 255
    }
  }
  return buf
}

async function feedFrames(stdin: Writable): Promise<void> {
  const frame = brightFrame()
  for (let i = 0; i < FRAMES; i++) {
    if (!stdin.write(frame)) await new Promise<void>((resolve) => stdin.once('drain', () => resolve()))
  }
}

describe.skipIf(!ffmpegAvailable())('a phone screen export, through the real x264', () => {
  let dir = ''
  let out = ''
  let log = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'olp-phone-'))
    out = join(dir, 'phone.mp4')
    // The args the app builds for this shape: the plan gives the raster, quality and keyframe cadence.
    const plan = planExport({ id: 's', name: 'S', fps: 30, width: W, height: H, sampleRate: 48000, durationS: 1, tracks: [], markers: [] })
    const cfg: NativeExportConfig = {
      width: plan.settings.width,
      height: plan.settings.height,
      fps: plan.settings.fps,
      totalFrames: FRAMES,
      encoder: plan.nativeEncoder,
      quality: plan.qp,
      keyframeIntervalS: EXPORT_KEYFRAME_S,
      hasAudio: false,
      suggestedName: 'phone.mp4',
    }
    const args = buildArgs(cfg, null, out)
    // Four threads, not x264's every-core default: the level and the picture do not depend on it.
    args.splice(args.length - 1, 0, '-threads', '4')
    const r = await runFfmpeg(args, feedFrames)
    log = r.err
    expect(r.code, log.slice(-600)).toBe(0)
  }, 180_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('is a file of exactly 1080 x 2112, High profile, yuv420p, tagged BT.709', async () => {
    expect(await videoSizeOf(out)).toEqual({ w: W, h: H })
    const r = await runFfmpeg(['-i', out])
    expect(r.err).toMatch(/Video: h264 \(High\).*yuv420p\(tv, bt709/)
    expect(r.err).toContain('1080x2112')
  }, CHECK_TIMEOUT_MS)

  it('declares a level a phone plays, 5.0 or 5.1, and the level really holds the frame', async () => {
    const level = avcLevelOf(await readFile(out))
    expect([50, 51], `level_idc ${level}`).toContain(level)
    // x264 says the same in its own log.
    expect(log).toMatch(/profile High, level 5\.[01]/)
    // 8976 macroblocks a frame and 269280 a second: over 4.2's 8704 a frame, inside 5.0 and 5.1.
    const mbs = Math.ceil(W / 16) * Math.ceil(H / 16)
    expect(mbs).toBe(8976)
    expect(mbs).toBeGreaterThan(LEVELS[42].maxFs)
    const allowed = LEVELS[level!]
    expect(mbs).toBeLessThanOrEqual(allowed.maxFs)
    expect(mbs * 30).toBeLessThanOrEqual(allowed.maxMbps)
  }, CHECK_TIMEOUT_MS)

  it('decodes cleanly, every frame, with nothing said on stderr', async () => {
    const r = await runFfmpeg(['-v', 'error', '-i', out, '-f', 'null', '-'])
    expect(r.code).toBe(0)
    expect(r.err.trim()).toBe('')
    const n = await runFfmpeg(['-i', out, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'])
    expect(n.err).toMatch(new RegExp(`frame=\\s*${FRAMES}\\b`))
  }, CHECK_TIMEOUT_MS)

  it('has no black band on any edge: not a row at the top or bottom, not a column at either side', async () => {
    expect(await edgeBands(out, W, H, 0.1)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    // And the crop detector agrees: the picture is the whole frame.
    expect(await cropdetect(out)).toEqual({ w: W, h: H, x: 0, y: 0 })
  }, CHECK_TIMEOUT_MS)
})
