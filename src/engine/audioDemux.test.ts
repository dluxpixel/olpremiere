// His words, 2026-09-29: *"make sure, because I input a lot of videos from my
// iPhone, that the iPhone videos are fucking perfect, especially with the
// export."* The backtest found every iPhone clip's sound 46.67 ms late against
// its own picture, and his OBS recordings 21 ms late: the read subtracted the AAC
// track's first timestamp, which is the encoder's priming sitting BEFORE zero.
//
// No WebCodecs in this runner, so mediabunny is stood in for by a track shaped
// like his iPhone clip: 48 kHz AAC, 1024 frames a packet, the first packet at
// -0.044 s (2112 frames of priming, the edit list already applied). Every packet
// holds one constant value, so where a value lands says which packet landed there.

import { describe, expect, it, vi } from 'vitest'

const RATE = 48_000
const PACKET = 1024
const PRIMING = 2112
/** Packet k starts here, in seconds. */
const packetStart = (k: number): number => (k * PACKET - PRIMING) / RATE
/** Packet k is filled with this value: the priming packets are 0.1 and 0.2. */
const packetValue = (k: number): number => (k + 1) / 10
const PACKETS = 12

function fakeSample(k: number) {
  return {
    timestamp: packetStart(k),
    duration: PACKET / RATE,
    numberOfFrames: PACKET,
    numberOfChannels: 1,
    copyTo(dest: Float32Array, opts: { frameOffset?: number; frameCount?: number }) {
      const count = opts.frameCount ?? PACKET - (opts.frameOffset ?? 0)
      if (count > dest.length) throw new RangeError('copyTo does not truncate')
      dest.fill(packetValue(k), 0, count)
    },
    close() {},
  }
}

vi.mock('mediabunny', () => {
  const track = {
    canDecode: async () => true,
    getSampleRate: async () => RATE,
    getNumberOfChannels: async () => 1,
    computeDuration: async () => packetStart(PACKETS),
    getFirstTimestamp: async () => packetStart(0),
  }
  class Input {
    getPrimaryAudioTrack = async () => track
    dispose() {}
  }
  class BlobSource {}
  class AudioSampleSink {
    async *samples(start = -Infinity, end = Infinity) {
      for (let k = 0; k < PACKETS; k++) {
        const s = fakeSample(k)
        if (s.timestamp + s.duration <= start) continue
        if (s.timestamp >= end) return
        yield s
      }
    }
  }
  return { ALL_FORMATS: [], Input, BlobSource, AudioSampleSink }
})

const { demuxAudio, demuxPeaks } = await import('./audioDemux')

const blob = new Blob([new Uint8Array(1)])
const DURATION = 0.2

async function planeOf(req: Parameters<typeof demuxAudio>[1]): Promise<Float32Array> {
  const r = await demuxAudio(blob, req)
  if (r.kind !== 'pcm') throw new Error(`expected pcm, got ${r.kind}`)
  return r.planes[0]!
}

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
    const r = await demuxPeaks(blob, DURATION, 96)
    if (r.kind !== 'peaks') throw new Error(`expected peaks, got ${r.kind}`)
    // Bucket 0 is frames 0 to 99, all of them packet 2.
    expect(r.peaks[0]).toBeCloseTo(packetValue(2), 6)
  })
})
