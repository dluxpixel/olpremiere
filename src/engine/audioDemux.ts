// The audio read, with no AudioContext in sight, so it runs the same in a Worker
// (audioDecodeWorker.ts) and on the main thread (the fallback in audio.ts).
//
// ⛔ WHY IT LEFT audio.ts, 2026-09-28. His words: *"The app is laggy when I have
// multiple projects or way too many items in a single project."* Measured on a
// copy of his biggest project (17 audible assets, 3042 s of source sound): with
// the read on the main thread, playback ran at about 23 fps with 111 of 191
// frames late, and roughly a third of the main thread during play was this
// demux, re-reading sound the cache had just thrown away. Moving the read into a
// worker takes it off the thread that draws the picture and answers his mouse.

import type { AudioSample, InputAudioTrack } from 'mediabunny'
import { StreamResampler } from './resample'

/**
 * The demuxer's read window. mediabunny's own default is 8 MB; halved because
 * two reads run at once.
 */
export const DEMUX_CACHE_BYTES = 4 * 1024 * 1024

export interface DemuxRequest {
  /** The asset's duration as the project knows it, the time axis every buffer uses. */
  durationS: number
  /** Source seconds to start at. Omitted means the start of the file. */
  fromS?: number
  /** Source seconds to stop at. Omitted means the end of the file. */
  toS?: number
}

/**
 * The rate every decoded buffer comes back at: the export's mix rate
 * (audioRender.ts EXPORT_SAMPLE_RATE, pinned equal by a test). Not imported from
 * there, because this file runs in a worker and that one pulls in the mixer.
 */
export const DECODE_SAMPLE_RATE = 48_000

export type DemuxResult =
  /** The file holds no audio track at all. Proof of silence, not a guess. */
  | { kind: 'silent' }
  /**
   * A track exists but this build cannot decode it: the caller may fall back.
   * `sampleRate` is the track's own rate when the container says it, so the
   * fallback can decode at that rate and resample with the sinc in resample.ts
   * rather than let the browser pick.
   */
  | { kind: 'undecodable'; sampleRate?: number }
  | { kind: 'pcm'; sampleRate: number; startS: number; planes: Float32Array[] }

async function openTrack(blob: Blob): Promise<{ track: InputAudioTrack | null; isMp3: boolean; dispose: () => void }> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob, { maxCacheSize: DEMUX_CACHE_BYTES }) })
  try {
    const track = await input.getPrimaryAudioTrack()
    const isMp3 = track ? (await input.getFormat()).name === 'MP3' : false
    return { track, isMp3, dispose: () => input.dispose() }
  } catch (err) {
    input.dispose()
    throw err
  }
}

/**
 * Every MP3 decoder hands back this many samples of its own filterbank before
 * the first real one. Trimmed even when the file says nothing more.
 */
export const MP3_DECODER_DELAY = 529

/**
 * ⛔ HOW MANY SAMPLES AT THE HEAD OF AN MP3 ARE NOT HIS SOUND, 2026-10-01.
 *
 * An MP3 carries no timestamp that says so: the encoder's delay (576 samples
 * from LAME) and the decoder's (529) sit INSIDE the decoded sound, and
 * mediabunny reports the first packet at zero. Measured on his media: every one
 * of his 14 mp3 files (Battle Cats, Mario and DSi music, the vine booms, the
 * risers) played 23 to 25 ms late in the app, while ffmpeg and Chromium's own
 * decode put the same sounds exactly on time. 25 ms is most of a frame at 30 fps
 * on every music hit he cuts to.
 *
 * The encoder writes its delay into the LAME tag of the first frame (the Xing or
 * Info frame mediabunny skips). Read the way ffmpeg reads it: the tag from an
 * encoder string of LAME, Lavf or Lavc, the delay in the 12 bits at offset 21,
 * plus the 529 of the decoder. With no tag only the 529 is known, so only the
 * 529 is trimmed.
 *
 * `readAt` reads bytes of the FILE, so this works on any blob without holding it.
 */
export async function mp3HeadSkip(readAt: (offset: number, length: number) => Promise<Uint8Array>): Promise<number> {
  let pos = 0
  // ID3v2 tags first, as many as there are, and they can be big: album art lives here.
  for (let guard = 0; guard < 16; guard++) {
    const h = await readAt(pos, 10)
    if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) break
    const size = ((h[6]! & 0x7f) << 21) | ((h[7]! & 0x7f) << 14) | ((h[8]! & 0x7f) << 7) | (h[9]! & 0x7f)
    pos += 10 + size + (h[5]! & 0x10 ? 10 : 0)
  }
  return mp3DelayFromFrames(await readAt(pos, MP3_SCAN_BYTES))
}

/** How far past the tags the first frame is looked for. */
const MP3_SCAN_BYTES = 16_384

