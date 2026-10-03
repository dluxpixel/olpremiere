import { describe, expect, it, vi } from 'vitest'

import { freshSamples, peakOfNewest } from './recordingMonitor'

// ⛔ MIC-3, 2026-09-30: no peak missed between two looks at the meter. It used
// to read the last 1024 samples (21 ms) each frame, so anything that happened
// while a frame ran long was simply never seen, and the clip light had nothing
// to latch on. Now it reads everything that arrived since it last looked.

describe('freshSamples: everything that arrived since the last look', () => {
  it('the first look reads the whole window', () => {
    expect(freshSamples(null, 3, 48_000, 16_384)).toBe(16_384)
  })

  it('a normal frame reads that frame of audio plus a small margin', () => {
    // 1/60 s at 48 kHz is 800 samples.
    const n = freshSamples(1, 1 + 1 / 60, 48_000, 16_384)
    expect(n).toBeGreaterThanOrEqual(800)
    expect(n).toBeLessThan(800 + 1024)
  })

  it('a frame that ran long (a quarter second) still reads all of it', () => {
    expect(freshSamples(1, 1.25, 48_000, 16_384)).toBeGreaterThanOrEqual(12_000)
  })

  it('never asks for more than the window holds', () => {
    expect(freshSamples(1, 9, 48_000, 16_384)).toBe(16_384)
  })
})

describe('peakOfNewest', () => {
  it('finds a single-sample peak anywhere in the new part, and ignores what came before', () => {
    const buf = new Float32Array(16_384)
    buf[100] = 0.99 // old: before the new part
    buf[16_384 - 700] = -0.93 // new, and negative
    expect(peakOfNewest(buf, 1000)).toBeCloseTo(0.93, 6)
  })

  it('a peak that lands between two 60 fps looks is seen by the second one', () => {
    // The window at the second look, oldest first. The transient arrived 12 ms
    // ago, which a 1024-sample read at 48 kHz (21 ms) would also catch, but at
    // 30 fps, or a frame that ran long, the old read missed it outright.
    const buf = new Float32Array(16_384)
    buf[16_384 - Math.round(0.03 * 48_000)] = 0.97 // 30 ms ago
    const frame30fps = freshSamples(1, 1 + 1 / 30, 48_000, buf.length)
    expect(peakOfNewest(buf, frame30fps)).toBeCloseTo(0.97, 6)
    expect(peakOfNewest(buf, 1024)).toBe(0) // what the old read saw
  })
})

// ⛔ MIC-3, measured in the real app 2026-10-01: a true stereo input peaking at
// -0.5 dBFS on one side never lit the clip light. An AnalyserNode mixes its
// input down to mono first, so the meter read (L + R) / 2. A mic on input 1 of
// an interface, input 2 empty, reads 6 dB low that way and clips unseen.
describe('the meter reads the hotter side, not the average', () => {
  // A fake graph that keeps the spec's rule: an analyser fed the whole source
  // sees the down-mix; one fed a single splitter output sees that channel.
  const sides = { L: 0, R: 0 }
  class FakeAnalyser {
    fftSize = 2048
    channel: 'L' | 'R' | 'mix' = 'mix'
    getFloatTimeDomainData(buf: Float32Array) {
      const v = this.channel === 'mix' ? (sides.L + sides.R) / 2 : sides[this.channel]
      buf.fill(0)
      buf[buf.length - 10] = v
    }
  }
  class FakeContext {
    currentTime = 1
    sampleRate = 48_000
    destination = {}
    resume = () => Promise.resolve()
    setSinkId = () => Promise.resolve()
    close = () => Promise.resolve()
    createMediaStreamSource = () => ({
      connect: (node: unknown) => {
        if (node instanceof FakeAnalyser) node.channel = 'mix'
      },
    })
    createChannelSplitter = () => ({
      connect: (node: unknown, out: number) => {
        if (node instanceof FakeAnalyser) node.channel = out === 0 ? 'L' : 'R'
      },
    })
    createAnalyser = () => new FakeAnalyser()
    createGain = () => ({ gain: { value: 0, setTargetAtTime: () => undefined }, connect: () => undefined })
  }

  it('one side at -0.5 dBFS and the other empty reads -0.5 dBFS, over the clip line', async () => {
    const track = { label: 'Interface In 1', getSettings: () => ({ latency: 0.01 }), stop: () => undefined }
    vi.stubGlobal('AudioContext', FakeContext)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) },
    })
    try {
      const { createMonitorGraph } = await import('./recordingMonitor')
      const { CLIP_AMP } = await import('./takeAudio')
      const g = await createMonitorGraph(null, () => ({}))
      sides.L = 10 ** (-0.5 / 20)
      sides.R = 0
      expect(g.level()).toBeGreaterThanOrEqual(CLIP_AMP)
      expect(20 * Math.log10(g.level())).toBeCloseTo(-0.5, 6)
      expect(g.inputLabel).toBe('Interface In 1')
      expect(g.inputLatencyS).toBe(0.01)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
