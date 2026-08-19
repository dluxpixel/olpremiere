// Native ffmpeg export (main process). Receives raw RGBA frames from the renderer
// (rendered by the SAME shared WebGL pipeline as the preview), pipes them to a
// bundled static ffmpeg over stdin, and muxes with a temp-WAV audio mix. This is
// the "maximum quality" path: real x264/x265/NVENC/ProRes/lossless encoders the
// browser's WebCodecs can't reach. ffmpeg runs ONLY here, never in the renderer.

import { app, dialog, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFile, unlink, stat } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NativeCaps, NativeExportConfig, NativeFinishResult, NativeStartResult } from './ipc-types'
import { buildArgs, containerExt } from './exportArgs'

/** The bundled ffmpeg.exe: extraResources in prod, vendor/ in dev. */
function ffmpegPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : path.join(app.getAppPath(), 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')
}

interface Job {
  ffmpeg: ChildProcessWithoutNullStreams
  outPath: string
  audioPath: string | null
  totalFrames: number
  stderr: string
  closed: Promise<number | null>
}
let job: Job | null = null
let pendingAudioPath: string | null = null

/**
 * True while a native ffmpeg export is actually running. It is the auto-updater's
 * main-side guard. The renderer's isCriticalWorkInFlight() covers the pre-spawn
 * prep phase (before `job` exists), so this tracks only the spawned process and
 * can't get wedged true (pendingAudioPath is deliberately excluded).
 */
export function isExporting(): boolean {
  return job !== null
}

/**
 * Synchronous best-effort teardown for app 'before-quit', where an async unlink
 * would race the process exit: SIGKILL ffmpeg and remove the truncated output +
 * temp WAV right now, so a quit-during-export leaves nothing orphaned or leaked.
 */
export function cancelSync(): void {
  const stale = [pendingAudioPath, job?.outPath, job?.audioPath]
  if (job) {
    try {
      job.ffmpeg.stdin.destroy()
      job.ffmpeg.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  job = null
  pendingAudioPath = null
  for (const p of stale) {
    if (!p) continue
    try {
      unlinkSync(p)
    } catch {
      // best effort, since a killed ffmpeg may still hold the handle for a beat
    }
  }
}

// -- probe -----------------------------------------------------------------
export async function probe(): Promise<NativeCaps> {
  return new Promise((resolve) => {
    let out = ''
    const p = spawn(ffmpegPath(), ['-hide_banner', '-encoders'])
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('error', () => resolve({ ok: false, encoders: [], nvenc: { h264: false, hevc: false, av1: false } }))
    p.on('close', () => {
      const has = (name: string) => new RegExp('\\b' + name + '\\b').test(out)
      resolve({
        ok: true,
        // Exactly the encoders NativeEncoder can ask for, nothing else. ffv1 used
        // to be probed here and was never selectable, so it only ever widened the
        // codec set the bundled ffmpeg had to carry.
        encoders: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'prores_ks'].filter(has),
        nvenc: { h264: has('h264_nvenc'), hevc: has('hevc_nvenc'), av1: has('av1_nvenc') },
      })
    })
  })
}

// -- audio: write the mix to a temp WAV BEFORE ffmpeg spawns (it's an -i input) --
export async function prepareAudio(wav: ArrayBuffer): Promise<void> {
  // Whatever was waiting here is now unreachable: only one path can be pending,
  // and the caller is about to replace it. Dropping it first means a second
  // export attempt cannot strand the first attempt's mix on his disk.
  if (pendingAudioPath) void unlink(pendingAudioPath).catch(() => {})
  const p = path.join(tmpdir(), `olp-audio-${process.pid}-${Date.now()}.wav`)
  await writeFile(p, Buffer.from(wav))
  pendingAudioPath = p
}

// -- start: pick destination + spawn ---------------------------------------
export async function start(config: NativeExportConfig, win: BrowserWindow): Promise<NativeStartResult> {
  let outPath = config.outPath
  if (!outPath) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export video',
      defaultPath: config.suggestedName,
      filters: [{ name: config.encoder === 'prores' ? 'QuickTime' : 'MP4 video', extensions: [containerExt(config.encoder)] }],
    })
    if (res.canceled || !res.filePath) {
      if (pendingAudioPath) void unlink(pendingAudioPath).catch(() => {})
      pendingAudioPath = null
      return { started: false, cancelled: true }
    }
    outPath = res.filePath
  }

  const audioPath = config.hasAudio ? pendingAudioPath : null
  pendingAudioPath = null
  const ffmpeg = spawn(ffmpegPath(), buildArgs(config, audioPath, outPath), { stdio: ['pipe', 'pipe', 'pipe'] })

  let stderr = ''
  ffmpeg.stderr.on('data', (d) => {
    stderr += d.toString()
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
  })
  // Parse -progress key=value blocks from stdout → a percentage.
  ffmpeg.stdout.on('data', (d: Buffer) => {
    for (const line of d.toString().split(/\r?\n/)) {
      const m = /^frame=(\d+)/.exec(line.trim())
      if (m && job) {
        const frame = Number(m[1])
        win.webContents.send('native:progress', { frame, totalFrames: job.totalFrames })
      }
    }
  })
  // stdin EPIPE if ffmpeg dies early. Swallow it; the close code surfaces the error.
  ffmpeg.stdin.on('error', () => {})

  const closed = new Promise<number | null>((resolve) => ffmpeg.on('close', (code) => resolve(code)))
  job = { ffmpeg, outPath, audioPath, totalFrames: config.totalFrames, stderr: '', closed }
  // Keep stderr live-updated on the job.
  ffmpeg.stderr.on('data', () => job && (job.stderr = stderr))
  return { started: true, outPath }
}

