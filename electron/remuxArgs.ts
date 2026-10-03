// The ffmpeg argument surface for turning a recording the browser cannot open
// into one it can, kept PURE and free of any Electron import so the whole policy
// is unit tested without spawning anything. Same rule and same reason as
// exportArgs.ts.
//
// ⛔ WHY THIS EXISTS AT ALL: his own OBS captures are .mkv, and Chromium cannot
// demux Matroska. Nothing downstream is broken, the wall is at the very front
// door: probeFile makes a <video> element, `loadedmetadata` never fires, and the
// import fails before an asset exists. So the file is converted ONCE on import
// and everything after it, preview, proxy, export, is untouched code.
//
// ⛔⛔ THE VIDEO IS COPIED, NEVER RE-ENCODED. OBS records H.264 into MKV
// precisely because Matroska survives a crash, and then people remux it to MP4
// afterwards; that remux is a container change, so it is lossless and runs at
// disk speed. Re-encoding a multi-gigabyte capture on import would take many
// minutes and throw away quality he cannot get back. Measured 2026-08-13:
// a 3 second capture remuxed in 1.27s, byte-for-byte identical streams.

/** What a source turned out to hold, read from ffmpeg's own report. */
export interface SourceStreams {
  durationS: number
  /** ffmpeg's short codec name, e.g. `h264`, or undefined when there is no such stream. */
  video?: string
  audio?: string
  /** The picture's HDR transfer, HLG (his iPhone's HDR video) or PQ (HDR10), or undefined for SDR. */
  hdr?: 'hlg' | 'pq'
}

/**
 * Audio codecs that are legal in MP4 *and* that Chromium will actually decode.
 *
 * ⛔ THIS LIST IS ABOUT THE DECODER, NOT THE CONTAINER, and that is the trap.
 * Measured 2026-08-13: ffmpeg happily muxes Opus into MP4 and exits 0, so
 * trusting its exit code would hand the app a file it cannot play, with no error
 * anywhere. Anything not on this list gets its audio re-encoded to AAC, which is
 * seconds of work because only the audio is touched.
 */
const MP4_SAFE_AUDIO = new Set(['aac', 'mp3'])

/**
 * Video codecs worth copying into MP4. Anything else has to be re-encoded, which
 * is slow and lossy, so it is deliberately NOT done silently: `remuxPlan` says
 * so and the caller decides.
 */
const MP4_SAFE_VIDEO = new Set(['h264', 'hevc', 'h265', 'av1'])

export interface RemuxPlan {
  /** False when the source holds video this cannot copy, so no fast path exists. */
  canCopyVideo: boolean
  /** True when the audio has to be rebuilt as AAC rather than copied. */
  reencodeAudio: boolean
}

/** What has to happen to this source to make it an MP4 the app can open. */
export function remuxPlan(streams: SourceStreams): RemuxPlan {
  return {
    canCopyVideo: streams.video !== undefined && MP4_SAFE_VIDEO.has(streams.video),
    // No audio at all is nothing to re-encode, and a stream copy of nothing is
    // not an error, so a silent capture takes the fast path like any other.
    reencodeAudio: streams.audio !== undefined && !MP4_SAFE_AUDIO.has(streams.audio),
  }
}

/**
 * The plan for a file CHROMIUM ALREADY REFUSED, where copying would change nothing.
 *
 * ⛔ IT FORCES A RE-ENCODE, AND THAT IS THE ENTIRE POINT. `MP4_SAFE_VIDEO`
 * contains `hevc`, so an iPhone .mov run through `remuxPlan` would have its HEVC
 * COPIED into an MP4 and handed back to the same decoder that just failed on it.
 * The import would fail a second time, having spent minutes proving it.
 *
 * This path is only ever reached after a real decode failure, so the one thing
 * known for certain is that the video stream as it stands cannot be played here.
 * H.264 is the codec every Chromium build can decode, so that is what it becomes.
 *
 * The audio rule is unchanged: it is about what MP4 and Chromium accept, and a
 * decode failure on the video says nothing about the sound.
 */
export function rescuePlan(streams: SourceStreams): RemuxPlan {
  return { ...remuxPlan(streams), canCopyVideo: false }
}

