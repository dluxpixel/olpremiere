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
/** How many offline renders ran: one per segment per pass. */
let rendersMade = 0
/** Called after each offline render, so a test can act between two segments. */
let afterRender: (() => void) | null = null

class Param {
  private set = false
  /** The automation, so a clip's fades (and the 2 ms de-click) shape the mix as they would in the browser. */
  events: { t: number; v: number; ramp: boolean }[] = []
  constructor(public value: number) {}
  setValueAtTime(v: number, t = 0): void {
    if (!this.set) this.value = v
    this.set = true
    this.events.push({ t, v, ramp: false })
  }
  linearRampToValueAtTime(v: number, t = 0): void {
    this.events.push({ t, v, ramp: true })
  }
  /** The value at context time t: holds after a set, ramps linearly into a ramp's end. */
  at(t: number): number {
    let pt = 0
    let pv = this.value
    for (const e of [...this.events].sort((a, b) => a.t - b.t)) {
      if (e.t <= t) {
        pt = e.t
        pv = e.v
        continue
      }
      return e.ramp ? pv + ((e.v - pv) * (t - pt)) / (e.t - pt) : pv
    }
    return pv
  }
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
    rendersMade++
    afterRender?.()
    const out = Array.from({ length: this.channels }, () => new Float32Array(this.frames))
    // Every path from a source to the destination: the gains multiply, the
    // delays add, a compressor adds Chromium's 288 samples (and no dynamics:
    // these signals are far below any threshold that matters here).
    let clipGain: Gain | null = null
    const walk = (n: Node, gain: number, delay: number, hit: (g: number, d: number) => void): void => {
      if (n === this.destination) return hit(gain, delay)
      let g = gain
      let d = delay
      // The clip's own gain is applied per sample below, automation and all.
      if (n instanceof Gain && n !== clipGain) g *= n.gain.value
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
      clipGain = s.outs[0] instanceof Gain ? s.outs[0] : null
      const cg = clipGain
      walk(s, 1, 0, (g, d) => {
        for (let c = 0; c < this.channels; c++) {
          const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
          for (let k = 0; k < len; k++) {
            const at = w + d + k
            const env = cg ? cg.gain.at((w + k) / this.sampleRate) : 1
            if (at >= 0 && at < this.frames && o + k < src.length) out[c][at] += src[o + k] * g * env
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
  return {
    ...actual,
    clipAudioBuffer: vi.fn(async (_c: Clip, a: MediaAsset) => buffers.get(a.id) ?? null),
    // These tests pin the master chain's timing to the sample with a click on
    // each clip's FIRST sample, which the 2 ms de-click at a hard edge would fade
    // away. The de-click itself is pinned in audio.test.ts.
    clipEdges: () => undefined,
  }
})
const { planAudioMix, AUDIO_SEGMENT_FRAMES, KEEP_MEASURED_MIX_FRAMES, audioFramesFor } = await import('./audioRender')

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

describe('⛔ Platform loudness renders a mix that fits only once', () => {
  // The measure pass and the export pass each rendered the whole mix, every clip, stretch and effect,
  // to arrive at the same samples twice (export audit, 2026-10-06).
  it('a Short is rendered once and the measured samples are what goes out', async () => {
    const tone = new Float32Array(SR * 40)
    // Quiet, but within the boost the platform gain allows, so it really lands on the target.
    for (let i = 0; i < tone.length; i++) tone[i] = 0.12 * Math.sin((2 * Math.PI * 440 * i) / SR)
    const t = source('t', tone)
    const seq = sequence([track('t', [clip('t', 0, 40)])], 40)
    rendersMade = 0
    const { joined, segments } = await renderAll(seq, { t }, 40, -14)
    // 40 s is two segments: two renders, not four.
    expect(segments).toHaveLength(2)
    expect(rendersMade).toBe(2)
    expect(measureLoudness(joined, SR).lufs!).toBeCloseTo(-14, 1)
  })

  it('⛔ a cancel during the measuring pass stops it at the next segment', async () => {
    // Platform loudness is on by default, and the measuring render had no check: Cancel during
    // "Mixing the sound" waited for all of it, about 20 segments for a 10 minute video, before the
    // first segment reached the page's check (export review N1, 2026-10-08).
    const tone = new Float32Array(SR * 100)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.12 * Math.sin((2 * Math.PI * 440 * i) / SR)
    const t = source('t', tone)
    const seq = sequence([track('t', [clip('t', 0, 100)])], 100)
    const ctrl = new AbortController()
    const plan = await planAudioMix(seq, { t }, 0, 100, undefined, { loudnessTargetLufs: -14, signal: ctrl.signal })
    if (!plan) throw new Error('no plan')
    let delivered = 0
    rendersMade = 0
    // Cancel pressed while the first of four segments is being measured.
    afterRender = () => ctrl.abort()
    try {
      await expect(
        plan.render(() => {
          delivered++
        }),
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      afterRender = null
    }
    expect(rendersMade).toBe(1)
    expect(delivered).toBe(0)
  })

  it('keeps at most 3 minutes, so memory stays bounded however long the video', () => {
    // A longer mix renders twice and holds two segments, as before. (Rendering one here to prove
    // it took 25 s of this suite, for the same `totalFrames <= KEEP_MEASURED_MIX_FRAMES` branch.)
    expect(KEEP_MEASURED_MIX_FRAMES).toBeLessThanOrEqual(3 * 60 * SR)
    // A 60 s Short fits with room to spare.
    expect(KEEP_MEASURED_MIX_FRAMES).toBeGreaterThanOrEqual(60 * SR)
  })
})

describe('the sound is as long as the picture at the rate the file is made at', () => {
  it('⛔ a 240 fps timeline exported at 60 has sound the length of the 60 fps video, to the sample', async () => {
    const a = source('slowmo', click())
    const seq = { ...sequence([track('t', [clip('slowmo', 0, 0.1)])], 2), fps: 240 } as Sequence
    // 1.01 s: 61 frames at 60 (1.01667 s), but 243 at 240 (1.0125 s). The video is made at 60.
    const plan = await planAudioMix(seq, { slowmo: a }, 0, 1.01, undefined, { fps: 60 })
    expect(plan!.info.totalFrames).toBe(audioFramesFor(1.01, 60, SR))
    expect(Math.abs(plan!.info.totalFrames - (61 / 60) * SR)).toBeLessThanOrEqual(1)
  })
})
