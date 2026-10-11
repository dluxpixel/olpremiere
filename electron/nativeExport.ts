// Native ffmpeg export (main process). Receives raw RGBA frames from the renderer
// (rendered by the SAME shared WebGL pipeline as the preview), pipes them to a
// bundled static ffmpeg over stdin, and muxes with a temp-WAV audio mix. This is
// the "maximum quality" path: real x264/x265/NVENC/ProRes/lossless encoders the
// browser's WebCodecs can't reach. ffmpeg runs ONLY here, never in the renderer.

import { app, dialog, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { open, unlink, stat, type FileHandle } from 'node:fs/promises'
import { closeSync, unlinkSync } from 'node:fs'
import { constants as osConstants, setPriority, tmpdir } from 'node:os'
import path from 'node:path'
import type { NativeCaps, NativeEncoder, NativeExportConfig, NativeFinishResult, NativeStartResult } from './ipc-types'
import { buildArgs, containerExt } from './exportArgs'
import { rememberFolder, suggestedPath } from './saveFiles'
import { claimPick } from './exportPresetFolder'

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
  /** cancel() took it: whatever ffmpeg's exit code, there is no file and finish says so. */
  cancelled: boolean
}
let job: Job | null = null
let pendingAudioPath: string | null = null

/** An ffmpeg start() has spawned and is waiting on, before it becomes the job. */
interface Starting {
  ffmpeg: ChildProcessWithoutNullStreams
  outPath: string
  audioPath: string | null
}
let starting: Starting | null = null

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
  const stale = [pendingAudioPath, audioWrite?.path, job?.outPath, job?.audioPath, starting?.outPath, starting?.audioPath]
  if (starting) {
    try {
      starting.ffmpeg.stdin.destroy()
      starting.ffmpeg.kill('SIGKILL')
    } catch {
      // already gone
    }
    starting = null
  }
  if (audioWrite) {
    try {
      closeSync(audioWrite.handle.fd)
    } catch {
      // already closed
    }
    audioWrite = null
  }
  if (job) {
    job.cancelled = true
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
    // ⛔ windowsHide, LIKE EVERY OTHER FFMPEG SPAWN IN THIS APP. Without it
    // Windows gives the child its own console, and a black box flashes over his
    // editor. `proxy.ts` and `remuxRun.ts` both pass it; these two were missed,
    // which is why he still saw one after the scheduled tasks were silenced.
    // His words, 2026-08-24: *"CMD still sometimes pops up."*
    const p = spawn(ffmpegPath(), ['-hide_banner', '-encoders'], { windowsHide: true })
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

// -- audio: the mix, streamed to a temp WAV BEFORE ffmpeg spawns (it's an -i input) --
//
// ⛔ ONE SEGMENT AT A TIME, NOT THE WHOLE MIX IN ONE MESSAGE. The renderer used
// to hold every segment, then a joined copy, then a WAV copy, and send that as a
// single IPC message: 384 KB a second, so a 12 minute video was about 276 MB in
// one message, past Chromium's default cap, on top of three copies in memory
// (export audit, 2026-10-06). The same begin, chunk, finish shape as the media
// mirror (mediaStore.ts). Bit for bit the same file the one-message path wrote.

/** The 44 byte header of an interleaved 32 bit float WAV holding `dataBytes` of samples. */
export function wavHeaderF32(channels: number, sampleRate: number, dataBytes: number): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(3, 20) // IEEE float
  b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * channels * 4, 28)
  b.writeUInt16LE(channels * 4, 32)
  b.writeUInt16LE(32, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(dataBytes, 40)
  return b
}

interface AudioWrite {
  path: string
  handle: FileHandle
  channels: number
  sampleRate: number
  dataBytes: number
}
let audioWrite: AudioWrite | null = null