/**
 * Is this worth handing to ffmpeg after the browser has already failed on it?
 *
 * ⛔ DELIBERATELY MUCH WIDER THAN `needsRemux`, and the two answer different
 * questions. `needsRemux` asks "convert this before even trying", which must stay
 * narrow or every ordinary .mp4 pays for a conversion it never needed. This one
 * asks "the browser said no, is there anything left to try", and by then the only
 * alternatives are ffmpeg or telling somebody their video is unsupported.
 *
 * ⛔ AND THE FILE THAT SENT ME HERE IS THE ONE EVERYBODY HAS. An iPhone or
 * modern Android clip is HEVC in a .mov or .mp4, which `needsRemux` skips by
 * design, which Chromium often cannot decode, and which therefore reached
 * "couldn't import (unsupported?)" while the 137.9 MB ffmpeg in the installer sat
 * there able to convert it. Nobody but David had ever opened this app, and David
 * records with OBS.
 *
 * It is a list rather than "try everything" only so a dropped .txt or .zip does
 * not cost a full upload to a temp file before ffmpeg says no.
 */
export function canRescueByRemux(fileName: string): boolean {
  return /\.(mp4|mov|m4v|avi|wmv|mpg|mpeg|3gp|3g2|webm|ogv|mxf|asf|vob|divx)$/i.test(fileName.trim())
}

/**
 * Read what ffmpeg says about a source. ffmpeg is asked to open the file and
 * produce no output, so it prints its report and exits NON-ZERO by design: the
 * exit code carries no meaning here and the caller must not read one.
 *
 * ⛔ Only `ffmpeg.exe` is bundled, there is no ffprobe, so this parses the human
 * readable report on purpose rather than asking for json that is not available.
 * It is pinned by tests against real ffmpeg output for exactly that reason.
 */
export function parseSourceStreams(stderr: string): SourceStreams {
  const dur = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr)
  const durationS = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
  // The first stream of each kind wins. A capture with a second audio track is
  // ordinary (desktop plus microphone) and the first is the one MP4 will carry.
  const video = /Stream #\d+:\d+.*?:\s*Video:\s*([a-z0-9]+)/i.exec(stderr)?.[1]
  const audio = /Stream #\d+:\d+.*?:\s*Audio:\s*([a-z0-9]+)/i.exec(stderr)?.[1]
  // The transfer is the last of the three names in the pixel format's brackets,
  // `yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)` on his iPhone clips. Read on
  // the first video line only, so a second stream cannot lend its colour.
  const videoLine = /Stream #\d+:\d+.*?:\s*Video:[^\n]*/i.exec(stderr)?.[0] ?? ''
  const hdr = /arib-std-b67/.test(videoLine) ? 'hlg' : /smpte2084/.test(videoLine) ? 'pq' : undefined
  return { durationS, video: video?.toLowerCase(), audio: audio?.toLowerCase(), hdr }
}

/** Ask ffmpeg to report on a file and produce nothing. */
export function probeArgs(input: string): string[] {
  return ['-hide_banner', '-i', input]
}

/**
 * Count the source's video frames by reading its packets, decoding nothing.
 * Under a second on his 75 second clip, and the only honest number to hold a
 * re-encode against: ffmpeg's report has a duration, never a frame count.
 */
export function frameCountArgs(input: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']
}

/**
 * What every re-encode carries: stop on a frame that will not decode, and say
 * how far it got on stdout (`frame=`, `out_time_us=`), which is both the
 * progress he sees and the count `framesLost` holds against the source.
 */
const reencodeChecks = ['-xerror', '-nostats', '-progress', 'pipe:1']

/**
 * Frames a re-encode dropped, or 0. One frame of slack, because a source whose
 * last packet is a fragment ends a frame early without anything being wrong.
 */
export function framesLost(sourceFrames: number, outputFrames: number): number {
  if (!(sourceFrames > 0)) return 0
  const lost = sourceFrames - outputFrames
  return lost > 1 ? lost : 0
}

/**
 * Convert `input` to an MP4 at `output`, copying everything that can be copied.
 *
 * `-movflags +faststart` moves the index to the front. Without it the player has
 * to seek to the end of a multi-gigabyte file before it can show frame one, which
 * is the whole reason a capture feels broken rather than slow.
 */
