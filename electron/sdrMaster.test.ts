// An HDR phone clip through the REAL bundled ffmpeg: what comes out is the
// master everything downstream will ever see, so it is checked as a file, not
// as a list of arguments.
//
// ⛔ HIS WORDS, 2026-09-29: "make sure, because I input a lot of videos from my
// iPhone, that the iPhone videos are fucking perfect, especially with the
// export." His clips are HEVC 10 bit HLG, recorded turned on their side (a -90
// display matrix), with the phone's real, slightly uneven frame times. Each
// source below is made to have all three, so the master is held to all three.
//
// Slower than the rest of the suite on purpose: every test spawns a real
// encoder, the same as proxyTranscode.test.ts.

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertToMp4, resetMasterChoice } from './remuxRun'

const FFMPEG = join(import.meta.dirname, '..', 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'olp-sdr-'))
  resetMasterChoice()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function ff(args: string[]): string {
  const r = spawnSync(FFMPEG, ['-hide_banner', ...args], { encoding: 'utf8', windowsHide: true })
  return (r.stderr ?? '') + (r.stdout ?? '')
}

/**
 * One second of 10 bit HLG HEVC, 320x240 coded and turned -90 like his phone's
 * files, with two frames a tick off the 30 fps grid (his clips have 4 and 9 of
 * those), and AAC sound.
 */
async function hlgClip(name: string): Promise<string> {
  const flat = join(dir, 'flat-' + name)
  const out = join(dir, name)
  ff([
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1,settb=1/600,setpts=N*20+eq(N\\,7)-eq(N\\,19)',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-fps_mode', 'passthrough', '-enc_time_base', '1/600', '-video_track_timescale', '600',
    '-c:v', 'libx265', '-x265-params', 'log-level=error:keyint=15:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
    '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-c:a', 'aac', flat,
  ])
  ff(['-loglevel', 'error', '-y', '-display_rotation:v:0', '-90', '-i', flat, '-c', 'copy', out])
  return out
}

/** Every video frame's presentation time in seconds, in order. */
function frameTimes(path: string): number[] {
  const crc = ff(['-loglevel', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'])
  const [num, den] = (/#tb 0: (\d+)\/(\d+)/.exec(crc) ?? ['', '1', '1']).slice(1).map(Number)
  return [...crc.matchAll(/^0,\s*-?\d+,\s*(-?\d+),/gm)].map((m) => (Number(m[1]) * num) / den).sort((a, b) => a - b)
}

/** Wipe a run of bytes in the middle of the picture data: a clip with a hole in it. */
async function damaged(src: string, name: string): Promise<string> {
  const bytes = await readFile(src)
  const mdat = bytes.indexOf('mdat')
  const mid = mdat + Math.floor((bytes.length - mdat) / 2)
  bytes.fill(0, mid, mid + 3000)
  const out = join(dir, name)
  await writeFile(out, bytes)
  return out
}

describe('an HDR phone clip becomes one SDR master', () => {
  it('comes out SDR, upright, with every frame at its own time and the sound still there', async () => {
    const src = await hlgClip('IMG_5001.MOV')
    // The source really is what his phone makes, or this proves nothing.
    expect(ff(['-i', src])).toMatch(/yuv420p10le\(tv, bt2020nc\/bt2020\/arib-std-b67/)
    expect(ff(['-i', src])).toMatch(/rotation of -90/)

    const out = join(dir, 'master.mp4')
    const seen: number[] = []
    const res = await convertToMp4(FFMPEG, src, out, 'sdr', (f) => seen.push(f))
    expect(res.copied).toBe(false)

    const report = ff(['-i', out])
    // Ordinary SDR H.264, said in the file: nothing downstream has to tone map.
    expect(report).toMatch(/Video: h264 .*yuv420p\(tv, bt709/)
    expect(report).not.toMatch(/arib-std-b67|bt2020/)
    // Turned upright ONCE, here, so no matrix is left for anything to honour.
    expect(report).toMatch(/240x320/)
    expect(report).not.toMatch(/rotation/)
    expect(report).toMatch(/Audio: aac/)

    // ⛔ THE PHONE'S OWN FRAME TIMES, TO THE TICK. Without the demuxer's time
    // base, passthrough still rounded every one onto the 1/30 grid.
    const before = frameTimes(src)
    const after = frameTimes(out)
    expect(after).toHaveLength(30)
    for (const [i, t] of before.entries()) expect(after[i]).toBeCloseTo(t, 6)

    // He sees it move, and it ends at the end.
    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBeLessThanOrEqual(1)
  }, 60_000)

  it('a rescued HDR clip gets the same master, not 8 bits still tagged HLG', async () => {
    // ⛔ THE OLD RESCUE: libx264 straight off the 10 bit picture, no tone map,
    // HLG tags kept and the Dolby Vision gone, for Chromium to guess at again.
    const src = await hlgClip('IMG_5002.MOV')
    const out = join(dir, 'rescued.mp4')
    await convertToMp4(FFMPEG, src, out, 'rescue')
    const report = ff(['-i', out])
    expect(report).toMatch(/yuv420p\(tv, bt709/)
    expect(report).not.toMatch(/arib-std-b67/)
  }, 60_000)

  it('a master that cannot read every frame is refused, never imported with a hole in it', async () => {
    const src = await damaged(await hlgClip('whole.MOV'), 'IMG_5003.MOV')
    await expect(convertToMp4(FFMPEG, src, join(dir, 'master.mp4'), 'sdr')).rejects.toThrow()
  }, 60_000)
})

describe('a rescue is held to the frames it was given', () => {
  it('⛔ refuses a converted file with frames missing, which it used to import in silence', async () => {
    // Seen 2026-09-29 in the real app: the rescued iPhone clip had 389 of 405
    // frames, a half second hole at 7.08 s, and the import said "Imported".
    // Reproduced here: the old command turned this damaged clip into 42 of its
    // 60 frames and exited 0. Now the decode error stops it (-xerror), and
    // `framesLost` would catch a shortfall that slipped past that.
    const flat = join(dir, 'sdr.mov')
    ff([
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
      '-c:v', 'libx265', '-x265-params', 'log-level=error:keyint=15', '-pix_fmt', 'yuv420p', flat,
    ])
    const src = await damaged(flat, 'IMG_5004.MOV')
    await expect(convertToMp4(FFMPEG, src, join(dir, 'rescued.mp4'), 'rescue')).rejects.toThrow()
  }, 60_000)

  it('still converts a healthy clip with every frame', async () => {
    const flat = join(dir, 'ok.mov')
    ff([
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
      '-c:v', 'libx265', '-x265-params', 'log-level=error:keyint=15', '-pix_fmt', 'yuv420p', flat,
    ])
    const out = join(dir, 'rescued.mp4')
    await convertToMp4(FFMPEG, flat, out, 'rescue')
    expect(frameTimes(out)).toHaveLength(60)
  }, 60_000)
})
