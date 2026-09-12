// The phone-video rescue: what happens when the browser refuses a file.
//
// His app was unusable for almost everybody and nobody could have known, because
// nobody but David had ever opened it and David records with OBS. An iPhone or
// modern Android clip is HEVC in a .mov or .mp4; `needsRemux` skips those by
// design, Chromium often cannot decode HEVC, and the import ended at
// "couldn't import (unsupported?)" with a 137.9 MB ffmpeg sitting in the
// installer able to convert it.
//
// Found 2026-09-11 by mapping what a genuinely first launch does on a machine
// that has never run the app, then arguing against every candidate failure.

import { describe, expect, it } from 'vitest'
import { canRescueByRemux, needsRemux, remuxArgs, remuxPlan, rescuePlan } from './remuxArgs'

const streams = (video?: string, audio?: string) => ({ durationS: 12, video, audio })

describe('rescuePlan re-encodes, because copying is what already failed', () => {
  it('⛔ refuses to copy HEVC, the exact codec the decoder just rejected', () => {
    // THE ONE THAT MATTERS. `MP4_SAFE_VIDEO` contains 'hevc', so the ordinary
    // plan would COPY an iPhone clip's video into an MP4 and hand it straight
    // back to the decoder that refused it. The import would fail a second time,
    // having spent minutes proving it. If this assertion ever flips, the whole
    // rescue becomes an expensive no-op that still says "unsupported".
    expect(remuxPlan(streams('hevc', 'aac')).canCopyVideo).toBe(true)
    expect(rescuePlan(streams('hevc', 'aac')).canCopyVideo).toBe(false)
  })

  it('re-encodes every video codec, even the ones MP4 would have taken', () => {
    for (const codec of ['h264', 'hevc', 'h265', 'av1', 'vp9', 'prores', undefined]) {
      expect(rescuePlan(streams(codec, 'aac')).canCopyVideo).toBe(false)
    }
  })

  it('leaves the AUDIO rule exactly where it was', () => {
    // A decode failure on the video says nothing about the sound, so the audio
    // question stays what it always was: is this legal in MP4 and playable here.
    expect(rescuePlan(streams('hevc', 'aac')).reencodeAudio).toBe(false)
    expect(rescuePlan(streams('hevc', 'mp3')).reencodeAudio).toBe(false)
    expect(rescuePlan(streams('hevc', 'opus')).reencodeAudio).toBe(true)
    // No audio at all is nothing to re-encode, not something to rebuild.
    expect(rescuePlan(streams('hevc', undefined)).reencodeAudio).toBe(false)
  })

  it('produces libx264 arguments, which is what makes the file playable', () => {
    const args = remuxArgs('in.mov', 'out.mp4', rescuePlan(streams('hevc', 'aac')))
    // Read the token AFTER -c:v, not the whole list: 'copy' appears in these
    // arguments legitimately as the AUDIO codec, so a flat search would pass on
    // a build that copied the video and called it a rescue.
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264')
    // ...and the sound is still copied, because AAC was never the problem.
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy')
    // yuv420p is the other half of "every build can play this": 10-bit HEVC is
    // a common iPhone shape and a 10-bit H.264 would be just as unplayable.
    expect(args).toContain('yuv420p')
  })
})

describe('canRescueByRemux is wider than needsRemux, and deliberately so', () => {
  it('covers the phone footage that needsRemux skips on purpose', () => {
    for (const name of ['IMG_4021.MOV', 'clip.mp4', 'VID_20260911.mp4', 'holiday.m4v']) {
      // Not converted up front: that would make every ordinary mp4 slow.
      expect(needsRemux(name)).toBe(false)
      // But worth a try once the browser has already said no.
      expect(canRescueByRemux(name)).toBe(true)
    }
  })

  it('covers the old camera formats that could never be stream-copied', () => {
    // These were left off needsRemux because their codecs cannot be copied into
    // MP4. A rescue re-encodes, so that objection does not apply to this list.
    for (const name of ['holiday.avi', 'clip.wmv', 'dv.mpg', 'phone.3gp', 'tape.vob']) {
      expect(canRescueByRemux(name)).toBe(true)
    }
  })

  it('still takes his own OBS captures on the fast up-front path', () => {
    for (const name of ['Replay 2026-09-11.mkv', 'stream.flv', 'capture.ts']) {
      expect(needsRemux(name)).toBe(true)
    }
  })

  it('refuses what is not a video, so a stray file costs nothing', () => {
    // The gate exists only so a dropped .txt or .zip does not pay for a full
    // upload to a temp file before ffmpeg says no.
    for (const name of ['notes.txt', 'project.zip', 'photo.png', 'song.mp3', 'noextension']) {
      expect(canRescueByRemux(name)).toBe(false)
    }
  })

  it('ignores case and surrounding space, the way a real filename arrives', () => {
    expect(canRescueByRemux('  IMG_0001.MOV  ')).toBe(true)
    expect(canRescueByRemux('Clip.Mp4')).toBe(true)
  })
})
