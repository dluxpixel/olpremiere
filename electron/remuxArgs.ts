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
  return { durationS, video: video?.toLowerCase(), audio: audio?.toLowerCase() }
}

/** Ask ffmpeg to report on a file and produce nothing. */
export function probeArgs(input: string): string[] {
  return ['-hide_banner', '-i', input]
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
