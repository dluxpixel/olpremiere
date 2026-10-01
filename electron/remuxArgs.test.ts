import { describe, expect, it } from 'vitest'
import { MASTER_LADDER, framesLost, needsRemux, parseSourceStreams, remuxArgs, remuxPlan, sdrMasterArgs } from './remuxArgs'

// ⛔ REAL ffmpeg OUTPUT, captured 2026-08-13 from the BUNDLED binary
// (vendor/ffmpeg/win-x64/ffmpeg.exe) against files it had just written. Not
// typed from memory: this parser reads a human readable report because no
// ffprobe is shipped, so the only thing that makes it safe is being pinned to
// what the real binary really prints.
const AAC_MKV = `
Input #0, matroska,webm, from 'cap.mkv':
  Metadata:
    ENCODER         : Lavf62.6.100
  Duration: 00:00:03.02, start: 0.000000, bitrate: 333 kb/s
  Stream #0:0: Video: h264 (High 4:4:4 Predictive), yuv444p(tv, progressive), 1280x720 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 1k tbn
  Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp
`

const OPUS_MKV = `
Input #0, matroska,webm, from 'opus.mkv':
  Duration: 00:00:02.01, start: 0.000000, bitrate: 300 kb/s
  Stream #0:0: Video: h264 (High 4:4:4 Predictive), yuv444p(tv, progressive), 640x360 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 1k tbn
  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp
`

describe('reading what a capture holds', () => {
  it('reads the duration and both codecs off real ffmpeg output', () => {
    expect(parseSourceStreams(AAC_MKV)).toEqual({ durationS: 3.02, video: 'h264', audio: 'aac' })
  })

  it('reads an hour long capture, not just the seconds', () => {
    // A gameplay recording is the whole point of this feature, and an hours
    // field that was ignored would import as a clip 12 minutes long.
    expect(parseSourceStreams('  Duration: 01:12:33.50, start: 0.000000').durationS).toBeCloseTo(4353.5, 3)
  })

  it('a capture with no sound at all is not a parse failure', () => {
    const s = parseSourceStreams('  Duration: 00:00:05.00\n  Stream #0:0: Video: h264, yuv420p, 1920x1080')
    expect(s.audio).toBeUndefined()
    expect(s.video).toBe('h264')
  })

  it('says zero rather than NaN when ffmpeg reported nothing usable', () => {
    expect(parseSourceStreams('').durationS).toBe(0)
  })
})

describe('deciding what has to be rebuilt', () => {
  it('an ordinary OBS capture copies both streams', () => {
    expect(remuxPlan(parseSourceStreams(AAC_MKV))).toEqual({ canCopyVideo: true, reencodeAudio: false })
  })

  it('⛔ opus audio is rebuilt as AAC even though MP4 would accept it', () => {
    // MEASURED: ffmpeg muxes opus into MP4 and exits 0, so its exit code would
    // have called this a success and handed the app a file it cannot play.
    // The test is about the DECODER, not the container.
    expect(remuxPlan(parseSourceStreams(OPUS_MKV))).toEqual({ canCopyVideo: true, reencodeAudio: true })
  })

  it('a silent capture is never treated as needing an audio rebuild', () => {
    expect(remuxPlan({ durationS: 5, video: 'h264' }).reencodeAudio).toBe(false)
  })

  it('video it cannot copy is reported rather than assumed', () => {
    expect(remuxPlan({ durationS: 5, video: 'vp9', audio: 'aac' }).canCopyVideo).toBe(false)
  })
})