/** The head skip, in samples, read from the bytes where the frames begin. */
export function mp3DelayFromFrames(b: Uint8Array): number {
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) continue
    const version = (b[i + 1]! >> 3) & 3 // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5, 1 reserved
    const layer = (b[i + 1]! >> 1) & 3 // 1 is Layer III
    const bitrate = b[i + 2]! >> 4
    const rate = (b[i + 2]! >> 2) & 3
    if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) continue
    // The first real frame. Its side information decides where a tag would sit.
    const mono = b[i + 3]! >> 6 === 3
    const at = i + (version === 3 ? (mono ? 21 : 36) : mono ? 13 : 21)
    if (at + 8 > b.length) return MP3_DECODER_DELAY
    const tag = String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!)
    if (tag !== 'Xing' && tag !== 'Info') return MP3_DECODER_DELAY
    const flags = ((b[at + 4]! << 24) | (b[at + 5]! << 16) | (b[at + 6]! << 8) | b[at + 7]!) >>> 0
    let lame = at + 8
    if (flags & 1) lame += 4 // frame count
    if (flags & 2) lame += 4 // byte count
    if (flags & 4) lame += 100 // seek table
    if (flags & 8) lame += 4 // quality
    if (lame + 24 > b.length) return MP3_DECODER_DELAY
    const vendor = String.fromCharCode(b[lame]!, b[lame + 1]!, b[lame + 2]!, b[lame + 3]!)
    if (vendor !== 'LAME' && vendor !== 'Lavf' && vendor !== 'Lavc') return MP3_DECODER_DELAY
    const encoderDelay = (b[lame + 21]! << 4) | (b[lame + 22]! >> 4)
    return encoderDelay + MP3_DECODER_DELAY
  }
  return 0
}

/** The head skip for this file: zero for anything that is not an MP3 file. */
async function headSkipFor(blob: Blob, isMp3: boolean): Promise<number> {
  if (!isMp3) return 0
  try {
    return await mp3HeadSkip(async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()))
  } catch {
    return MP3_DECODER_DELAY
  }
}

/**
 * Decode source seconds [fromS, toS) of the file's primary audio track into
 * float32 planes. Sample 0 of every plane is `startS` of source time.
 *
 * ⛔ SIZED FROM `durationS`, NOT FROM THE CONTAINER. A range is the same axis
 * cut shorter, so a range and a whole read of the same file agree sample for
 * sample.
 *
 * ⛔ EVERY SAMPLE GOES AT ITS OWN TIMESTAMP, THE SAME CLOCK THE PICTURE USES
 * (the frame readers ask for `sourceT` as it is). Until 2026-09-30 the AAC
 * track's first timestamp was subtracted. mediabunny already applies the edit
 * list, so that first timestamp is the encoder's priming, sitting BEFORE zero:
 * -0.044 s on his iPhone clips, -0.0213 s on his OBS recordings. Subtracting it
 * pushed every one of those sounds LATE by that much against its own picture
 * (measured on copies of his two iPhone clips: 46.67 ms late in the app's own
 * mix, against ffmpeg's read of the same file). The priming is silence the encoder needs, not sound: it
 * lands before sample 0 and `placeSample` drops it. An MP3's delay is trimmed
 * the same way, see `mp3HeadSkip`.
 *
 * ⛔ EVERY BUFFER COMES BACK AT 48 kHz, 2026-10-01. A source at any other rate
 * (all his mp3 music and sound effects, and YouTube downloads, at 44.1 kHz) is
 * resampled HERE, once, by the windowed sinc in resample.ts, in the decode
 * worker. Before, its buffer kept its own rate and Web Audio converted it in
 * both mixers by linear interpolation: -3.4 dB at 15 kHz and an alias 11.6 dB
 * under the tone in every export. 48 kHz sources pass through untouched, read
 * exactly as before. A range is resampled on the WHOLE file's sample grid (see
 * StreamResampler), so a range and a whole read still agree sample for sample.
 */
