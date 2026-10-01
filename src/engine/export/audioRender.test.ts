// The export's audio, on time and under the ceiling, through the real
// planAudioMix with a stand-in for the browser's OfflineAudioContext.
//
// The backtest of 2026-09-29 measured clicks in his real exports against the
// picture: every sound 2.67 ms late (the old limiter's oversampling), and every
// voiceover on an Auto-level track 8.67 ms late (the compressor's 6 ms on top).
// The stand-in below delays a DynamicsCompressor by exactly what Chromium's does
// (288 samples at 48 kHz, measured in this Electron), so these tests hold the
// render to the same arithmetic the real one has to get right.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { LIMIT_CEILING, TruePeakLimiter } from '../audioLimiter'
import { measureLoudness } from '../loudness'
import type { Clip, MediaAsset, Sequence, Track } from '../types'

const SR = 48000
const COMPRESSOR_FRAMES = 288

beforeAll(() => {
  ;(globalThis as { AudioEncoder?: unknown }).AudioEncoder ??= class {}
})

// --- a small offline mixer, standing in for OfflineAudioContext -------------

interface FakeBuffer {
  sampleRate: number
  length: number
  numberOfChannels: number
  getChannelData(c: number): Float32Array
}
const buffers = new Map<string, FakeBuffer>()
let delaysMade = 0

class Param {
  private set = false
  constructor(public value: number) {}
  setValueAtTime(v: number): void {
    if (!this.set) this.value = v
    this.set = true
  }
  linearRampToValueAtTime(): void {}
}
class Node {
  outs: Node[] = []
  connect<T extends Node>(n: T): T {
    this.outs.push(n)
    return n
  }
  disconnect(): void {}
}
class Gain extends Node {
  gain = new Param(1)
}
class Delay extends Node {
  delayTime = new Param(0)
}
class Panner extends Node {
  pan = new Param(0)
}
class Compressor extends Node {
  threshold = new Param(0)
  knee = new Param(0)
  ratio = new Param(1)
  attack = new Param(0)
  release = new Param(0)
}
class Source extends Node {
  buffer: FakeBuffer | null = null
  playbackRate = new Param(1)
  at: [number, number, number] | null = null
  start(when: number, offset: number, duration: number): void {
    this.at = [when, offset, duration]
  }
}
class FakeOfflineContext {
  destination = new Node()
  private sources: Source[] = []
  constructor(
    private channels: number,
    private frames: number,
    readonly sampleRate: number,
  ) {}
  createGain = () => new Gain()
  createDelay = () => {
    delaysMade++
    return new Delay()
  }
  createStereoPanner = () => new Panner()
  createDynamicsCompressor = () => new Compressor()
  createBufferSource = () => {
    const s = new Source()
    this.sources.push(s)
    return s
  }
  async startRendering() {
    const out = Array.from({ length: this.channels }, () => new Float32Array(this.frames))
    // Every path from a source to the destination: the gains multiply, the
    // delays add, a compressor adds Chromium's 288 samples (and no dynamics:
    // these signals are far below any threshold that matters here).
    const walk = (n: Node, gain: number, delay: number, hit: (g: number, d: number) => void): void => {
      if (n === this.destination) return hit(gain, delay)
      let g = gain
      let d = delay
      if (n instanceof Gain) g *= n.gain.value
      if (n instanceof Delay) d += Math.round(n.delayTime.value * this.sampleRate)
      if (n instanceof Compressor) d += COMPRESSOR_FRAMES
      for (const o of n.outs) walk(o, g, d, hit)
    }
    for (const s of this.sources) {
      if (!s.buffer || !s.at) continue
      const buf = s.buffer
      const [when, offset, duration] = s.at
      const w = Math.round(when * this.sampleRate)
      const o = Math.round(offset * buf.sampleRate)
      const len = Math.round(duration * buf.sampleRate)
      walk(s, 1, 0, (g, d) => {
        for (let c = 0; c < this.channels; c++) {
          const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
          for (let k = 0; k < len; k++) {
            const at = w + d + k
            if (at >= 0 && at < this.frames && o + k < src.length) out[c][at] += src[o + k] * g
          }
        }
      })
    }
    return { getChannelData: (c: number) => out[c] }
  }
}
vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)

