// When ffmpeg dies in the middle of an export, he is told WHY.
//
// ⛔ SEEN 2026-09-29 in the real app, on a machine that had run out of memory:
// the export stopped after 7 seconds and the dialog said "ffmpeg exited during
// export" and nothing else. Out of memory, a codec error and a full disk all
// read the same, so neither he nor a log could tell what to do next. ffmpeg had
// written the reason on stderr; only the end-of-export path ever read it.
//
// A REAL ffmpeg is made to die here, the way it does in his app: frames are
// pouring in and the output cannot be written.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plainExportError } from '../src/engine/export/plainError'

let userData = ''
const REPO = join(import.meta.dirname, '..')
let appPath = REPO
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    // The real repo, so the bundled ffmpeg is found the way the dev shell finds it.
    getAppPath: () => appPath,
    getPath: (k: string) => (k === 'userData' ? userData : join(userData, k)),
  },
  dialog: {},
}))

// The real call, watched: which process it lowered, and a way to make it fail.
const priority = vi.hoisted(() => ({ calls: [] as [number, number][], fail: false }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  return {
    ...real,
    setPriority: (pid: number, value: number) => {
      priority.calls.push([pid, value])
      if (priority.fail) throw new Error('access denied')
      real.setPriority(pid, value)
    },
  }
})

// The real file calls, with a way to make the WAV header's rewrite fail (a full or vanished disk).
const fsHook = vi.hoisted(() => ({ failHeaderRewrite: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>
      Object.assign(handle, {
        write: (...a: unknown[]) =>
          fsHook.failHeaderRewrite && a[3] === 0 ? Promise.reject(new Error('EIO: i/o error, write')) : write(...a),
      })
      return handle
    },
  }
})

const native = await import('./nativeExport')

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-native-'))
})
afterEach(async () => {
  appPath = REPO
  await native.cancel()
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
})

describe('an ffmpeg that cannot start', () => {
  // ⛔ SEEN IN THE CODE, export audit 2026-10-06: the export's spawn had no 'error' listener, and an
  // EventEmitter 'error' nobody listens for is thrown. A missing or quarantined ffmpeg.exe put
  // "A JavaScript error occurred in the main process" over his editor, after start() had already
  // answered that it started.
  it('⛔ says so in words the dialog turns plain, takes the sound file with it, and throws nothing', async () => {
    const thrown: unknown[] = []
    const catchIt = (err: unknown): void => void thrown.push(err)
    process.on('uncaughtException', catchIt)
    try {
      // An app folder with no ffmpeg in it, as after an antivirus took the bundled one.
      appPath = userData
      await native.beginAudio(48000, 2)
      await native.audioChunk(new ArrayBuffer(64))
      await native.finishAudio()
      const wav = (await readdir(tmpdir())).filter((f) => f.startsWith(`olp-audio-${process.pid}-`))
      expect(wav.length).toBeGreaterThan(0)
      const win = { webContents: { send: () => undefined } } as unknown as Parameters<typeof native.start>[1]
      const res = await native.start(
        { width: 64, height: 64, fps: 30, totalFrames: 3, encoder: 'x264', quality: 18, hasAudio: true, outPath: join(userData, 'x.mp4'), suggestedName: 'x' },
        win,
      )
      // Long enough for any late 'error' or 'close' from the dead child to surface.
      await new Promise((r) => setTimeout(r, 300))
      expect(res.started).toBe(false)
      expect(res.error).toMatch(/^could not start ffmpeg/)
      expect(plainExportError(res.error ?? '').line).toBe('The video maker is missing or blocked. Reinstall OL Premiere.')
      expect(native.isExporting()).toBe(false)
      expect(thrown).toEqual([])
      // The mix it was handed is not left in his temp folder.
      const left = (await readdir(tmpdir())).filter((f) => wav.includes(f))
      expect(left).toEqual([])
    } finally {
      process.off('uncaughtException', catchIt)
    }
  })
})