describe('the arguments themselves', () => {
  const args = (plan = { canCopyVideo: true, reencodeAudio: false }) => remuxArgs('in.mkv', 'out.mp4', plan)

  it('copies the video and the audio, and puts the index at the front', () => {
    const a = args()
    expect(a.join(' ')).toContain('-c:v copy')
    expect(a.join(' ')).toContain('-c:a copy')
    // Without faststart the player seeks to the end of a multi-gigabyte file
    // before it can show frame one.
    expect(a.join(' ')).toContain('-movflags +faststart')
    expect(a[a.length - 1]).toBe('out.mp4')
  })

  it('⛔ NEVER re-encodes the video on the ordinary path', () => {
    // The one thing this feature must not do. A multi-gigabyte re-encode on
    // import is minutes of waiting and quality he cannot get back.
    expect(args().join(' ')).not.toContain('libx264')
  })

  it('rebuilds only the audio when only the audio is wrong', () => {
    const a = args({ canCopyVideo: true, reencodeAudio: true }).join(' ')
    expect(a).toContain('-c:v copy')
    expect(a).toContain('-c:a aac')
    expect(a).not.toContain('libx264')
  })

  it('falls back to re-encoding the picture only when it truly cannot be copied', () => {
    const a = args({ canCopyVideo: false, reencodeAudio: false }).join(' ')
    expect(a).toContain('libx264')
    expect(a).toContain('-crf 18')
  })

  it('takes whichever streams exist rather than failing on a missing one', () => {
    // The `?` is what stops a silent capture being an error.
    expect(args().join(' ')).toContain('-map 0:v:0? -map 0:a:0?')
  })
})

describe('which files go through this at all', () => {
  it('takes what OBS records and Chromium cannot open', () => {
    for (const n of ['gameplay.mkv', 'CAP.MKV', 'stream.flv', 'clip.ts', 'cam.m2ts', 'voice.mka']) {
      expect(needsRemux(n), n).toBe(true)
    }
  })

  it('⛔ leaves alone everything the browser already opens', () => {
    // webm is the one worth stating: Chromium demuxes it natively, so sending it
    // here would be pure cost. mp4 and mov are what OBS writes when it is not
    // writing mkv, and they import today.
    for (const n of ['a.mp4', 'a.mov', 'a.webm', 'a.m4a', 'a.mp3', 'a.wav', 'a.png', 'a.jpg']) {
      expect(needsRemux(n), n).toBe(false)
    }
  })

  it('is not fooled by the extension appearing earlier in the name', () => {
    expect(needsRemux('my.mkv.backup.mp4')).toBe(false)
    expect(needsRemux('season.ts.recording.mkv')).toBe(true)
  })
})

// ⛔ REAL ffmpeg OUTPUT, 2026-10-01, the bundled binary against HIS OWN iPhone
// clip (IMG_5001, the GYM2 take), trimmed to the lines that matter. Note the
// Stream group block: the video line appears more than once, and the first one
// is the one that counts.
const IPHONE_MOV = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_5001.MOV':
  Duration: 00:00:13.50, start: 0.000000, bitrate: 14004 kb/s
  Stream group #0:0[0x3]: Track Reference:
    Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 13720 kb/s, 29.99 fps, 30 tbr, 600 tbn (default)
      Side data:
        DOVI configuration record: version: 1.0, profile: 8, level: 4, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 4, compression: 0
        Display Matrix: rotation of -90.00 degrees
    Stream #0:2[0x3](und): Data: none (mebx / 0x7862656D), 0 kb/s (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 186 kb/s (default)
`

const HDR10_MOV = `
  Duration: 00:00:01.00, start: 0.000000, bitrate: 297 kb/s
  Stream #0:0[0x1]: Video: hevc (Main 10) (hev1 / 0x31766568), yuv420p10le(tv, bt2020nc/bt2020/smpte2084, progressive), 320x240 [SAR 1:1 DAR 4:3], 220 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2]: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 34 kb/s (default)
