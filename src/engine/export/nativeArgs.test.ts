// The ffmpeg argument surface is the contract between this app and the bundled
// binary, and it had no test at all while it lived inside electron/nativeExport.ts
// (vitest only collects src/**). It is pure data, so it is cheap to pin, and
// scripts/verify-ffmpeg.mjs runs these same arguments against a real ffmpeg, which
// is what makes a stripped or swapped binary provable rather than hoped about.

import { describe, it, expect } from 'vitest'
import {
  VIDEO_FILTER,
  buildArgs,
  videoEncoderArgs,
  keyframeArgs,
  keyframeStride as nativeStride,
  containerExt,
  NATIVE_ENCODERS,
  NVENC_ENCODERS,
} from '../../../electron/exportArgs'
import type { NativeEncoder, NativeExportConfig } from '../../../electron/ipc-types'
import { EXPORT_KEYFRAME_S } from './exportPlan'
import { keyframeStride as webStride } from './messages'

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
    expect(a[a.indexOf('-vf') + 1]).toBe(VIDEO_FILTER)
    expect(VIDEO_FILTER.startsWith('vflip,scale=')).toBe(true)
    for (const opt of ['in_range=full', 'out_range=tv', 'out_color_matrix=bt709']) {
      expect(VIDEO_FILTER, opt).toContain(opt)
    }
  })

  it('carries the primaries and the transfer on the FILTER, not just the output flags', () => {
    // Measured on the bundled ffmpeg: with only -color_primaries/-color_trc, the
    // H.264 VUI came out primaries=2 transfer=2 (both UNSPECIFIED) and the MP4
    // had no colr box. ffmpeg takes those two from the filtered frame, and a
    // rawvideo input carries none. Stating them on the filter is what lands
    // VUI 1/1/1 plus colr nclx bt709/bt709/bt709 limited. This is the tripwire.
    expect(VIDEO_FILTER).toContain('out_primaries=bt709')
    expect(VIDEO_FILTER).toContain('out_transfer=bt709')
  })

  it('sites the chroma where the bitstream says it is, which is left', () => {
    // swscale defaults to CENTRE siting here, but chroma_loc_info_present_flag=0
    // (what x264 writes, and what it still writes with this option) means type 0,
    // which is LEFT. Downsampled one way and declared the other put a half-sample
    // horizontal error on every saturated caption edge. Asking for left adds no
    // syntax element to the stream, because left is the H.264 default.
    expect(VIDEO_FILTER).toContain('out_chroma_loc=left')
    // Never centre or topleft: both force chroma_loc_info_present_flag to 1.
    expect(VIDEO_FILTER).not.toContain('out_chroma_loc=center')
    expect(VIDEO_FILTER).not.toContain('out_chroma_loc=topleft')
  })

  it('keeps the existing resampler and only asks it to round honestly', () => {
    // bicubic restates the current default (measured byte-identical to omitting
    // flags), so naming it here cannot move the resampler. accurate_rnd is the
    // only behaviour change, and the encoder is veryslow so it costs nothing.
    expect(VIDEO_FILTER).toContain('flags=bicubic+accurate_rnd')
  })

  it('stays 4:2:0, because 4:2:2 trades phone playback for a gain uploads discard', () => {
    for (const e of NATIVE_ENCODERS.filter((x) => x !== 'prores')) {
      expect(videoEncoderArgs(cfg({ encoder: e })).join(' '), e).toContain('-pix_fmt yuv420p')
    }
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

  it('caps the gap between keyframes, in frames, at the real fps', () => {
    // Without -g, libx264 runs its own 250 frame default, which at 30 fps is one
    // keyframe every 8.3 seconds. Densely cut material is the worst case for it.
    // -g is a maximum and a scene cut re-anchors the count, which is why this
    // pins the ARGUMENT: where x264 then puts them is x264's business.
    const a = buildArgs(cfg({ fps: 30, keyframeIntervalS: EXPORT_KEYFRAME_S }), null, 'o.mp4')
    expect(a[a.indexOf('-g') + 1]).toBe('60')
    const b = buildArgs(cfg({ fps: 23.976, keyframeIntervalS: EXPORT_KEYFRAME_S }), null, 'o.mp4')
    expect(b[b.indexOf('-g') + 1]).toBe('48')
  })

  it('strides exactly as the WebCodecs path does, so the two pipelines agree', () => {
    // exportArgs.ts cannot import messages.ts (verify-ffmpeg.mjs type-strips it
    // alone), so the formula is restated there. This is the tripwire on that.
    for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
      const web = webStride(fps, EXPORT_KEYFRAME_S)
      expect(nativeStride(fps, EXPORT_KEYFRAME_S), String(fps)).toBe(web)
      const a = buildArgs(cfg({ fps, keyframeIntervalS: EXPORT_KEYFRAME_S }), null, 'o.mp4')
      expect(a[a.indexOf('-g') + 1], String(fps)).toBe(String(web))
    }
  })

  it('falls back to the same two seconds the plan asks for when none is carried', () => {
    expect(EXPORT_KEYFRAME_S).toBe(2)
    const a = buildArgs(cfg({ fps: 30 }), null, 'o.mp4')
    expect(a[a.indexOf('-g') + 1]).toBe('60')
  })

  it('never asks ProRes for a GOP, because every frame of it is already a key', () => {
    expect(keyframeArgs(cfg({ encoder: 'prores' }))).toEqual([])
    expect(buildArgs(cfg({ encoder: 'prores' }), null, 'o.mov')).not.toContain('-g')
    // Every inter-frame encoder does get one.
    for (const e of NATIVE_ENCODERS.filter((x) => x !== 'prores')) {
      expect(buildArgs(cfg({ encoder: e }), null, 'o.mp4'), e).toContain('-g')
    }
  })

  it('writes the index at the front, so the file plays before it has all arrived', () => {
    const a = buildArgs(cfg(), null, 'o.mp4')
    expect(a[a.indexOf('-movflags') + 1]).toBe('+faststart')
    // The second pass rewrites the OUTPUT, so it needs that output seekable.
    // Only the input is a pipe, and it is positioned before this flag.
    expect(a.indexOf('-movflags')).toBeGreaterThan(a.indexOf('pipe:0'))
    expect(a.indexOf('-movflags')).toBeLessThan(a.length - 1)
  })

  it('pins the whole shipping argument list: x264 with sound, which is his path', () => {
    expect(buildArgs(cfg({ keyframeIntervalS: EXPORT_KEYFRAME_S }), 'C:/tmp/a.wav', 'C:/out/movie.mp4')).toEqual([
      '-y', '-hide_banner',
      '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '1920x1080', '-framerate', '30', '-i', 'pipe:0',
      '-i', 'C:/tmp/a.wav',
      '-vf',
      'vflip,scale=in_range=full:out_range=tv:out_color_matrix=bt709' +
        ':out_primaries=bt709:out_transfer=bt709:out_chroma_loc=left:flags=bicubic+accurate_rnd',
      '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '14', '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-map', '0:v:0',
      '-map', '1:a:0', '-c:a', 'aac', '-b:a', '320k',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      'C:/out/movie.mp4',
    ])
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