describe('an ffmpeg that dies mid export says why', () => {
  it('⛔ gives the exit code and the last thing ffmpeg said, not just "exited"', async () => {
    const W = 640
    const H = 480
    // A folder that does not exist: ffmpeg takes the first frames, then fails
    // to open the file it was meant to write, exactly mid stream.
    const outPath = join(userData, 'no such folder', 'export.mp4')
    const win = { webContents: { send: () => undefined } } as unknown as Parameters<typeof native.start>[1]
    const started = await native.start(
      { width: W, height: H, fps: 30, totalFrames: 300, encoder: 'x264', quality: 18, hasAudio: false, outPath, suggestedName: 'x' },
      win,
    )
    expect(started.started).toBe(true)

    // A frame is 1.2 MB against a 64 KB pipe, so every write waits on ffmpeg,
    // which is where the death is noticed.
    const frame = new Uint8Array(W * H * 4).fill(128).buffer
    let error = ''
    for (let i = 0; i < 300 && !error; i++) {
      await native.writeFrame(frame.slice(0)).catch((err: Error) => (error = err.message))
    }
    expect(error).toMatch(/^ffmpeg exited during export/)
    // -2 is ENOENT; Windows reports it unsigned and he would have read 4294967294.
    expect(error).toContain('(exit code -2)')
    // ffmpeg's own words about the file it could not open.
    expect(error).toMatch(/No such file or directory|Error opening output/i)
  }, 60_000)

  it('reads a negative exit code the way ffmpeg meant it', () => {
    expect(native.exitCodeOf(4294967294)).toBe(-2)
    expect(native.exitCodeOf(1)).toBe(1)
    expect(native.exitCodeOf(null)).toBeNull()
  })

  it('keeps the tail to the last four lines, in the order ffmpeg wrote them', () => {
    expect(native.stderrTail('a\nb\n\nc\r\nd\ne\n')).toBe('b · c · d · e')
    expect(native.stderrTail('')).toBe('')
  })
})

describe('ffmpeg progress, read across chunks', () => {
  it('⛔ a line split between two chunks is read whole, not as a smaller number', () => {
    const frames: number[] = []
    const read = native.progressReader((f) => frames.push(f))
    read('fps=30.0\nframe=12')
    read('3\nfps=30.0\nfr')
    read('ame=130\r\nprogress=continue\n')
    expect(frames).toEqual([123, 130])
  })
})

