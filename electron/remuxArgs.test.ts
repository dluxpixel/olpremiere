import { describe, expect, it } from 'vitest'
import { needsRemux, parseSourceStreams, remuxArgs, remuxPlan } from './remuxArgs'

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
