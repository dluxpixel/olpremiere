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

/**
 * H.264 level 4.2 for every raster and rate it covers, nothing for the rest.
 *
 * Left to itself x264 veryslow keeps 16 reference frames and then declares
 * whatever level that needs: every export of his measured 2026-09-30 said level
 * 5.1 with a 16 frame decoded picture buffer, for a plain 1080p file. 4.2 is
 * the level 1080p60 is delivered at, and a decoder built for it does not have
 * to accept a 16 frame buffer at this size. Pinning 4.2 makes x264 cap the
 * references to fit (4 at 1080x1920) and say so. MEASURED on the app's exact
 * frames of his footage: 51.81 dB against 51.79 unpinned, 44.69 against 44.65
 * after a platform-style re-encode, and 1.8% more bytes. Nothing to see, and a
 * file every 1080p decoder must take.
 *
 * The bitrate side of the level: 4.2 allows 62.5 Mbit/s at High profile. His
 * busiest real Short (mc night, crf 14) peaks at 46.5 Mbit/s over any second
 * and 51.8 over any half second, so it fits. No VBV cap is set on purpose: a
 * cap would only ever bite on the rare scene above it, and there it would take
 * picture away.
 *
 * Applies only where 4.2 can hold the frame: at most 8704 macroblocks a frame
 * and 522240 a second (1920x1080 and 1080x1920 up to 60 fps). Anything larger
 * or faster keeps x264's own choice, which is the only correct one there.
 */
export function x264LevelArgs(width: number, height: number, fps: number): string[] {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  return mbs <= 8704 && mbs * fps <= 522240 ? ['-level:v', '4.2'] : []
}

export function videoEncoderArgs(config: NativeExportConfig): string[] {
  const q = Math.max(0, Math.min(51, Math.round(config.quality)))
  switch (config.encoder) {
    case 'x264':
      return [
        '-c:v', 'libx264', '-preset', 'veryslow', '-crf', String(q),
        ...x264LevelArgs(config.width, config.height, config.fps),
        '-pix_fmt', 'yuv420p',
      ]
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
      // No level pin (see x264LevelArgs): QP 0 runs far above 4.2's bitrate.
      return ['-c:v', 'libx264', '-preset', 'veryslow', '-qp', '0', '-pix_fmt', 'yuv420p']
  }
}

/**
 * How the sound is written.
 *
 * ProRes is not a delivery format, it is a MASTER: something to take into
 * another tool, grade, and export again. Writing lossy AAC into it threw away
 * audio that every later step then had to work from, and no amount of bitrate
 * makes a re-encode of a re-encode honest. QuickTime carries PCM natively, so a
 * ProRes master now keeps the samples the mix actually produced.
 *
 * Everything else is a delivery file going to YouTube or a phone, where AAC is
 * exactly right and 320k is transparent for a stereo voice mix.
 */
export function audioEncoderArgs(config: NativeExportConfig): string[] {
  if (config.encoder === 'prores') return ['-c:a', 'pcm_s16le']
  return ['-c:a', 'aac', '-b:a', '320k']
}

/**
 * Frames between keyframes.
 *
 * The same formula as keyframeStride() in src/engine/export/messages.ts, which
 * is what the WebCodecs path uses, including its 2 second fallback. It is
 * restated instead of imported because this file has to stay importable by
 * scripts/verify-ffmpeg.mjs, which type-strips THIS file alone and resolves no
 * further .ts modules. nativeArgs.test.ts pins the two against the plan's own
 * EXPORT_KEYFRAME_S, so the restatement cannot drift in silence.
 */
export function keyframeStride(fps: number, keyframeIntervalS: number | undefined): number {
  return Math.max(1, Math.round(fps * (keyframeIntervalS ?? 2)))
}

/**
 * A keyframe at least every EXPORT_KEYFRAME_S seconds.
 *
 * Without -g, libx264 runs its own default of 250 frames, which at 30 fps is one
 * keyframe every 8.3 seconds. Densely cut material is the worst case for that: a
 * hard cut landing mid-GOP has to be described as residuals against a reference
 * frame that no longer resembles it, so the frames right after the cut go soft.
 * Two seconds is also the GOP length every upload platform expects, and it is
 * what the WebCodecs path already strides by.
 *
 * -g is a MAXIMUM, not an absolute grid: x264 counts from the last IDR, so a
 * scene cut re-anchors the count rather than being snapped to a multiple. That
 * is the behaviour wanted here anyway, since a keyframe ON the cut is the
 * cheapest place to spend one.
 *
 * Scene cuts are deliberately NOT configured. ffmpeg's -sc_threshold defaults to
 * -1, which means "leave x264's own scenecut alone", and x264's default of 40 is
 * already on. Measured on the bundled binary, 150 frames at 30 fps with a hard
 * cut at frame 43: WITHOUT -g the keyframes land at 0 and 43 (so the cut already
 * gets one, unasked), WITH -g 60 they land at 0, 43 and 103. Passing an explicit
 * scenecut value would restate a default, and cost the file 3.4% in size here
 * for nothing.
 *
 * ProRes is all-intra, so every frame is already a keyframe and a GOP size means
 * nothing to it.
 */
export function keyframeArgs(config: NativeExportConfig): string[] {
  if (config.encoder === 'prores') return []
  return ['-g', String(keyframeStride(config.fps, config.keyframeIntervalS))]
}