vi.mock('../audio', async () => {
  const actual = await vi.importActual<typeof import('../audio')>('../audio')
  return { ...actual, clipAudioBuffer: vi.fn(async (_c: Clip, a: MediaAsset) => buffers.get(a.id) ?? null) }
})
const { planAudioMix, AUDIO_SEGMENT_FRAMES } = await import('./audioRender')

// --- the timeline --------------------------------------------------------------

function source(id: string, data: Float32Array): MediaAsset {
  buffers.set(id, { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data })
  return { id, name: `${id}.wav`, kind: 'audio', blobKey: `asset/${id}`, durationS: data.length / SR, hasAudio: true, hasVideo: false }
}
const clip = (assetId: string, startS: number, lenS: number): Clip =>
  ({
    id: `${assetId}@${startS}`,
    assetId,
    startS,
    inS: 0,
    outS: lenS,
    speed: 1,
    enabled: true,
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
  }) as unknown as Clip
const track = (id: string, clips: Clip[], extra: Partial<Track> = {}): Track =>
  ({ id, kind: 'audio', name: id, muted: false, solo: false, locked: false, volumeDb: 0, pan: 0, clips, ...extra }) as Track
const sequence = (tracks: Track[], durationS: number): Sequence =>
  ({ id: 's', name: 'S', fps: 30, width: 1080, height: 1920, durationS, tracks, markers: [] }) as unknown as Sequence

/** A one-sample click at the very start. */
const click = (amp = 0.5): Float32Array => {
  const x = new Float32Array(SR / 10)
  x[0] = amp
  return x
}

async function renderAll(seq: Sequence, assets: Record<string, MediaAsset>, endS: number, target: number | null = null) {
  const plan = await planAudioMix(seq, assets, 0, endS, undefined, { loudnessTargetLufs: target })
  if (!plan) throw new Error('no plan')
  const segments: Float32Array[][] = []
  await plan.render((cd) => {
    segments.push(cd)
  })
  const total = segments.reduce((n, s) => n + s[0].length, 0)
  const joined = [0, 1].map((c) => {
    const out = new Float32Array(total)
    let o = 0
    for (const s of segments) {
      out.set(s[c], o)
      o += s[c].length
    }
    return out
  })
  return { segments, joined, info: plan.info }
}

const nonZero = (x: Float32Array): number[] => {
  const at: number[] = []
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) at.push(i)
  return at
}