export async function demuxAudio(blob: Blob, req: DemuxRequest): Promise<DemuxResult> {
  const { track, isMp3, dispose } = await openTrack(blob)
  try {
    if (!track) return { kind: 'silent' }
    if (!(await track.canDecode())) {
      const rate = await track.getSampleRate().catch(() => 0)
      return rate > 0 ? { kind: 'undecodable', sampleRate: rate } : { kind: 'undecodable' }
    }
    const sampleRate = await track.getSampleRate()
    const channels = await track.getNumberOfChannels()
    if (!(sampleRate > 0) || !(channels > 0)) return { kind: 'undecodable' }
    const durationS = req.durationS > 0 ? req.durationS : await track.computeDuration()
    const fromS = Math.max(0, Math.min(req.fromS ?? 0, durationS))
    const toS = Math.max(fromS, Math.min(req.toS ?? durationS, durationS))
    // Samples at the head that are the codec's, not his: every timestamp moves
    // earlier by this much, so they land before zero and are dropped.
    const skip = await headSkipFor(blob, isMp3)
    const skipS = skip / sampleRate
    const { AudioSampleSink } = await import('mediabunny')
    const ranged = req.fromS !== undefined || req.toS !== undefined

    if (sampleRate !== DECODE_SAMPLE_RATE) {
      const out = DECODE_SAMPLE_RATE
      const outStart = Math.round(fromS * out)
      const rs = new StreamResampler(sampleRate, out, channels, {
        inEnd: Math.round(durationS * sampleRate),
        outStart,
        outEnd: Math.max(outStart + 1, Math.round(toS * out)),
      })
      // A range asks the decoder for exactly the input its outputs read, the
      // kernel's reach either side included.
      const samples = ranged
        ? new AudioSampleSink(track).samples(rs.inStart / sampleRate + skipS, rs.inStop / sampleRate + skipS)
        : new AudioSampleSink(track).samples()
      for await (const sample of samples) {
        try {
          const at = Math.round(sample.timestamp * sampleRate) - skip
          const more = rs.write(at, sample.numberOfFrames, (ch, dest, frameOffset, frameCount) => {
            if (ch < sample.numberOfChannels) {
              sample.copyTo(dest, { planeIndex: ch, format: 'f32-planar', frameOffset, frameCount })
            }
          })
          if (!more) break
        } finally {
          sample.close()
        }
      }
      return { kind: 'pcm', sampleRate: out, startS: outStart / out, planes: rs.finish() }
    }

    const length = Math.max(1, Math.round((toS - fromS) * sampleRate))
    const planes: Float32Array[] = []
    for (let ch = 0; ch < channels; ch++) planes.push(new Float32Array(length))
    const samples = ranged
      ? new AudioSampleSink(track).samples(fromS + skipS, toS + skipS)
      : new AudioSampleSink(track).samples()
    for await (const sample of samples) {
      try {
        if (!placeSample(sample, planes, length, sampleRate, fromS + skipS)) break
      } finally {
        sample.close()
      }
    }
    return { kind: 'pcm', sampleRate, startS: fromS, planes }
  } finally {
    // An undisposed Input retains its read orchestrator, its workers and an open
    // stream reader on the blob.
    dispose()
  }
}

/**
 * Copy one decoded sample into the planes at its place on the time axis.
 * Returns false once the sample starts past the end, so the read can stop.
 *
 * ⚠️ CLAMPED, BECAUSE `copyTo` THROWS RATHER THAN TRUNCATING.
 */
function placeSample(sample: AudioSample, planes: Float32Array[], length: number, sampleRate: number, originTs: number): boolean {
  const at = Math.round((sample.timestamp - originTs) * sampleRate)
  if (at >= length) return false
  const start = Math.max(0, at)
  const skip = start - at
  const frameCount = Math.min(sample.numberOfFrames - skip, length - start)
  if (frameCount <= 0) return true
  for (let ch = 0; ch < Math.min(planes.length, sample.numberOfChannels); ch++) {
    sample.copyTo(planes[ch]!.subarray(start, start + frameCount), {
      planeIndex: ch,
      format: 'f32-planar',
      frameOffset: skip,
      frameCount,
    })
  }
  return true
}

export type PeaksResult = { kind: 'silent' } | { kind: 'undecodable' } | { kind: 'peaks'; peaks: Float32Array }

/**
 * Abs-peak per bucket across every channel of the whole file, WITHOUT holding
 * the file's sound in memory: each decoded sample is reduced into the buckets
 * and dropped. His 1839 s music track used to become 674 MB of float32 just so
 * the timeline could draw a few hundred columns of it.
 */
export async function demuxPeaks(blob: Blob, durationS: number, buckets: number): Promise<PeaksResult> {
  const { track, isMp3, dispose } = await openTrack(blob)
  try {
    if (!track) return { kind: 'silent' }
    if (!(await track.canDecode())) return { kind: 'undecodable' }
    const sampleRate = await track.getSampleRate()
    const channels = await track.getNumberOfChannels()
    if (!(sampleRate > 0) || !(channels > 0)) return { kind: 'undecodable' }
    const dur = durationS > 0 ? durationS : await track.computeDuration()
    const total = Math.max(1, Math.round(dur * sampleRate))
    const n = Math.max(1, Math.floor(buckets))
    const peaks = new Float32Array(n)
    let scratch = new Float32Array(0)
    const skip = await headSkipFor(blob, isMp3)
    const { AudioSampleSink } = await import('mediabunny')
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        // Its own timestamp, the same clock as `demuxAudio`, an MP3's head
        // trimmed the same way: the waveform sits under the sound he hears.
        const at = Math.round(sample.timestamp * sampleRate) - skip
        if (at >= total) break
        const frames = sample.numberOfFrames
        if (scratch.length < frames) scratch = new Float32Array(frames)
        for (let ch = 0; ch < Math.min(channels, sample.numberOfChannels); ch++) {
          const view = scratch.subarray(0, frames)
          sample.copyTo(view, { planeIndex: ch, format: 'f32-planar' })
          for (let j = 0; j < frames; j++) {
            const pos = at + j
            if (pos < 0) continue
            if (pos >= total) break
            const b = Math.min(n - 1, Math.floor((pos * n) / total))
            const v = view[j]! < 0 ? -view[j]! : view[j]!
            if (v > peaks[b]!) peaks[b] = v > 1 ? 1 : v
          }
        }
      } finally {
        sample.close()
      }
    }
    return { kind: 'peaks', peaks }
  } finally {
    dispose()
  }
}