describe('the export runs below normal priority, so the editor stays smooth', () => {
  const W = 64
  const H = 64
  const win = { webContents: { send: () => undefined } } as unknown as Parameters<typeof native.start>[1]
  const config = (outPath: string) =>
    ({ width: W, height: H, fps: 30, totalFrames: 3, encoder: 'x264', quality: 18, hasAudio: false, outPath, suggestedName: 'x' }) as const

  beforeEach(() => {
    priority.calls.length = 0
    priority.fail = false
  })

  it('⛔ lowers the real ffmpeg to below normal, and the file is still made', async () => {
    const started = await native.start(config(join(userData, 'low.mp4')), win)
    expect(started.started).toBe(true)
    expect(priority.calls).toHaveLength(1)
    const [pid, value] = priority.calls[0]
    expect(value).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    // Windows really says so for that process. (A test runner that is itself below normal passes
    // that on to its children, so the call above is the proof; this is the effect.)
    expect(os.getPriority(pid)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    for (let i = 0; i < 3; i++) await native.writeFrame(new Uint8Array(W * H * 4).fill(90).buffer)
    expect(await native.finish()).toMatchObject({ ok: true })
  }, 60_000)

  it('a machine that refuses the change still exports', async () => {
    priority.fail = true
    const started = await native.start(config(join(userData, 'refused.mp4')), win)
    expect(started.started).toBe(true)
    for (let i = 0; i < 3; i++) await native.writeFrame(new Uint8Array(W * H * 4).fill(90).buffer)
    expect(await native.finish()).toMatchObject({ ok: true })
  }, 60_000)
})

describe('⛔ a cancel while ffmpeg is finishing the file', () => {
  // finish() was already waiting on ffmpeg when cancel() killed it, and its continuation ran first,
  // so the page heard "ffmpeg exited with code null" before the cancel answered, and the export
  // ended as a failure. Had ffmpeg exited 0 in that instant, finish said ok and cancel then deleted
  // the file the "Done, show it" chip pointed at (export review S3, 2026-10-08).
  it('finish answers cancelled, never an exit code or ok, and leaves no file behind', async () => {
    const W = 320
    const H = 240
    const outPath = join(userData, 'finishing.mp4')
    const win = { webContents: { send: () => undefined } } as unknown as Parameters<typeof native.start>[1]
    const started = await native.start(
      { width: W, height: H, fps: 30, totalFrames: 30, encoder: 'x264', quality: 18, hasAudio: false, outPath, suggestedName: 'x' },
      win,
    )
    expect(started.started).toBe(true)
    for (let i = 0; i < 30; i++) await native.writeFrame(new Uint8Array(W * H * 4).fill(i * 8).buffer)
    const fin = native.finish()
    await native.cancel()
    expect(await fin).toEqual({ ok: false, cancelled: true })
    expect(native.isExporting()).toBe(false)
    await new Promise((r) => setTimeout(r, 200))
    expect(await readdir(userData)).not.toContain('finishing.mp4')
  }, 60_000)
})

describe('the sound, written a segment at a time', () => {
  const FFMPEG = join(REPO, 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')
  const ours = async (): Promise<string[]> =>
    (await readdir(tmpdir())).filter((f) => f.startsWith(`olp-audio-${process.pid}-`))

  it('⛔ is a WAV that ffmpeg reads back sample for sample, across every seam', async () => {
    // Three segments of different sizes, the way the limiter hands them on; every sample its own value.
    const sizes = [4800, 4799, 1]
    const left: number[] = []
    const right: number[] = []
    await native.beginAudio(48000, 2)
    let k = 0
    for (const n of sizes) {
      const seg = new Float32Array(n * 2)
      for (let f = 0; f < n; f++, k++) {
        const v = Math.fround(Math.sin(k * 0.01) * 0.9)
        seg[2 * f] = v
        seg[2 * f + 1] = -v / 2
        left.push(v)
        right.push(Math.fround(-v / 2))
      }
      await native.audioChunk(seg.buffer)
    }
    await native.finishAudio()
    const [name] = await ours()
    expect(name).toBeTruthy()
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', join(tmpdir(), name), '-f', 'f32le', '-'], {
      windowsHide: true,
      maxBuffer: 1 << 26,
    })
    expect(r.status, r.stderr?.toString()).toBe(0)
    const back = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4)
    expect(back.length).toBe(k * 2)
    for (let f = 0; f < k; f++) {
      if (back[2 * f] !== left[f] || back[2 * f + 1] !== right[f]) {
        expect([f, back[2 * f], back[2 * f + 1]]).toEqual([f, left[f], right[f]])
      }
    }
    // The cancel in afterEach takes it away, as it would an export that never started.
  })

  it('a cancel while it is being written leaves nothing in his temp folder', async () => {
    await native.beginAudio(48000, 2)
    await native.audioChunk(new Float32Array(960).buffer)
    expect(await ours()).toHaveLength(1)
    await native.cancel()
    await new Promise((r) => setTimeout(r, 100))
    expect(await ours()).toEqual([])
  })

  it('⛔ a header that cannot be rewritten takes the mix with it, handle closed', async () => {
    // finishAudio let go of the mix BEFORE rewriting the header and closing it, so when either
    // failed the file was in neither audioWrite nor pendingAudioPath and no cancel could find it: a
    // whole float mix left in his temp folder (export review N2, 2026-10-08).
    await native.beginAudio(48000, 2)
    await native.audioChunk(new Float32Array(960).buffer)
    fsHook.failHeaderRewrite = true
    try {
      await expect(native.finishAudio()).rejects.toThrow('EIO')
    } finally {
      fsHook.failHeaderRewrite = false
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(await ours()).toEqual([])
  })

  it('⛔ quitting while ffmpeg is starting stops it and takes the mix and the file with it', async () => {
    // start() waits for ffmpeg's spawn before it sets the job, and the mix was then only in a local:
    // a quit in that tick found no job, so it neither stopped the new ffmpeg nor deleted the mix
    // (export review N2, 2026-10-08).
    await native.beginAudio(48000, 2)
    await native.audioChunk(new Float32Array(960).buffer)
    await native.finishAudio()
    expect(await ours()).toHaveLength(1)
    const win = { webContents: { send: () => undefined } } as unknown as Parameters<typeof native.start>[1]
    const outPath = join(userData, 'quit.mp4')
    const starting = native.start(
      { width: 64, height: 64, fps: 30, totalFrames: 3, encoder: 'x264', quality: 18, hasAudio: true, outPath, suggestedName: 'x' },
      win,
    )
    // The app's before-quit, in the same tick.
    native.cancelSync()
    expect(await starting).toMatchObject({ started: false, cancelled: true })
    expect(native.isExporting()).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(await ours()).toEqual([])
    expect(await readdir(userData)).not.toContain('quit.mp4')
  }, 30_000)
})
