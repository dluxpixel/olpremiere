// The ffmpeg argument surface for native export, kept PURE and free of any
// electron import so three callers can share one copy: the main process, the
// vitest suite, and scripts/verify-ffmpeg.mjs (which type-strips this file at
// run time). That last one is the point. The verifier proves a candidate
// ffmpeg build against the arguments the app REALLY sends, so a stripped or
// swapped binary cannot pass a test that drifted from the shipping code.

import type { NativeEncoder, NativeExportConfig } from './ipc-types'

/** Every encoder the app can ask for. The verifier walks exactly this list. */
export const NATIVE_ENCODERS: NativeEncoder[] = [
  'x264',
  'x265',
  'nvenc-h264',
  'nvenc-hevc',
  'nvenc-av1',
  'prores',
  'lossless',
]

/** The ones that need an NVIDIA GPU present, not just a build that carries them. */
export const NVENC_ENCODERS: ReadonlySet<NativeEncoder> = new Set<NativeEncoder>([
  'nvenc-h264',
  'nvenc-hevc',
  'nvenc-av1',
])

/** ProRes is QuickTime, everything else is MP4. Drives the save dialog too. */
export function containerExt(encoder: NativeEncoder): 'mov' | 'mp4' {
  return encoder === 'prores' ? 'mov' : 'mp4'
}

export function videoEncoderArgs(config: NativeExportConfig): string[] {
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
      // ProRes 422 HQ, 10-bit 4:2:2, an intermediate/master format.
      return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
    case 'lossless':
      // Visually lossless H.264 (QP 0). Plays everywhere; huge files.
      return ['-c:v', 'libx264', '-preset', 'veryslow', '-qp', '0', '-pix_fmt', 'yuv420p']
  }
}

export function buildArgs(config: NativeExportConfig, audioPath: string | null, outPath: string): string[] {
  const args = [
    '-y',
    '-hide_banner',
    // Raw RGBA video from stdin.
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${config.width}x${config.height}`, '-framerate', String(config.fps), '-i', 'pipe:0',
  ]
  if (audioPath) args.push('-i', audioPath)
  // GL frames are bottom-origin (vflip). Convert the full-range RGBA readback to
  // limited-range BT.709 YUV EXPLICITLY rather than letting swscale pick the
  // RGB to YUV matrix by a resolution heuristic, which could convert with BT.601
  // while we tag BT.709. (Verified pixel-identical to the implicit path on the
  // bundled ffmpeg, so this is version/raster-drift hardening, not a visible
  // change; the export corruption reported separately is NOT this.)
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
