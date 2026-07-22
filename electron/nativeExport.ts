// Native ffmpeg export (main process). Receives raw RGBA frames from the renderer
// (rendered by the SAME shared WebGL pipeline as the preview), pipes them to a
// bundled static ffmpeg over stdin, and muxes with a temp-WAV audio mix. This is
// the "maximum quality" path — real x264/x265/NVENC/ProRes/lossless encoders the
// browser's WebCodecs can't reach. ffmpeg runs ONLY here, never in the renderer.

import { app, dialog, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFile, unlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NativeCaps, NativeExportConfig, NativeFinishResult, NativeStartResult } from './ipc-types'

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

/** True while a native ffmpeg export is running — the auto-updater must never force-quit through it. */
export function isExporting(): boolean {
  return job !== null || pendingAudioPath !== null
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
        encoders: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'prores_ks', 'ffv1'].filter(has),
        nvenc: { h264: has('h264_nvenc'), hevc: has('hevc_nvenc'), av1: has('av1_nvenc') },
      })
    })
  })
}

// -- audio: write the mix to a temp WAV BEFORE ffmpeg spawns (it's an -i input) --
export async function prepareAudio(wav: ArrayBuffer): Promise<void> {
  const p = path.join(tmpdir(), `olp-audio-${process.pid}-${Date.now()}.wav`)
  await writeFile(p, Buffer.from(wav))
  pendingAudioPath = p
}

// -- ffmpeg args -----------------------------------------------------------
function videoEncoderArgs(config: NativeExportConfig): string[] {
  const q = Math.max(0, Math.min(51, Math.round(config.quality)))
  switch (config.encoder) {
    case 'x264':
      return ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', String(q), '-pix_fmt', 'yuv420p']
    case 'x265':
      return ['-c:v', 'libx265', '-preset', 'slow', '-crf', String(q), '-pix_fmt', 'yuv420p']
    case 'nvenc-h264':
      return ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'constqp', '-qp', String(q), '-pix_fmt', 'yuv420p']
    case 'nvenc-hevc':
      return ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'constqp', '-qp', String(q), '-pix_fmt', 'yuv420p']
    case 'nvenc-av1':
      return ['-c:v', 'av1_nvenc', '-preset', 'p7', '-rc', 'constqp', '-qp', String(q), '-pix_fmt', 'yuv420p']
    case 'prores':
      // ProRes 422 HQ, 10-bit 4:2:2 — an intermediate/master format.
      return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
    case 'lossless':
      // Visually lossless H.264 (QP 0). Plays everywhere; huge files.
      return ['-c:v', 'libx264', '-preset', 'veryslow', '-qp', '0', '-pix_fmt', 'yuv420p']
  }
}

function buildArgs(config: NativeExportConfig, audioPath: string | null, outPath: string): string[] {
  const args = [
    '-y',
    '-hide_banner',
    // Raw RGBA video from stdin.
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${config.width}x${config.height}`, '-framerate', String(config.fps), '-i', 'pipe:0',
  ]
  if (audioPath) args.push('-i', audioPath)
  // GL frames are bottom-origin (vflip). Convert the full-range RGBA readback to
  // limited-range BT.709 YUV EXPLICITLY rather than letting swscale pick the
  // RGB→YUV matrix by a resolution heuristic — which could convert with BT.601
  // while we tag BT.709. (Verified pixel-identical to the implicit path on the
  // bundled ffmpeg, so this is version/raster-drift hardening, not a visible
  // change — the export corruption reported separately is NOT this.)
  args.push('-vf', 'vflip,scale=in_range=full:out_range=tv:out_color_matrix=bt709')
  args.push(...videoEncoderArgs(config))
  args.push('-map', '0:v:0')
  if (audioPath) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '320k')
  // Tag BT.709 limited range so players/YouTube don't guess (the washed-out fix).
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv')
  // Machine-readable progress on stdout (the movie goes to a file).
  args.push('-progress', 'pipe:1', '-nostats')
  args.push(outPath)
  return args
}

// -- start: pick destination + spawn ---------------------------------------
export async function start(config: NativeExportConfig, win: BrowserWindow): Promise<NativeStartResult> {
  let outPath = config.outPath
  if (!outPath) {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export video',
      defaultPath: config.suggestedName,
      filters: [{ name: config.encoder === 'prores' ? 'QuickTime' : 'MP4 video', extensions: [config.encoder === 'prores' ? 'mov' : 'mp4'] }],
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
  // stdin EPIPE if ffmpeg dies early — swallow, the close code surfaces the error.
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
    const ok = job.ffmpeg.stdin.write(Buffer.from(frame))
    if (ok) resolve()
    else job.ffmpeg.stdin.once('drain', () => resolve())
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
