// The half of a preview copy that a mock cannot prove: a REAL transcode through
// the bundled ffmpeg, and a real read back.
//
// ⛔ WHY THIS EXISTS. His store held zero preview copies from July to
// 2026-08-22, and every test around this path pressed on policy or on the shape
// of the IPC calls. Nothing ever ran the chain. So the one thing that was
// actually broken, the copy arriving, was the one thing nothing looked at.
//
// It IS slower than the rest of the suite, deliberately. One second of 640x480
// is about two seconds of wall clock including the encoder ladder, which is
// nothing against a month of him scrubbing the full size original. Kept in its
// own file so a future session can see at a glance which test spawns an encoder.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REPO = join(import.meta.dirname, '..')
const FFMPEG = join(REPO, 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')

let userData = ''
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'OL Premiere',
    // The real repo, so `ffmpegPath()` resolves the bundled binary exactly the
    // way the dev shell does.
    getAppPath: () => join(import.meta.dirname, '..'),
    getPath: (k: string) => (k === 'userData' ? userData : `C:/${k}`),
  },
}))

const { beginProxy, chunkProxy, finishProxy, readProxy, releaseProxy } = await import('./proxy')

/** Frames between keyframes the proxy is built for. Mirrors PROXY_GOP. */
const GOP = 12

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'olp-transcode-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
})

/** Keyframes in a file, counted by decoding only the keyframes. */
function keyframeCount(path: string): number {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-skip_frame', 'nokey', '-i', path, '-an', '-f', 'null', '-'], {
    encoding: 'utf8',
  })
  const frames = [...(r.stderr ?? '').matchAll(/frame=\s*(\d+)/g)]
  return frames.length > 0 ? Number(frames[frames.length - 1][1]) : 0
}

describe('a preview copy actually gets made and comes back whole', () => {
  it('transcodes a real source and returns it byte for byte, with a short GOP', async () => {
    // A source with no fixture file behind it, so this proves the encoder is
    // there as well as that the chain works.
    const src = join(userData, 'source.mp4')
    const made = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      src,
    ])
    expect(made.status, `could not make a source: ${made.stderr}`).toBe(0)
    const sourceBytes = await readFile(src)

    const id = await beginProxy()
    try {
      // Two chunks, so the append path is exercised rather than one big write.
      const half = Math.ceil(sourceBytes.length / 2)
      await chunkProxy(id, sourceBytes.subarray(0, half).buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + half) as ArrayBuffer)
      await chunkProxy(id, Uint8Array.from(sourceBytes.subarray(half)).buffer)

      const { size } = await finishProxy(id)
      expect(size).toBeGreaterThan(0)

      // ⛔ READ IT BACK THE WAY THE RENDERER DOES: slices, never one buffer. The
      // last one is short.
      const SLICE = 8 * 1024
      const parts: Buffer[] = []
      for (let off = 0; off < size; off += SLICE) {
        parts.push(Buffer.from(await readProxy(id, off, Math.min(SLICE, size - off))))
      }
      const copy = Buffer.concat(parts)
      expect(copy.length).toBe(size)

      // The reassembled bytes are the file on disk, not merely the right length.
      const onDisk = await readFile(join(userData, 'proxies', `out-${id}.mp4`))
      expect(copy.equals(onDisk)).toBe(true)

      // And it is a real, seekable video: one second at 30 fps with a keyframe
      // every twelve frames is three, which is the whole reason a copy exists.
      const out = join(userData, 'copy.mp4')
      await writeFile(out, copy)
      expect(keyframeCount(out)).toBeGreaterThanOrEqual(Math.floor(30 / GOP))
      // The source it came from has far fewer, which is the gap being closed.
      expect(keyframeCount(out)).toBeGreaterThan(keyframeCount(src))
    } finally {
      await releaseProxy(id)
    }

    // Nothing of his is left behind: the source temp is full size.
    expect(await readdir(join(userData, 'proxies'))).toEqual([])
  }, 60_000)
})
