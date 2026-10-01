// His words, 2026-09-29: *"make sure, because I input a lot of videos from my
// iPhone, that the iPhone videos are fucking perfect, especially with the
// export."* The backtest found every iPhone clip's sound 46.67 ms late against
// its own picture, and his OBS recordings 21 ms late: the read subtracted the AAC
// track's first timestamp, which is the encoder's priming sitting BEFORE zero.
// And: *"I want the quality to be absolutely the highest, audio and video."* The
// same backtest found every 44.1 kHz source (his mp3 music and sound effects, his
// YouTube downloads) converted to the 48 kHz mix by linear interpolation, and
// every mp3 23 to 25 ms late.
//
// No WebCodecs in this runner, so mediabunny is stood in for by a fake FILE: a
// container, a codec, a rate, packets at timestamps, and what each decoded
// sample holds. The first one is shaped like his iPhone clip: 48 kHz AAC, 1024
// frames a packet, the first packet at -0.044 s (2112 frames of priming, the
// edit list already applied), every packet one constant value, so where a value
// lands says which packet landed there.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeFile {
  /** What mediabunny would call the container. */
  format: 'MP4' | 'MP3'
  rate: number
  channels: number
  /** Frames per packet. */
  packet: number
  /** Where packet 0 starts, in frames: negative for an AAC track's priming. */
  first: number
  packets: number
  /** The decoded value of channel `ch` at frame `n` of the decoder's output. */
  value: (ch: number, n: number) => number
  /** The file's bytes, read only for an MP3's tags. */
  bytes: Uint8Array
}

let file: FakeFile

function fakeSample(k: number) {
  const f = file
  return {
    timestamp: (f.first + k * f.packet) / f.rate,
    duration: f.packet / f.rate,
    numberOfFrames: f.packet,
    numberOfChannels: f.channels,
    copyTo(dest: Float32Array, opts: { planeIndex: number; frameOffset?: number; frameCount?: number }) {
      const off = opts.frameOffset ?? 0
      const count = opts.frameCount ?? f.packet - off
      if (count > dest.length || off + count > f.packet) throw new RangeError('copyTo does not truncate')
      for (let i = 0; i < count; i++) dest[i] = f.value(opts.planeIndex, k * f.packet + off + i)
    },
    close() {},
  }
}

vi.mock('mediabunny', () => {
  const track = {
    canDecode: async () => true,
    getSampleRate: async () => file.rate,
    getNumberOfChannels: async () => file.channels,
    computeDuration: async () => (file.first + file.packets * file.packet) / file.rate,
  }
  class Input {
    getPrimaryAudioTrack = async () => track
    getFormat = async () => ({ name: file.format })
    dispose() {}
  }
  class BlobSource {}
  class AudioSampleSink {
    async *samples(start = -Infinity, end = Infinity) {
      for (let k = 0; k < file.packets; k++) {
        const s = fakeSample(k)
        if (s.timestamp + s.duration <= start) continue
        if (s.timestamp >= end) return
        yield s
      }
    }
  }
  return { ALL_FORMATS: [], Input, BlobSource, AudioSampleSink }
})

const { demuxAudio, demuxPeaks, mp3DelayFromFrames, mp3HeadSkip, DECODE_SAMPLE_RATE, MP3_DECODER_DELAY } = await import(
  './audioDemux'
)

const RATE = 48_000
const PACKET = 1024
const PRIMING = 2112
/** Packet k is filled with this value: the priming packets are 0.1 and 0.2. */
const packetValue = (k: number): number => (k + 1) / 10
const iphone: FakeFile = {
  format: 'MP4',
  rate: RATE,
  channels: 1,
  packet: PACKET,
  first: -PRIMING,
  packets: 12,
  value: (_ch, n) => packetValue(Math.floor(n / PACKET)),
  bytes: new Uint8Array(1),
}
file = iphone
afterEach(() => {
  file = iphone
})

const DURATION = 0.2

async function read(req: Parameters<typeof demuxAudio>[1]) {
  const r = await demuxAudio(new Blob([file.bytes]), req)
  if (r.kind !== 'pcm') throw new Error(`expected pcm, got ${r.kind}`)
  return r
}
const planeOf = async (req: Parameters<typeof demuxAudio>[1]): Promise<Float32Array> => (await read(req)).planes[0]!

