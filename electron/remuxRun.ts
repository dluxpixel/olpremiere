// The conversion itself, kept in its OWN file with no `electron` import so it
// can be run against a REAL file by a real ffmpeg in the tests. Same rule and
// same reason as proxyTemp.ts: the part worth proving is the part that touches
// the disk and spawns a process, and that is exactly the part a mock cannot
// prove anything about.
//
// The argument POLICY lives in remuxArgs.ts. This is the running of it.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import {
  MASTER_LADDER,
  frameCountArgs,
  framesLost,
  parseSourceStreams,
  probeArgs,
  remuxArgs,
  remuxPlan,
  rescuePlan,
  sdrMasterArgs,
  type MasterEncoder,
  type SourceStreams,
  type ToneMapper,
} from './remuxArgs'

export interface FfmpegRun {
  code: number
  stderr: string
  /** The last `frame=` ffmpeg's -progress reported, 0 when it reported none. */
  frames: number
}

export interface RunOptions {
  /** Seconds of output written so far, from ffmpeg's -progress on stdout. */
  onTime?: (outS: number) => void
}

/** ffmpeg says everything on stderr, including when it is succeeding. */
export function runFfmpeg(ffmpegPath: string, args: string[], opts: RunOptions = {}): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    // ⛔ NORMAL PRIORITY, NOT THE PROXY'S IDLE ONE. A preview copy is built
    // while he edits; this is what he is WAITING for, the clip is not in his bin
    // until it ends. Measured 2026-10-01 on his machine under load: his 75 s
    // clip took 106.6 s at below normal and 55.9 s at normal, which is the
    // difference between slower and faster than the clip itself.
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let frames = 0
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      // A capture with a damaged tail can make ffmpeg complain without end. Keep
      // the head, where the stream report is, and stop growing.
      if (stderr.length > 64_000) stderr = stderr.slice(0, 64_000)
    })
    // -progress writes key=value lines here. Read it ALWAYS: a pipe nobody
    // drains fills up and stalls ffmpeg mid file.
    let pending = ''
    child.stdout.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const f = /^frame=(\d+)/.exec(line)
        if (f) frames = Number(f[1])
        const t = /^out_time_us=(\d+)/.exec(line)
        if (t && opts.onTime) opts.onTime(Number(t[1]) / 1e6)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stderr, frames }))
  })
}

export interface ConvertResult {
  /** Bytes of the converted file. */
  size: number
  /** True when only the container changed, so nothing was re-encoded. */
  copied: boolean
  durationS: number
}

/**
 * Why this conversion is happening.
 *
 * 'convert' changes the container of a recording Chromium cannot demux (his OBS
 * .mkv). 'rescue' re-encodes a file Chromium already refused. 'sdr' makes the
 * SDR master of an HDR phone clip (remuxArgs.ts, "HDR phone clips").
 */
export type ConvertMode = 'convert' | 'rescue' | 'sdr'

/** The last line ffmpeg wrote on stderr, which is where it says why. */
const lastLine = (stderr: string): string => stderr.trim().split('\n').pop()?.trim() ?? ''

/** How many video frames the source really has, or 0 when that could not be read. */
async function sourceFrames(ffmpegPath: string, inPath: string): Promise<number> {
  const r = await runFfmpeg(ffmpegPath, frameCountArgs(inPath))
  return r.code === 0 ? r.frames : 0
}

/** Output seconds as a share of the whole, for the progress he sees. */
const shareOf = (durationS: number, onProgress?: (frac: number) => void) => (s: number) => {
  if (onProgress && durationS > 0) onProgress(Math.min(1, Math.max(0, s / durationS)))
}

/**
 * The rung of MASTER_LADDER that worked last, so the next clip goes straight to
 * it. Same reason as the encoder choice in proxy.ts: a machine with no Vulkan or
 * no QuickSync should not pay a dead spawn per imported clip.
 */
let masterChoice: { tonemap: ToneMapper; encoder: MasterEncoder } | null = null

/** Forget the remembered rung, so a test can run the ladder from the top. */
export function resetMasterChoice(): void {
  masterChoice = null
}

/**
 * Make the SDR master, trying each way down the ladder until one works.
 *
 * ⛔ A RUNG THAT FAILS BEFORE ITS FIRST FRAME IS THE MACHINE, ONE THAT FAILS
 * AFTER IS THE FILE. No Vulkan, no QuickSync: ffmpeg gives up while opening, and
 * the next rung is the answer. A frame that will not decode half way through is
 * the same frame on every rung, so trying three more would only make him wait
 * four times as long to hear the same thing.
 */