/**
 * The one video filter chain, and the only place the pixels change shape.
 *
 * GL frames are bottom-origin, hence vflip. Everything after it is the RGB to
 * YUV conversion, stated in full because every part of it was measured against
 * the bundled binary (N-125705) and every part of it was wrong by omission.
 *
 * out_color_matrix=bt709
 *   Pin the matrix rather than letting swscale pick it by a resolution
 *   heuristic, which could convert with BT.601 under a BT.709 tag.
 *
 * out_primaries=bt709, out_transfer=bt709
 *   These are NOT redundant with the -color_primaries / -color_trc output flags
 *   below. MEASURED: with only those flags, the H.264 VUI came out
 *   colour_primaries=2 and transfer_characteristics=2, both UNSPECIFIED, and the
 *   MP4 carried NO colr box at all. Only the matrix and the range survived,
 *   because ffmpeg configures the filter chain from those two and then takes
 *   primaries and transfer from the filtered FRAME, which inherits them from a
 *   rawvideo input that has none. Setting them on the filter is what actually
 *   lands them: VUI 1/1/1 plus a colr nclx box saying bt709/bt709/bt709 limited.
 *   The washed-out fix the tag was added for was only ever half applied.
 *
 * out_chroma_loc=left
 *   Where the chroma samples SIT. MEASURED: swscale defaults to centre siting
 *   here (out_chroma_loc=center is byte-identical to omitting it), while the
 *   H.264 stream declares LEFT by omission, since chroma_loc_info_present_flag=0
 *   means type 0, which is left. So the file was downsampled one way and
 *   declared the other, and the half-sample horizontal error lands on exactly
 *   the saturated caption edges this app exists to make. Asking for left costs
 *   nothing in the bitstream: left IS the H.264 default, so x264 still writes
 *   chroma_loc_info_present_flag=0 and no new syntax element appears (center
 *   and topleft, checked for contrast, DO force the flag to 1). Measured on a
 *   caption-like frame, rescaled the way an upload platform rescales it, this
 *   is worth about 0.60 dB.
 *
 * flags=lanczos+accurate_rnd+full_chroma_inp
 *   accurate_rnd only drops the cheap approximate rounding in the conversion
 *   itself, worth 0.17 dB on the measurement above, and the encoder here is
 *   veryslow so the time is free. The resampler only ever touches CHROMA here
 *   (the picture is never resized, so luma is not resampled at all), and it
 *   was bicubic until 2026-10-01. full_chroma_inp makes swscale read every
 *   pixel's colour instead of averaging pairs first, and lanczos then halves
 *   it. MEASURED on the app's exact frames of his footage against the source's
 *   own chroma: U/V 46.45/46.28 dB with bicubic, 46.80/46.68 with this, luma
 *   unchanged at 60.17. And on his captions, the place a sharper chroma filter
 *   could ring, decoded back the way a phone decodes (BT.709, bilinear
 *   chroma): his green Luckiest Guy with black outline went 34.72 to 35.75 dB
 *   with 13% fewer values haloed beyond their own neighbourhood, the pink
 *   Monocraft SUBSCRIBE 34.73 to 35.51 dB with half the halo, a white
 *   Montserrat word 46.02 to 46.89, and his white TikTok Sans over the gym
 *   footage 48.42 to 48.96 with 23% less halo. Less ringing, not more, on
 *   every caption style he uses.
 *
 * Deliberately NOT done: 4:2:2. H.264 High 4:2:2 is real but phone hardware
 * decoders commonly refuse it, and upload platforms re-encode to 4:2:0 anyway,
 * so the gain is discarded and only the compatibility risk is kept.
 */
export const VIDEO_FILTER =
  'vflip,scale=in_range=full:out_range=tv:out_color_matrix=bt709' +
  ':out_primaries=bt709:out_transfer=bt709:out_chroma_loc=left:flags=lanczos+accurate_rnd+full_chroma_inp'

export function buildArgs(config: NativeExportConfig, audioPath: string | null, outPath: string): string[] {
  const args = [
    '-y',
    '-hide_banner',
    // Raw RGBA video from stdin.
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${config.width}x${config.height}`, '-framerate', String(config.fps), '-i', 'pipe:0',
  ]
  if (audioPath) args.push('-i', audioPath)
  args.push('-vf', VIDEO_FILTER)
  args.push(...videoEncoderArgs(config))
  args.push(...keyframeArgs(config))
  args.push('-map', '0:v:0')
  if (audioPath) args.push('-map', '1:a:0', ...audioEncoderArgs(config))
  // Tag BT.709 limited range so players/YouTube don't guess (the washed-out fix).
  // Kept, but see VIDEO_FILTER: of these four, only -colorspace and -color_range
  // reach the file on their own. The primaries and the transfer are carried by
  // the filter, and without it they were silently dropped.
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv')
  // Put the index (the moov atom) at the FRONT. Both containers we write, MP4
  // and QuickTime, otherwise leave it at the end, so nothing can play until the
  // whole file has arrived. YouTube asks for it up front, and it is what lets a
  // file start playing while it is still downloading.
  //
  // This needs a SEEKABLE output, because it is a second pass that rewrites the
  // finished file. Ours always is: only the INPUT is a pipe (raw RGBA on stdin),
  // while the output is a real path from the save dialog or config.outPath, and
  // nativeExport.ts never hands ffmpeg a stream to write to. A cancelled export
  // is unaffected either way, since main deletes the partial file.
  args.push('-movflags', '+faststart')
  // Machine-readable progress on stdout (the movie goes to a file).
  args.push('-progress', 'pipe:1', '-nostats')
  args.push(outPath)
  return args
}