describe('an iPhone clip read on the same clock as its picture', () => {
  it('puts the sound of time zero at sample zero, and the priming nowhere', async () => {
    const plane = await planeOf({ durationS: DURATION })
    // Packet 2 starts 64 frames before zero, so it is what plays at zero. The
    // old read put packet 0 (priming) there and everything 2112 frames late.
    expect(plane[0]).toBeCloseTo(packetValue(2), 6)
    // Packet 3 starts at frame 1024 - 64 = 960, to the sample.
    expect(plane[959]).toBeCloseTo(packetValue(2), 6)
    expect(plane[960]).toBeCloseTo(packetValue(3), 6)
    expect(plane.some((v) => Math.abs(v - packetValue(0)) < 1e-6)).toBe(false)
    expect(plane.some((v) => Math.abs(v - packetValue(1)) < 1e-6)).toBe(false)
  })

  it('a range and a whole read agree sample for sample', async () => {
    const whole = await planeOf({ durationS: DURATION })
    const fromS = 0.05
    const range = await planeOf({ durationS: DURATION, fromS, toS: DURATION })
    const off = Math.round(fromS * RATE)
    expect(range.length).toBe(whole.length - off)
    for (let i = 0; i < range.length; i += 97) expect(range[i]).toBe(whole[off + i])
  })

  it('the waveform sits under the sound he hears', async () => {
    const r = await demuxPeaks(new Blob([file.bytes]), DURATION, 96)
    if (r.kind !== 'peaks') throw new Error(`expected peaks, got ${r.kind}`)
    // Bucket 0 is frames 0 to 99, all of them packet 2.
    expect(r.peaks[0]).toBeCloseTo(packetValue(2), 6)
  })

  it('a 48 kHz source is read exactly as before, untouched by any resampler', async () => {
    const r = await read({ durationS: DURATION })
    expect(r.sampleRate).toBe(48_000)
    // Every sample is a packet's exact value, which no filter would leave.
    const plane = r.planes[0]!
    for (let i = 0; i < plane.length; i += 37) {
      expect([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].some((k) => plane[i] === Math.fround(packetValue(k)))).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// EA-1. A 44.1 kHz source comes back at 48 kHz, resampled ONCE, by the sinc.

/** A YouTube style track: 44.1 kHz AAC, stereo, 1 kHz left and 7 kHz right. */
const tone = (f: number, rate: number) => (n: number) => 0.5 * Math.sin((2 * Math.PI * f * n) / rate)
const youtube: FakeFile = {
  format: 'MP4',
  rate: 44_100,
  channels: 2,
  packet: 1024,
  first: -1024,
  packets: 90, // about 2.07 s
  value: (ch, n) => (ch === 0 ? tone(1000, 44_100) : tone(7000, 44_100))(n - 1024),
  bytes: new Uint8Array(1),
}

describe('a 44.1 kHz source is resampled once, at the read, to 48 kHz', () => {
  it('comes back at 48 kHz, sized from the asset, on the same time axis', async () => {
    file = youtube
    const r = await read({ durationS: 2 })
    expect(r.sampleRate).toBe(DECODE_SAMPLE_RATE)
    expect(r.startS).toBe(0)
    expect(r.planes).toHaveLength(2)
    expect(r.planes[0]!.length).toBe(96_000)
  })

  it('lands on the true 48 kHz waveform: no delay, no colour', async () => {
    // Compared against the same tones made at 48 kHz, so any delay, level change
    // or alias shows as error. Interior only: the ends have no neighbours.
    file = youtube
    const r = await read({ durationS: 2 })
    for (const [ch, f] of [
      [0, 1000],
      [1, 7000],
    ] as const) {
      let e = 0
      let s = 0
      for (let i = 2000; i < 94_000; i++) {
        const truth = 0.5 * Math.sin((2 * Math.PI * f * i) / 48_000)
        e += (r.planes[ch]![i]! - truth) ** 2
        s += truth ** 2
      }
      // Linear interpolation, the old way, misses the 7 kHz tone by -21 dB.
      expect(10 * Math.log10(e / s)).toBeLessThan(-90)
    }
  })

  it('⛔ a range and a whole read agree sample for sample, at any range', async () => {
    // The playback reads ranges and the export reads whole files, and the two
    // must never sound different. Every output sample is the same sum over the
    // same input whichever read made it, so they are EQUAL, not close.
    file = youtube
    const whole = await read({ durationS: 2 })
    for (const [fromS, toS] of [
      [0, 1],
      [0.05, 2],
      [0.123457, 1.5],
      [1.0000104, 1.7],
    ] as const) {
      const range = await read({ durationS: 2, fromS, toS })
      const off = Math.round(fromS * 48_000)
      expect(range.startS).toBe(off / 48_000)
      expect(range.planes[0]!.length).toBe(Math.round(toS * 48_000) - off)
      for (let ch = 0; ch < 2; ch++) {
        const a = range.planes[ch]!
        const b = whole.planes[ch]!
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[off + i]) throw new Error(`ch ${ch} sample ${off + i} differs: ${a[i]} vs ${b[off + i]}`)
        }
      }
    }
  })

  it('pins the read rate to the export mix rate', () => {
    const render = readFileSync(fileURLToPath(new URL('./export/audioRender.ts', import.meta.url)), 'utf8')
    expect(DECODE_SAMPLE_RATE).toBe(48_000)
    expect(render).toContain('export const EXPORT_SAMPLE_RATE = 48000')
  })
})

// ---------------------------------------------------------------------------
// EA-2. An mp3's encoder and decoder delay come off the head.

/** An ID3v2 tag holding `size` bytes of junk, sync-like 0xFF bytes included. */
function id3(size: number): number[] {
  const body = Array.from({ length: size }, (_, i) => (i % 7 === 0 ? 0xff : i % 7 === 1 ? 0xfb : 0x41))
  const ss = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]
  return [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, ...ss, ...body]
}

/** An MPEG-1 Layer III Info frame (stereo, 128 kb/s) carrying an encoder tag with this delay. */
function infoFrame(rate: 44_100 | 48_000, delay: number, vendor = 'LAME3.100', tag = 'Info'): number[] {
  const frame = new Array<number>(417).fill(0)
  frame.splice(0, 4, 0xff, 0xfb, rate === 44_100 ? 0x90 : 0x94, 0x00)
  const at = 36
  const put = (o: number, bytes: number[]) => bytes.forEach((b, i) => (frame[o + i] = b))
  put(at, [...tag].map((c) => c.charCodeAt(0)))
  put(at + 4, [0, 0, 0, 0x0f]) // frames, bytes, seek table, quality
  const lame = at + 8 + 4 + 4 + 100 + 4
  put(lame, [...vendor].map((c) => c.charCodeAt(0)))
  const padding = 1000
  put(lame + 21, [delay >> 4, ((delay & 0x0f) << 4) | (padding >> 8), padding & 0xff])
  return frame
}

/** An mp3 holding a single full scale click, `at` frames into the decoder's output. */
function clickMp3(rate: 44_100 | 48_000, at: number, head: number[]): FakeFile {
  return {
    format: 'MP3',
    rate,
    channels: 1,
    packet: 1152,
    first: 0,
    packets: Math.ceil((2 * rate) / 1152),
    value: (_ch, n) => (n === at ? 1 : 0),
    bytes: new Uint8Array([...head, 0xff, 0xfb, 0x90, 0x00]),
  }
}

/** Where the loudest sample of a plane is. */
const peakAt = (x: Float32Array): number => x.reduce((best, v, i) => (Math.abs(v) > Math.abs(x[best]!) ? i : best), 0)

describe('an mp3 plays on time: its encoder and decoder delay are trimmed', () => {
  it('⛔ a click at 1.000 s of a 44.1 kHz mp3 lands at sample 48000', async () => {
    // LAME's 576 samples plus the decoder's 529 sit in front of the sound, which
    // is exactly where his mp3 music and vine booms played 25 ms late.
    file = clickMp3(44_100, 44_100 + 576 + MP3_DECODER_DELAY, [...id3(3000), ...infoFrame(44_100, 576)])
    const plane = (await read({ durationS: 2 })).planes[0]!
    expect(Math.abs(peakAt(plane) - 48_000)).toBeLessThanOrEqual(1)
    // The old read put it 1105 samples of 44.1 kHz late: 1203 samples here.
    expect(Math.abs(plane[48_000 + 1203]!)).toBeLessThan(0.01)
  })

  it('a range read of the same mp3 puts the click in the same place', async () => {
    file = clickMp3(44_100, 44_100 + 576 + MP3_DECODER_DELAY, [...id3(3000), ...infoFrame(44_100, 576)])
    const whole = (await read({ durationS: 2 })).planes[0]!
    const range = await read({ durationS: 2, fromS: 0.9, toS: 1.2 })
    const off = Math.round(0.9 * 48_000)
    expect(peakAt(range.planes[0]!) + off).toBe(48_000)
    for (let i = 0; i < range.planes[0]!.length; i++) expect(range.planes[0]![i]).toBe(whole[off + i])
  })

  it('a 48 kHz mp3 (his LUKE track, his vine boom) is trimmed without being resampled', async () => {
    file = clickMp3(48_000, 48_000 + 576 + MP3_DECODER_DELAY, [...id3(200), ...infoFrame(48_000, 576)])
    const r = await read({ durationS: 2 })
    expect(r.sampleRate).toBe(48_000)
    expect(peakAt(r.planes[0]!)).toBe(48_000)
    expect(r.planes[0]![48_000]).toBe(1)
  })

  it('with no encoder tag, only the decoder delay it is sure of is trimmed', async () => {
    file = clickMp3(44_100, 44_100 + MP3_DECODER_DELAY, id3(100))
    const plane = (await read({ durationS: 2 })).planes[0]!
    expect(Math.abs(peakAt(plane) - 48_000)).toBeLessThanOrEqual(1)
  })

  it('the waveform of an mp3 sits under its sound too', async () => {
    file = clickMp3(48_000, 48_000 + 576 + MP3_DECODER_DELAY, [...id3(200), ...infoFrame(48_000, 576)])
    const r = await demuxPeaks(new Blob([file.bytes]), 2, 2000)
    if (r.kind !== 'peaks') throw new Error(`expected peaks, got ${r.kind}`)
    // 2000 buckets of 1 ms: the click is in bucket 1000, nowhere else.
    expect(r.peaks[1000]).toBe(1)
    expect(r.peaks[1023]).toBe(0)
  })

  it('a file that is not an MP3 is never trimmed', async () => {
    // The same click in an MP4 (an AAC track): the container's own timestamps
    // already say where it plays.
    file = { ...clickMp3(48_000, 48_000, []), format: 'MP4' }
    expect(peakAt((await read({ durationS: 2 })).planes[0]!)).toBe(48_000)
  })
})

describe('the mp3 delay is read the way ffmpeg reads it', () => {
  const frames = (bytes: number[]) => mp3DelayFromFrames(new Uint8Array(bytes))

  it('LAME, Lavf and Lavc tags: encoder delay plus the 529 of the decoder', () => {
    expect(frames(infoFrame(44_100, 576))).toBe(1105)
    expect(frames(infoFrame(44_100, 576, 'Lavf58.76'))).toBe(1105)
    expect(frames(infoFrame(48_000, 1152, 'Lavc61.3.'))).toBe(1152 + 529)
    expect(frames(infoFrame(44_100, 576, 'LAME3.100', 'Xing'))).toBe(1105)
  })

  it('an encoder ffmpeg does not trust, or no tag at all, is the decoder delay alone', () => {
    expect(frames(infoFrame(44_100, 576, 'GOGO1.00'))).toBe(529)
    expect(frames([0xff, 0xfb, 0x90, 0x00, ...new Array<number>(500).fill(0x11)])).toBe(529)
  })

  it('junk before the first frame is skipped; no frame at all is no MP3, and no trim', () => {
    expect(frames([0x00, 0x00, 0xff, 0x00, ...infoFrame(44_100, 576)])).toBe(1105)
    expect(frames(Array.from({ length: 600 }, (_, i) => i & 0x7f))).toBe(0)
  })

  it('reads past ID3 tags of any size, album art included, through the file not into memory', async () => {
    const bytes = new Uint8Array([...id3(70_000), ...id3(10), ...infoFrame(44_100, 576)])
    const reads: number[] = []
    const skip = await mp3HeadSkip(async (offset, length) => {
      reads.push(length)
      return bytes.subarray(offset, offset + length)
    })
    expect(skip).toBe(1105)
    // Two 10 byte tag headers, one that is not a tag, and one scan of the frames.
    expect(Math.max(...reads)).toBeLessThanOrEqual(16_384)
  })
})