describe('the export mix lands on time', () => {
  it('puts every sound on its exact sample: no master delay, and an Auto-level track no later than the rest', async () => {
    const a = source('a', click())
    const v = source('v', click())
    const seq = sequence(
      [
        track('music', [clip('a', 1, 0.1), clip('a', 65, 0.1)]),
        // His voiceover tracks run Auto-level; this one used to come out 6 ms late.
        track('voice', [clip('v', 2, 0.1), clip('v', 31.5, 0.1)], { autoLevel: 'medium' }),
      ],
      70,
    )
    const { joined, segments, info } = await renderAll(seq, { a, v }, 70)
    expect(nonZero(joined[0])).toEqual([1 * SR, 2 * SR, 31.5 * SR, 65 * SR])
    // The music click is untouched; the voice click carries Auto-level's makeup gain.
    expect(joined[0][1 * SR]).toBe(0.5)
    expect(joined[0][2 * SR]).toBeCloseTo(0.5 * 10 ** (4 / 20), 6)
    // The segments keep the sizes the worker's AAC framing depends on.
    expect(segments.map((s) => s[0].length)).toEqual([AUDIO_SEGMENT_FRAMES, AUDIO_SEGMENT_FRAMES, info.totalFrames - 2 * AUDIO_SEGMENT_FRAMES])
  })

  it('lines the tracks up by starting the plain ones later, never with a DelayNode', async () => {
    // Measured in this Electron: a DelayNode followed by a StereoPanner drops its
    // last 288 samples once the sources have finished, so the last clip on a
    // plain track lost its final 6 ms. Starting the sources later has no tail.
    const steady = new Float32Array(SR).fill(0.25)
    const s = source('s', steady)
    const v = source('v2', click())
    delaysMade = 0
    const seq = sequence([track('sfx', [clip('s', 4, 1)]), track('voice', [clip('v2', 1, 0.1)], { autoLevel: 'low' })], 6)
    const { joined } = await renderAll(seq, { s, v2: v }, 6)
    expect(delaysMade).toBe(0)
    const at = nonZero(joined[0]).filter((i) => i >= 4 * SR)
    expect(at[0]).toBe(4 * SR)
    expect(at[at.length - 1]).toBe(5 * SR - 1)
  })

  it('leaves a mix under the ceiling exactly as it was mixed, with Platform loudness off', async () => {
    // "Off keeps your mix as it is." A busy bed, peaking 4 dB under the ceiling.
    const bed = new Float32Array(SR * 40)
    for (let i = 0; i < bed.length; i++) bed[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.1 * Math.sin(i * 0.9)
    const b = source('b', bed)
    const { joined } = await renderAll(sequence([track('bed', [clip('b', 0, 40)])], 40), { b }, 40)
    let changed = 0
    for (let i = 0; i < bed.length; i++) if (joined[0][i] !== bed[i] || joined[1][i] !== bed[i]) changed++
    expect(changed).toBe(0)
  })
})

describe('the master limiter in the export', () => {
  it('is the same limiter, run once over the whole mix, across the 30 s segment seam', async () => {
    // A loud tone straddling the first segment boundary: the limiter's state
    // has to carry over, or the peak would be handled twice, differently.
    const tone = new Float32Array(SR * 4)
    for (let i = 0; i < tone.length; i++) tone[i] = 1.6 * Math.sin((2 * Math.PI * 440 * i) / SR)
    const t = source('t', tone)
    const { joined } = await renderAll(sequence([track('t', [clip('t', 28, 4)])], 34), { t }, 34)

    // The same signal through one limiter in one go, delay removed.
    const raw = new Float32Array(34 * SR)
    raw.set(tone, 28 * SR)
    const lim = new TruePeakLimiter(2, SR)
    const once = [new Float32Array(raw.length + lim.latency), new Float32Array(raw.length + lim.latency)]
    const padded = new Float32Array(raw.length + lim.latency)
    padded.set(raw)
    lim.process([padded, padded], once, padded.length)
    for (let i = 0; i < raw.length; i++) {
      if (joined[0][i] !== once[0][i + lim.latency]) throw new Error(`differs at ${i}`)
    }
    let peak = 0
    for (const v of joined[0]) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(LIMIT_CEILING)
  })
})

describe('Platform loudness', () => {
  // His answer, 2026-09-30: "Yes, on by default". Green left the app at
  // -17.1 LUFS and played three decibels under everything in the feed.
  it('brings a quiet mix up to -14 LUFS', async () => {
    const quiet = new Float32Array(SR * 12)
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.05 * Math.sin((2 * Math.PI * 1000 * i) / SR)
    const q = source('q', quiet)
    const seq = sequence([track('q', [clip('q', 0, 12)])], 12)
    const before = measureLoudness((await renderAll(seq, { q }, 12)).joined, SR).lufs!
    const after = measureLoudness((await renderAll(seq, { q }, 12, -14)).joined, SR).lufs!
    expect(before).toBeLessThan(-20)
    expect(after).toBeCloseTo(-14, 1)
  })

  it('brings a loud one down, and the limiter, not a clipper, holds what the gain pushes up', async () => {
    const loud = new Float32Array(SR * 12)
    for (let i = 0; i < loud.length; i++) {
      // speech-like: quiet body with sharp peaks, so the gain lifts the peaks past the ceiling
      loud[i] = 0.06 * Math.sin((2 * Math.PI * 300 * i) / SR) * (1 + 6 * Math.max(0, Math.sin((2 * Math.PI * 2 * i) / SR)) ** 40)
    }
    const l = source('l', loud)
    const { joined } = await renderAll(sequence([track('l', [clip('l', 0, 12)])], 12), { l }, 12, -14)
    let peak = 0
    for (const v of joined[0]) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(LIMIT_CEILING)
    expect(measureLoudness(joined, SR).lufs!).toBeCloseTo(-14, 0)
  })
})