export function remuxArgs(input: string, output: string, plan: RemuxPlan): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    // ⛔ A RE-ENCODE STOPS ON THE FIRST FRAME IT CANNOT DECODE. Seen 2026-09-29
    // on a starved machine: the rescued iPhone clip came back 389 of 405 frames,
    // with a half second hole in it, and the import said "Imported". A copy
    // never decodes, so only a re-encode gets this, and `reencodeChecks` counts
    // the frames afterwards as well.
    ...(plan.canCopyVideo ? [] : reencodeChecks),
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    // ⛔ The slow path is REAL but rare, and it is not silent: `canCopyVideo` is
    // false only for something like VP9 or ProRes in an MKV, which his captures
    // are not. Re-encoding is minutes rather than seconds, so the caller warns
    // before it starts. crf 18 is visually lossless; this is his source footage
    // and it is the last place to be saving bytes.
    '-c:v',
    ...(plan.canCopyVideo ? ['copy'] : ['libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']),
    '-c:a',
    plan.reencodeAudio ? 'aac' : 'copy',
    ...(plan.reencodeAudio ? ['-b:a', '192k'] : []),
    // Timestamps out of a crash-safe recording can start anywhere or drift;
    // MP4 wants them from zero and monotonic.
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    output,
  ]
}

// ---------------------------------------------------------------------------
// HDR phone clips: one SDR master on import
//
// ⛔ HIS WORDS, 2026-09-29: "make sure, because I input a lot of videos from my
// iPhone, that the iPhone videos are fucking perfect, especially with the
// export." His iPhone clips are HEVC 10 bit HLG with Dolby Vision, and nothing
// in this app ever tone mapped them: Chromium's own HLG curve did, inside every
// drawImage, for the preview and the export alike. Measured on his two clips
// against the clip's own SDR grade (its Dolby Vision data): the darkest tenth
// came out at HALF the level it should (3.0 against 9.5), and 5.68% of the
// picture sat at black against 1.65%. He had been adding +0.1 brightness to his
// GYM cuts by hand to make up for it.
//
// So a new HDR clip is tone mapped ONCE, on import, by the bundled ffmpeg, and
// everything after it (preview, proxy, export) only ever sees an ordinary SDR
// H.264 file, exactly the way the rescue path already swaps the source.

/** How the HDR picture becomes SDR. */
export type ToneMapper = 'libplacebo' | 'zscale'
/** Which encoder writes the master. */
export type MasterEncoder = 'qsv' | 'software'

/**
 * The tone maps, best first.
 *
 * libplacebo on the graphics card, with `apply_dolbyvision=1`: an iPhone records
 * its own SDR grade frame by frame (the Dolby Vision RPU), and this applies it,
 * so the master is the look the phone itself intended. Measured in the real app
 * on his two clips, 2026-10-01, exported frames against that grade: 42.6 to
 * 45.1 dB where Chromium's curve gave 26.8 to 32.2, and the darkest tenth at
 * 9.8 against the grade's 9.6 where it was 3.0. An HLG or PQ clip with no RPU
 * (Android, HDR10) gets libplacebo's own tone mapping instead.
 *
 * zscale is the fallback for a machine with no Vulkan: the closest of the
 * software chains to the Dolby Vision grade (npl 150 with hable: dY -0.8 and
 * -6.0 on his two clips; npl 100 or 203 and mobius or reinhard were all worse).
 */
const TONE_MAP: Record<ToneMapper, string> = {
  libplacebo:
    'libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:apply_dolbyvision=1:format=yuv420p',
  zscale:
    'zscale=t=linear:npl=150,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p',
}