async function makeSdrMaster(
  ffmpegPath: string,
  inPath: string,
  outPath: string,
  streams: SourceStreams,
  onProgress?: (frac: number) => void,
): Promise<void> {
  const plan = remuxPlan(streams)
  const known = masterChoice
  const ladder = known
    ? [known, ...MASTER_LADDER.filter((r) => r.tonemap !== known.tonemap || r.encoder !== known.encoder)]
    : MASTER_LADDER
  const expected = await sourceFrames(ffmpegPath, inPath)
  let why = 'the conversion failed'
  for (const rung of ladder) {
    const out = await runFfmpeg(ffmpegPath, sdrMasterArgs(inPath, outPath, plan, rung.tonemap, rung.encoder), {
      onTime: shareOf(streams.durationS, onProgress),
    })
    if (out.code === 0) {
      const lost = framesLost(expected, out.frames)
      if (lost > 0) throw new Error(`the conversion lost ${lost} of ${expected} frames`)
      if (known !== rung) console.log(`OL Premiere: HDR clips are tone mapped by ${rung.tonemap}, written by ${rung.encoder}`)
      masterChoice = rung
      return
    }
    why = lastLine(out.stderr) || `ffmpeg exited with code ${out.code}`
    if (out.frames > 0) throw new Error(why)
    console.warn(`OL Premiere: HDR clips cannot use ${rung.tonemap} with ${rung.encoder}:`, why)
  }
  throw new Error(why)
}

/**
 * Turn one recording into an MP4 the app can open. Throws with a reason a person
 * could act on, because a failure here means his footage did not import.
 */
export async function convertToMp4(
  ffmpegPath: string,
  inPath: string,
  outPath: string,
  mode: ConvertMode = 'convert',
  onProgress?: (frac: number) => void,
): Promise<ConvertResult> {
  // ⛔ The probe exits NON-ZERO by design: ffmpeg was asked to open the file and
  // write nothing, so it reports and then complains that it had no output.
  // Reading its exit code here would fail every healthy capture.
  const probe = await runFfmpeg(ffmpegPath, probeArgs(inPath))
  const streams = parseSourceStreams(probe.stderr)
  if (!streams.video && !streams.audio) {
    throw new Error(`no video or audio could be read from this recording: ${lastLine(probe.stderr)}`)
  }

  let copied = false
  // ⛔ A RESCUED HDR CLIP GETS THE SAME MASTER AS AN IMPORTED ONE. The plain
  // rescue below squeezed the 10 bit HLG picture into 8 bits still tagged HLG,
  // dropped its Dolby Vision, and left Chromium to tone map what was left.
  if (streams.video && (mode === 'sdr' || (mode === 'rescue' && streams.hdr))) {
    await makeSdrMaster(ffmpegPath, inPath, outPath, streams, onProgress)
  } else if (mode === 'sdr') {
    throw new Error('there is no picture in this recording to convert')
  } else {
    // ⛔ 'rescue' MEANS THE BROWSER ALREADY REFUSED THIS FILE, so copying the
    // video stream would hand the same decoder the same codec a second time. See
    // rescuePlan in remuxArgs.ts: it forces H.264 for exactly that reason.
    const plan = mode === 'rescue' ? rescuePlan(streams) : remuxPlan(streams)
    // A re-encode is held to the source's own frame count; a copy cannot lose one.
    const expected = plan.canCopyVideo ? 0 : await sourceFrames(ffmpegPath, inPath)
    const out = await runFfmpeg(ffmpegPath, remuxArgs(inPath, outPath, plan), {
      onTime: shareOf(streams.durationS, onProgress),
    })
    if (out.code !== 0) throw new Error(lastLine(out.stderr) || 'the conversion failed')
    // ⛔ AND A HOLE IS A FAILURE, NOT A SMALLER FILE. The rescued clip that came
    // back 389 of 405 frames exited 0 and was imported without a word.
    const lost = framesLost(expected, out.frames)
    if (lost > 0) throw new Error(`the conversion lost ${lost} of ${expected} frames`)
    copied = plan.canCopyVideo && !plan.reencodeAudio
  }

  const { size } = await stat(outPath)
  // ffmpeg can exit 0 having written nothing at all when the source ends mid
  // frame, which is exactly the shape of a recording that is still being written.
  if (size === 0) throw new Error('the conversion produced an empty file')
  return { size, copied, durationS: streams.durationS }
}