`

describe('telling an HDR clip from an ordinary one', () => {
  it('reads HLG off his own iPhone clip', () => {
    expect(parseSourceStreams(IPHONE_MOV)).toEqual({ durationS: 13.5, video: 'hevc', audio: 'aac', hdr: 'hlg' })
  })

  it('reads PQ, the other HDR transfer (HDR10)', () => {
    expect(parseSourceStreams(HDR10_MOV).hdr).toBe('pq')
  })

  it('leaves an ordinary capture alone', () => {
    // His OBS captures are SDR, and converting one would be minutes for nothing.
    expect(parseSourceStreams(AAC_MKV).hdr).toBeUndefined()
    expect(parseSourceStreams('  Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080').hdr).toBeUndefined()
  })
})

describe('the SDR master of an HDR clip', () => {
  const plan = { canCopyVideo: false, reencodeAudio: false }
  const args = (tonemap: 'libplacebo' | 'zscale' = 'libplacebo', encoder: 'qsv' | 'software' = 'qsv') =>
    sdrMasterArgs('IMG_5001.MOV', 'out.mp4', plan, tonemap, encoder)
  const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1]

  it("applies the clip's own Dolby Vision grade, on the graphics card", () => {
    const a = args()
    expect(after(a, '-vf')).toContain('libplacebo=')
    expect(after(a, '-vf')).toContain('apply_dolbyvision=1')
    expect(after(a, '-vf')).toContain('format=yuv420p')
    expect(a.join(' ')).toContain('-init_hw_device vulkan=vk -filter_hw_device vk')
  })

  it('falls back to the zscale chain with no Vulkan device at all', () => {
    const a = args('zscale')
    expect(after(a, '-vf')).toContain('npl=150')
    expect(after(a, '-vf')).toContain('tonemap=hable')
    expect(a.join(' ')).not.toContain('vulkan')
  })

  it('⛔ keeps the phone frame times exactly, not rounded to the grid', () => {
    const a = args().join(' ')
    expect(a).toContain('-fps_mode passthrough')
    // Without this the encoder's time base is 1/30 and every jittered frame
    // moves, measured up to 3.3 ms on his clip.
    expect(a).toContain('-enc_time_base demux')
  })

  it('copies the sound with its edit list, and says SDR in the file', () => {
    const a = args()
    expect(after(a, '-c:a')).toBe('copy')
    expect(a.join(' ')).toContain('-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv')
  })

  it('uses the encoder settings that measured 45 dB or better on both of his clips', () => {
    expect(args('libplacebo', 'qsv').join(' ')).toContain('-c:v h264_qsv -preset veryslow -global_quality 18 -g 30')
    expect(args('libplacebo', 'software').join(' ')).toContain('-c:v libx264 -preset veryfast -crf 18 -g 30')
  })

  it('stops on a frame it cannot decode, and reports how far it got', () => {
    const a = args()
    expect(a).toContain('-xerror')
    expect(a.join(' ')).toContain('-progress pipe:1')
  })

  it('tries the best way first and keeps a way that needs nothing special last', () => {
    expect(MASTER_LADDER[0]).toEqual({ tonemap: 'libplacebo', encoder: 'qsv' })
    expect(MASTER_LADDER[MASTER_LADDER.length - 1]).toEqual({ tonemap: 'zscale', encoder: 'software' })
  })
})

describe('a re-encode is held to the frames it was given', () => {
  it('stops on a frame that will not decode, but only when it decodes at all', () => {
    // A copy never decodes, and his OBS captures with a damaged tail must keep
    // converting the way they always have.
    expect(remuxArgs('a.mov', 'b.mp4', { canCopyVideo: false, reencodeAudio: false })).toContain('-xerror')
    expect(remuxArgs('a.mkv', 'b.mp4', { canCopyVideo: true, reencodeAudio: false })).not.toContain('-xerror')
  })

  it('counts more than one missing frame as a failure', () => {
    // The real one: 389 of 405 frames came back and were imported as fine.
    expect(framesLost(405, 389)).toBe(16)
    expect(framesLost(405, 405)).toBe(0)
    expect(framesLost(405, 404)).toBe(0)
    expect(framesLost(405, 403)).toBe(2)
    // A source whose frames could not be counted is never held against itself.
    expect(framesLost(0, 12)).toBe(0)
  })
})