/**
 * The master's encoder, CHOSEN BY MEASUREMENT on his own two clips, 2026-10-01.
 * Luma PSNR against the same tone map with no lossy step at all, size and
 * wall clock for his 75.6 s clip (the 13.5 s one in brackets):
 *
 * | encoder                       | luma dB       | size            | time   |
 * | ----------------------------- | ------------- | --------------- | ------ |
 * | h264_qsv global_quality 16    | 46.56 (46.87) | 96.7 MB (20.6)  | 18.4 s |
 * | h264_qsv global_quality 18    | 45.52 (45.78) | 72.1 MB (14.9)  | 16.1 s |
 * | h264_qsv global_quality 20    | 45.11 (45.73) | 62.1 MB (13.4)  | 15.6 s |
 * | libx264 veryfast crf 12       | 48.51 (48.86) | 190.5 MB (44.8) | 16.7 s |
 * | libx264 veryfast crf 16       | 46.45 (46.85) | 97.3 MB (22.4)  | 17.0 s |
 * | libx264 veryfast crf 18       | 45.39 (45.83) | 71.6 MB (16.2)  | 13.2 s |
 *
 * The bar was 45 dB, real time or faster, and the least disk that clears it.
 * 18 clears it on both clips with half a dB to spare and comes out SMALLER than
 * the 103.7 MB original; 20 clears it by 0.1 dB, too thin for a clip shot in
 * worse light. QuickSync first because it does the work on the processor's own
 * graphics instead of ten cores (the same reason as the preview copies in
 * proxy.ts); libx264 at the same quality for a machine without it.
 *
 * A keyframe every 30 frames (the phone's own file has one every 28) keeps a
 * cut into the middle of a long clip as cheap to reach as it was.
 */
const MASTER_VIDEO: Record<MasterEncoder, string[]> = {
  qsv: ['-c:v', 'h264_qsv', '-preset', 'veryslow', '-global_quality', '18', '-g', '30'],
  software: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', '-pix_fmt', 'yuv420p'],
}

/** Every way to make the master, best first. Tried in this order until one works. */
export const MASTER_LADDER: ReadonlyArray<{ tonemap: ToneMapper; encoder: MasterEncoder }> = [
  { tonemap: 'libplacebo', encoder: 'qsv' },
  { tonemap: 'libplacebo', encoder: 'software' },
  { tonemap: 'zscale', encoder: 'qsv' },
  { tonemap: 'zscale', encoder: 'software' },
]

/** Turn an HDR clip into its SDR master. */
export function sdrMasterArgs(
  input: string,
  output: string,
  plan: RemuxPlan,
  tonemap: ToneMapper,
  encoder: MasterEncoder,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...reencodeChecks,
    '-y',
    // libplacebo runs on the graphics card through Vulkan. ffmpeg uploads and
    // downloads the frames itself.
    ...(tonemap === 'libplacebo' ? ['-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk'] : []),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    // ⛔ THE PHONE'S OWN FRAME TIMES, TO THE TICK. passthrough alone still
    // rounded every time onto a 1/30 grid, measured up to 3.3 ms off on 292 of
    // 405 frames; the demuxer's time base keeps every one exact (0.0 ms on all
    // 405 and all 2267), so the picture keeps its place against the sound.
    '-fps_mode',
    'passthrough',
    '-enc_time_base',
    'demux',
    // The rotation needs nothing: ffmpeg turns the picture upright before the
    // filter, so the master is 1080x1920 with no matrix left to honour.
    '-vf',
    TONE_MAP[tonemap],
    ...MASTER_VIDEO[encoder],
    // Said in the file too, so nothing downstream has to assume.
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-color_range',
    'tv',
    // The sound is copied with its edit list, so the 2112 samples of encoder
    // priming stay hidden exactly as they were in the phone's file.
    '-c:a',
    plan.reencodeAudio ? 'aac' : 'copy',
    ...(plan.reencodeAudio ? ['-b:a', '192k'] : []),
    '-movflags',
    '+faststart',
    output,
  ]
}

/**
 * Does this file have to be converted before the app can open it?
 *
 * ⛔ BY EXTENSION, NOT BY MIME TYPE. Windows reports `.mkv` as an empty string
 * on machines with no player registered for it, and as `video/x-matroska` on
 * machines that have one, so the type on the File is not something to branch on.
 * The name is what he actually dropped.
 *
 * ⛔⛔ THIS LIST IS OBS'S RECORDING FORMATS THAT CHROMIUM CANNOT OPEN, and it is
 * deliberately no wider than that. `.mp4` and `.mov` are already fine and must
 * never be sent through here, and **`.webm` is NOT on this list on purpose**:
 * Chromium demuxes it natively, so converting it would be pure cost for nothing.
 * Formats like `.avi` and `.wmv` are left off too, because their codecs cannot be
 * copied into MP4 at all and supporting them is a re-encoding feature, not this
 * one. Widening this beyond what he actually records is how a one second import
 * becomes a five minute one.
 */
export function needsRemux(fileName: string): boolean {
  return /\.(mkv|mka|flv|ts|m2ts|mts)$/i.test(fileName.trim())
}