/** Give up on a mix being written or waiting: close it and take it off his disk. */
async function dropAudio(): Promise<void> {
  const w = audioWrite
  audioWrite = null
  if (w) {
    await w.handle.close().catch(() => undefined)
    void unlink(w.path).catch(() => {})
  }
  if (pendingAudioPath) void unlink(pendingAudioPath).catch(() => {})
  pendingAudioPath = null
}

export async function beginAudio(sampleRate: number, channels: number): Promise<void> {
  // Whatever was waiting here is now unreachable: only one mix can be pending,
  // and the caller is about to replace it. Dropping it first means a second
  // export attempt cannot strand the first attempt's mix on his disk.
  await dropAudio()
  const p = path.join(tmpdir(), `olp-audio-${process.pid}-${Date.now()}.wav`)
  const handle = await open(p, 'w')
  // The sizes are not known yet; finishAudio writes the header again with them.
  await handle.write(wavHeaderF32(channels, sampleRate, 0), 0, 44, 0)
  audioWrite = { path: p, handle, channels, sampleRate, dataBytes: 0 }
}

/** One segment of interleaved little-endian float samples, in order. */
export async function audioChunk(interleaved: ArrayBuffer): Promise<void> {
  const w = audioWrite
  if (!w) throw new Error('no sound is being written')
  const buf = Buffer.from(interleaved)
  await w.handle.write(buf, 0, buf.length, 44 + w.dataBytes)
  w.dataBytes += buf.length
}

export async function finishAudio(): Promise<void> {
  const w = audioWrite
  if (!w) throw new Error('no sound is being written')
  // ⛔ STILL IN audioWrite UNTIL IT IS CLOSED. It used to be let go first, so a
  // header rewrite or close that failed left the whole mix in his temp folder,
  // in neither audioWrite nor pendingAudioPath, where no cancel could find it
  // (export review, 2026-10-08). A failure takes it off his disk here.
  try {
    await w.handle.write(wavHeaderF32(w.channels, w.sampleRate, w.dataBytes), 0, 44, 0)
    await w.handle.close()
  } catch (err) {
    if (audioWrite === w) audioWrite = null
    await w.handle.close().catch(() => undefined)
    void unlink(w.path).catch(() => {})
    throw err
  }
  // A cancel while it was being closed has already taken it away.
  if (audioWrite !== w) return
  audioWrite = null
  pendingAudioPath = w.path
}

// -- pickOutput: the save dialog alone, before anything is made --------------
/**
 * Where the file goes, or null when he dismissed the dialog.
 *
 * ⛔ ASKED FIRST, ON ITS OWN. The dialog used to come up inside start(), after
 * the whole sound mix had been rendered (twice with Platform loudness on), so
 * dismissing it threw all of that away, and the loudness switch, which starts
 * the export again, asked a second time for a file he had already named (export
 * audit, 2026-10-06). The renderer now asks this before the sound, keeps the
 * answer, and hands it to start() as config.outPath.
 */
export async function pickOutput(encoder: NativeEncoder, suggestedName: string, win: BrowserWindow): Promise<string | null> {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export video',
    // His last export folder and a name nothing there has yet (saveFiles.ts):
    // never the same 'Untitled Project.mp4' and a replace prompt.
    defaultPath: suggestedPath('export', suggestedName.replace(/\.[^.]+$/, ''), containerExt(encoder)),
    filters: [{ name: encoder === 'prores' ? 'QuickTime' : 'MP4 video', extensions: [containerExt(encoder)] }],
  })
  if (res.canceled || !res.filePath) return null
  rememberFolder('export', res.filePath)
  return res.filePath
}

