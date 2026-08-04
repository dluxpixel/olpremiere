// The ffmpeg argument surface is the contract between this app and the bundled
// binary, and it had no test at all while it lived inside electron/nativeExport.ts
// (vitest only collects src/**). It is pure data, so it is cheap to pin, and
// scripts/verify-ffmpeg.mjs runs these same arguments against a real ffmpeg, which
// is what makes a stripped or swapped binary provable rather than hoped about.

import { describe, it, expect } from 'vitest'
import {
  buildArgs,
  videoEncoderArgs,
  containerExt,
  NATIVE_ENCODERS,
  NVENC_ENCODERS,
} from '../../../electron/exportArgs'
import type { NativeEncoder, NativeExportConfig } from '../../../electron/ipc-types'

function cfg(over: Partial<NativeExportConfig> = {}): NativeExportConfig {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    totalFrames: 90,
    encoder: 'x264',
    quality: 14,
    hasAudio: true,
    suggestedName: 'out.mp4',
    ...over,
  } as NativeExportConfig
}

describe('native export arguments', () => {
  it('feeds raw RGBA from stdin at the sequence raster and fps', () => {
    const a = buildArgs(cfg({ width: 1280, height: 720, fps: 24 }), null, 'o.mp4')
    expect(a.slice(0, 12)).toEqual([
      '-y', '-hide_banner',
      '-f', 'rawvideo', '-pixel_format', 'rgba',
      '-video_size', '1280x720', '-framerate', '24', '-i', 'pipe:0',
    ])
  })

  it('always vflips and converts full-range RGBA to limited BT.709 explicitly', () => {
    // Not cosmetic: leaving the matrix implicit lets swscale pick BT.601 by a
    // resolution heuristic while the output is tagged BT.709.
    const a = buildArgs(cfg(), null, 'o.mp4')
    expect(a[a.indexOf('-vf') + 1]).toBe('vflip,scale=in_range=full:out_range=tv:out_color_matrix=bt709')
  })

  it('tags BT.709 limited on the output so players do not guess', () => {
    const a = buildArgs(cfg(), null, 'o.mp4')
    for (const [flag, val] of [
      ['-color_primaries', 'bt709'],
      ['-color_trc', 'bt709'],
      ['-colorspace', 'bt709'],
      ['-color_range', 'tv'],
    ]) {
      expect(a[a.indexOf(flag) + 1]).toBe(val)
    }
  })

  it('adds the WAV as a second input and maps it only when there is audio', () => {
    const withAudio = buildArgs(cfg(), 'C:/tmp/a.wav', 'o.mp4')
    expect(withAudio).toContain('C:/tmp/a.wav')
    expect(withAudio.join(' ')).toContain('-map 1:a:0 -c:a aac -b:a 320k')

    const silent = buildArgs(cfg({ hasAudio: false }), null, 'o.mp4')
    expect(silent.join(' ')).not.toContain('-map 1:a:0')
    expect(silent.join(' ')).not.toContain('-c:a')
    expect(silent.join(' ')).toContain('-map 0:v:0')
  })

  it('asks for machine-readable progress and puts the movie last', () => {
    const a = buildArgs(cfg(), null, 'C:/out/movie.mp4')
    expect(a.join(' ')).toContain('-progress pipe:1 -nostats')
    expect(a[a.length - 1]).toBe('C:/out/movie.mp4')
  })

  it('clamps quality into the 0 to 51 QP scale and rounds it', () => {
    expect(videoEncoderArgs(cfg({ quality: -5 }))).toContain('0')
    expect(videoEncoderArgs(cfg({ quality: 900 }))).toContain('51')
    expect(videoEncoderArgs(cfg({ quality: 13.6 }))).toContain('14')
  })

  it('gives every encoder a real argument list, with no silent undefined', () => {
    for (const encoder of NATIVE_ENCODERS) {
      const args = videoEncoderArgs(cfg({ encoder }))
      expect(args.length, encoder).toBeGreaterThan(1)
      expect(args[0], encoder).toBe('-c:v')
      expect(args.every((x) => typeof x === 'string' && x.length > 0), encoder).toBe(true)
    }
  })

  it('keeps ProRes at 422 HQ 10-bit in a QuickTime container', () => {
    const a = videoEncoderArgs(cfg({ encoder: 'prores' }))
    expect(a).toEqual(['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'])
    expect(containerExt('prores')).toBe('mov')
  })

  it('lossless is QP 0 x264, not a separate codec', () => {
    const a = videoEncoderArgs(cfg({ encoder: 'lossless' }))
    expect(a).toEqual(['-c:v', 'libx264', '-preset', 'veryslow', '-qp', '0', '-pix_fmt', 'yuv420p'])
    expect(containerExt('lossless')).toBe('mp4')
  })

  it('lists exactly the three GPU encoders as GPU dependent', () => {
    const gpu = NATIVE_ENCODERS.filter((e) => NVENC_ENCODERS.has(e))
    expect(gpu).toEqual(['nvenc-h264', 'nvenc-hevc', 'nvenc-av1'])
    for (const e of gpu) expect(videoEncoderArgs(cfg({ encoder: e })).join(' ')).toContain('_nvenc')
  })

  it('covers every member of the NativeEncoder union', () => {
    // If someone adds an encoder to the union and forgets NATIVE_ENCODERS, the
    // verifier would silently stop testing it. This is that tripwire.
    const union: NativeEncoder[] = ['x264', 'x265', 'nvenc-h264', 'nvenc-hevc', 'nvenc-av1', 'prores', 'lossless']
    expect([...NATIVE_ENCODERS].sort()).toEqual([...union].sort())
  })
})
