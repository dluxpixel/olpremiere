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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    // The real repo, so the bundled ffmpeg is found the way the dev shell finds it.
    getAppPath: () => join(import.meta.dirname, '..'),
    getPath: (k: string) => (k === 'userData' ? userData : join(userData, k)),
  },
  dialog: {},
}))

const native = await import('./nativeExport')

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-native-'))
})
afterEach(async () => {
  await native.cancel()
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
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