// -- writeFrame: one RGBA frame → stdin, resolves on drain (backpressure) ----
export function writeFrame(frame: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!job || !job.ffmpeg.stdin.writable) return reject(new Error('ffmpeg is not running'))
    const j = job
    const ok = j.ffmpeg.stdin.write(Buffer.from(frame))
    if (ok) return resolve()
    // A 4K frame is ~33 MB against a 64 KB pipe, so EVERY frame parks here. If
    // ffmpeg dies while one is in flight, 'drain' never fires and the stdin
    // 'error' above is swallowed, so the promise would never settle, the worker
    // would sit in waitFrameAck forever, and the export UI would freeze at N%
    // with no error. Race the drain against the process actually ending; first
    // settle wins, so the happy path is unchanged.
    const cleanup = (): void => {
      j.ffmpeg.stdin.removeListener('drain', onDrain)
      j.ffmpeg.stdin.removeListener('close', onGone)
      j.ffmpeg.removeListener('close', onGone)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onGone = (): void => {
      cleanup()
      reject(new Error('ffmpeg exited during export'))
    }
    j.ffmpeg.stdin.once('drain', onDrain)
    j.ffmpeg.stdin.once('close', onGone)
    j.ffmpeg.once('close', onGone)
  })
}

// -- finish: close stdin, wait for exit, clean up --------------------------
export async function finish(): Promise<NativeFinishResult> {
  if (!job) return { ok: false, error: 'no export in progress' }
  const j = job
  j.ffmpeg.stdin.end()
  const code = await j.closed
  job = null
  if (j.audioPath) void unlink(j.audioPath).catch(() => {})
  if (code !== 0) {
    void unlink(j.outPath).catch(() => {})
    const tail = j.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' · ')
    return { ok: false, error: `ffmpeg exited with code ${code}${tail ? ': ' + tail : ''}` }
  }
  let sizeBytes = 0
  try {
    sizeBytes = (await stat(j.outPath)).size
  } catch {
    // ignore
  }
  return { ok: true, outPath: j.outPath, sizeBytes }
}

// -- cancel: kill + clean up ------------------------------------------------
export async function cancel(): Promise<void> {
  if (!job) {
    if (pendingAudioPath) void unlink(pendingAudioPath).catch(() => {})
    pendingAudioPath = null
    return
  }
  const j = job
  job = null
  try {
    j.ffmpeg.stdin.destroy()
    j.ffmpeg.kill('SIGKILL')
  } catch {
    // already gone
  }
  await j.closed.catch(() => null)
  void unlink(j.outPath).catch(() => {})
  if (j.audioPath) void unlink(j.audioPath).catch(() => {})
}
