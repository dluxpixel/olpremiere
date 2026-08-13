// The conversion itself, kept in its OWN file with no `electron` import so it
// can be run against a REAL file by a real ffmpeg in the tests. Same rule and
// same reason as proxyTemp.ts: the part worth proving is the part that touches
// the disk and spawns a process, and that is exactly the part a mock cannot
// prove anything about.
//
// The argument POLICY lives in remuxArgs.ts. This is the running of it.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { parseSourceStreams, probeArgs, remuxArgs, remuxPlan } from './remuxArgs'

/** ffmpeg says everything on stderr, including when it is succeeding. */
export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      // A capture with a damaged tail can make ffmpeg complain without end. Keep
      // the head, where the stream report is, and stop growing.
      if (stderr.length > 64_000) stderr = stderr.slice(0, 64_000)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }))
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
 * Turn one recording into an MP4 the app can open. Throws with a reason a person
 * could act on, because a failure here means his footage did not import.
 */
export async function convertToMp4(ffmpegPath: string, inPath: string, outPath: string): Promise<ConvertResult> {
  // ⛔ The probe exits NON-ZERO by design: ffmpeg was asked to open the file and
  // write nothing, so it reports and then complains that it had no output.
  // Reading its exit code here would fail every healthy capture.
  const probe = await runFfmpeg(ffmpegPath, probeArgs(inPath))
  const streams = parseSourceStreams(probe.stderr)
  if (!streams.video && !streams.audio) {
    const why = probe.stderr.trim().split('\n').pop() ?? ''
    throw new Error(`no video or audio could be read from this recording: ${why}`)
  }

  const plan = remuxPlan(streams)
  const out = await runFfmpeg(ffmpegPath, remuxArgs(inPath, outPath, plan))
  if (out.code !== 0) throw new Error(out.stderr.trim().split('\n').pop() || 'the conversion failed')

  const { size } = await stat(outPath)
  // ffmpeg can exit 0 having written nothing at all when the source ends mid
  // frame, which is exactly the shape of a recording that is still being written.
  if (size === 0) throw new Error('the conversion produced an empty file')
  return { size, copied: plan.canCopyVideo && !plan.reencodeAudio, durationS: streams.durationS }
}