// -- start: pick destination if not chosen yet + spawn -----------------------
export async function start(config: NativeExportConfig, win: BrowserWindow): Promise<NativeStartResult> {
  let outPath = config.outPath
  if (!outPath) {
    const picked = await pickOutput(config.encoder, config.suggestedName, win)
    if (!picked) {
      if (pendingAudioPath) void unlink(pendingAudioPath).catch(() => {})
      pendingAudioPath = null
      return { started: false, cancelled: true }
    }
    outPath = picked
  }
  const audioPath = config.hasAudio ? pendingAudioPath : null
  pendingAudioPath = null
  // A file name main made for a preset can have been taken since (the sound is made in
  // between). ⛔ It is claimed as an empty file that only appears if nothing has the
  // name (claimPick), so ffmpeg's -y and a cancel's delete only ever touch that file.
  // Any other path stays as it is.
  let placeholder: string | null = null
  // Nothing else will ever pick this mix up, or the empty placeholder, once start() says no.
  const couldNotStart = (err: unknown): NativeStartResult => {
    if (audioPath) void unlink(audioPath).catch(() => {})
    if (placeholder) void unlink(placeholder).catch(() => {})
    return { started: false, error: `could not start ffmpeg: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const claimed = claimPick(outPath)
    outPath = claimed.outPath
    if (claimed.placeholder) placeholder = claimed.outPath
  } catch (err) {
    return couldNotStart(err)
  }
  // windowsHide as above: an export is the longest ffmpeg run in the app, so a
  // console here sits over his editor for the whole encode.
  let ffmpeg: ChildProcessWithoutNullStreams
  try {
    ffmpeg = spawn(ffmpegPath(), buildArgs(config, audioPath, outPath), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    // Some refusals (EPERM from an antivirus) are thrown right here.
    return couldNotStart(err)
  }
  // ⛔ AN 'error' NOBODY LISTENS FOR IS THROWN, and in main that is the "A
  // JavaScript error occurred in the main process" box over his editor. A
  // missing or quarantined ffmpeg.exe reports itself exactly that way, a tick
  // after spawn, and this used to answer "started" first (export audit,
  // 2026-10-06). The throw also cut Node off before it sent 'close', so a cancel
  // waiting on `closed` hung for good. So the listener stays for the life of the
  // process, the error ends `closed` too, and start() waits for ffmpeg to really
  // be running before it says so.
  ffmpeg.stdin.on('error', () => {})
  let ended: (code: number | null) => void = () => {}
  const closed = new Promise<number | null>((resolve) => (ended = resolve))
  const launched = new Promise<Error | null>((resolve) => {
    ffmpeg.once('spawn', () => resolve(null))
    ffmpeg.on('error', (err) => {
      resolve(err)
      ended(null)
    })
  })
  ffmpeg.on('close', (code) => ended(code))
  // ⛔ PARKED WHERE A QUIT CAN FIND IT. The job is set only once ffmpeg is
  // really running, and until then the mix was only in a local here: a quit in
  // that tick (cancelSync) found no job, so it neither stopped this ffmpeg nor
  // deleted the mix (export review, 2026-10-08).
  const mine: Starting = { ffmpeg, outPath, audioPath }
  starting = mine
  const failed = await launched
  if (starting !== mine) {
    // cancelSync took it while it started: stopped, and its files are gone.
    return { started: false, cancelled: true }
  }
  starting = null
  if (failed) return couldNotStart(failed)
  // ⛔ BELOW NORMAL PRIORITY. The whole point of Keep working (his ask, 2026-09-28)
  // is editing while this runs, and at normal priority x264 took every core for
  // minutes against the preview's decode threads. Windows schedules strictly by
  // priority, so the preview now wins a core whenever it wants one, and when he
  // is not touching the app nothing else is ready and the export still gets them
  // all. Below normal, not the preview copies' idle (proxy.ts): he does want this
  // file. Best effort; a failure only means the old behaviour.
  if (ffmpeg.pid !== undefined) {
    try {
      setPriority(ffmpeg.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Still correct, just louder.
    }
  }

  let stderr = ''
  ffmpeg.stderr.on('data', (d) => {
    stderr += d.toString()
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
  })
  // Parse -progress key=value blocks from stdout → a percentage.
  const readProgress = progressReader((frame) => {
    if (job) win.webContents.send('native:progress', { frame, totalFrames: job.totalFrames })
  })
  ffmpeg.stdout.on('data', (d: Buffer) => readProgress(d.toString()))
  // stdin EPIPE if ffmpeg dies early is swallowed above; the close code surfaces the error.

  job = { ffmpeg, outPath, audioPath, totalFrames: config.totalFrames, stderr: '', closed, cancelled: false }
  // Keep stderr live-updated on the job.
  ffmpeg.stderr.on('data', () => job && (job.stderr = stderr))
  return { started: true, outPath }
}

/**
 * Reads ffmpeg's -progress output into frame counts.
 *
 * ⛔ A CHUNK CAN END MID LINE. Split per chunk, "frame=12" + "3" was read as 12
 * and the 3 thrown away, a count that could run backwards. The unfinished line
 * waits for the rest, the way remuxRun.ts already reads the same output.
 */
export function progressReader(onFrame: (frame: number) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const m = /^frame=(\d+)/.exec(line.trim())
      if (m) onFrame(Number(m[1]))
    }
  }
}

/**
 * ffmpeg's exit code as ffmpeg means it. Windows hands a negative one back
 * unsigned, so its "-2, no such file" arrives as 4294967294.
 */
export function exitCodeOf(code: number | null): number | null {
  return code !== null && code > 0x7fffffff ? code - 0x100000000 : code
}

/** The last lines ffmpeg wrote on stderr, which is where it says why. */
export function stderrTail(stderr: string): string {
  return stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' · ')
}

/**
 * What to tell him when ffmpeg dies while frames are still going in.
 *
 * ⛔ IT USED TO BE THE BARE WORDS "ffmpeg exited during export". Seen
 * 2026-09-29 on a machine out of memory: the export stopped after 7 s with
 * exactly that, so neither he nor a log could tell running out of memory from
 * a codec error. The reason was in `job.stderr` the whole time; only `finish`
 * ever read it, and a death mid stream never gets there. So this waits for the
 * process to really end (its stderr is complete then and its exit code known),
 * a couple of seconds at most, and says both.
 */
async function diedMessage(j: Job): Promise<string> {
  const code = await Promise.race([j.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000))])
  const tail = stderrTail(j.stderr)
  const exit = code === undefined ? '' : ` (exit code ${exitCodeOf(code) ?? 'none, it was stopped'})`
  return `ffmpeg exited during export${exit}${tail ? ': ' + tail : ''}`
}

// -- writeFrame: one RGBA frame → stdin, resolves on drain (backpressure) ----
export function writeFrame(frame: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!job) return reject(new Error('ffmpeg is not running'))
    // A job whose stdin has closed is a process that died between two frames.
    if (!job.ffmpeg.stdin.writable) {
      void diedMessage(job).then((msg) => reject(new Error(msg)))
      return
    }
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
      void diedMessage(j).then((msg) => reject(new Error(msg)))
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
  if (job === j) job = null
  if (j.audioPath) void unlink(j.audioPath).catch(() => {})
  // ⛔ A CANCEL WHILE THIS WAITED. cancel() kills ffmpeg, and this wait was
  // queued first, so this used to answer "ffmpeg exited with code null" before
  // the cancel did, and the page ended a Cancel he pressed as a failure. Had
  // ffmpeg exited 0 in that instant, this said ok and cancel then deleted the
  // file the Done chip pointed at (export review, 2026-10-08). A cancelled job
  // has no file, whatever the exit code, and says so.
  if (j.cancelled) {
    void unlink(j.outPath).catch(() => {})
    return { ok: false, cancelled: true }
  }
  if (code !== 0) {
    void unlink(j.outPath).catch(() => {})
    const tail = stderrTail(j.stderr)
    return { ok: false, error: `ffmpeg exited with code ${exitCodeOf(code)}${tail ? ': ' + tail : ''}` }
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
    // Nothing running: the mix being written, or waiting for ffmpeg, is all there is.
    await dropAudio()
    return
  }
  const j = job
  job = null
  // Before anything can yield: a finish() waiting on this job reads it first.
  j.cancelled = true
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
