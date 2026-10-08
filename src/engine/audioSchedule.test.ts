// scheduleAudio on a stand-in context: what it starts, where, and how it goes.
//
// ⛔ AU-17. The live mixer had no behavioural test at all: the checks beside it
// read audio.ts as text and looked for strings in an order, which passes on a
// wrong offset and fails on a harmless rename. This stand-in records every
// source start, and its gains work their automation out the way Web Audio does,
// so these read what the graph would actually sound like at a given moment.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeClip, makeSeq, makeTrack } from '../components/timelineTestFixtures'
import { DUCK_ATTACK_S, DUCK_DB } from './ducking'
import type { MediaAsset, Track } from './types'

const { decode, noisePass } = vi.hoisted(() => ({ decode: vi.fn(), noisePass: vi.fn() }))
vi.mock('../state/persistence', () => ({ getBlob: async () => new Blob(['bytes']) }))
// The real lanes: only the reads themselves are stood in for.
vi.mock('./audioDecodeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audioDecodeClient')>()),
  decodeAudioOffThread: decode,
  peaksOffThread: vi.fn(),
}))
// The noise pass, stood in for so a test can say how long it takes.
vi.mock('./denoiseClient', () => ({ denoiseOffThread: noisePass }))
// No worklets in node: the master limiter stays out, as it does until it loads.
vi.mock('./limiterNode', () => ({ createLimiterNode: () => Promise.reject(new Error('no worklet in node')) }))

type Call = [string, ...number[]]
interface Ev {
  kind: 'set' | 'ramp' | 'target'
  v: number
  t: number
  tau?: number
}

/**
 * An AudioParam that keeps its events and answers what its value is at a time,
 * by the Web Audio rules: a linear ramp runs from the PREVIOUS event to its own,
 * a target eases from wherever the value was, and cancelAndHoldAtTime only adds
 * an event when it cuts through a ramp or follows a target.
 */
class Param {
  calls: Call[] = []
  events: Ev[] = []
  constructor(public value: number) {}
  private add(e: Ev) {
    this.events.push(e)
    this.events.sort((a, b) => a.t - b.t)
  }
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t])
    this.add({ kind: 'set', v, t })
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['ramp', v, t])
    this.add({ kind: 'ramp', v, t })
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    this.calls.push(['target', v, t, tau])
    this.add({ kind: 'target', v, t, tau })
  }
  cancelScheduledValues(t: number) {
    this.calls.push(['cancel', t])
    this.events = this.events.filter((e) => e.t < t)
  }
  cancelAndHoldAtTime(tc: number) {
    this.calls.push(['hold', tc])
    const after = this.events.find((e) => e.t > tc)
    const before = this.events.filter((e) => e.t <= tc).at(-1)
    const v = this.at(tc)
    this.events = this.events.filter((e) => e.t <= tc)
    if (after?.kind === 'ramp') this.add({ kind: 'ramp', v, t: tc })
    else if (!after && before?.kind === 'target') this.add({ kind: 'set', v, t: tc })
  }
  /** The value at time `t`. */
  at(t: number): number {
    let v = this.value
    let vt = -Infinity
    let target: Ev | null = null
    const eased = (x: number) => (target ? target.v + (v - target.v) * Math.exp(-(x - target.t) / target.tau!) : v)
    for (const e of this.events) {
      if (e.t > t) {
        if (e.kind !== 'ramp') return eased(t)
        if (!Number.isFinite(vt)) return t < e.t ? v : e.v
        return v + ((e.v - v) * (t - vt)) / (e.t - vt)
      }
      if (target) {
        v = eased(e.t)
        target = null
      }
      if (e.kind === 'target') target = e
      else v = e.v
      vt = e.t
    }
    return eased(t)
  }
}

class Node {
  out: Node[] = []
  disconnected = false
  connect(n: Node) {
    this.out.push(n)
    return n
  }
  disconnect() {
    this.disconnected = true
  }
}
class Gain extends Node {
  gain = new Param(1)
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'
}
class Panner extends Node {
  pan = new Param(0)
}
class Source extends Node {
  buffer: unknown = null
  playbackRate = new Param(1)
  started: [number, number, number] | null = null
  stoppedAt: number | null = null
  start(when: number, offset: number, duration: number) {
    this.started = [when, offset, duration]
  }
  stop(when = 0) {
    this.stoppedAt = when
  }
}
class Compressor extends Node {
  threshold = new Param(0)
  knee = new Param(0)
  ratio = new Param(1)
  attack = new Param(0)
  release = new Param(0)
}

class FakeContext {
  currentTime = 10
  sampleRate = 48_000
  state = 'running'
  destination = new Node()
  gains: Gain[] = []
  panners: Panner[] = []
  sources: Source[] = []
  resume = () => Promise.resolve()
  createGain = () => {
    const g = new Gain()
    this.gains.push(g)
    return g
  }
  createStereoPanner = () => {
    const p = new Panner()
    this.panners.push(p)
    return p
  }
  createBufferSource = () => {
    const s = new Source()
    this.sources.push(s)
    return s
  }
  createDynamicsCompressor = () => new Compressor()
  createChannelSplitter = () => new Node()
  createAnalyser = () => Object.assign(new Node(), { fftSize: 0, smoothingTimeConstant: 0 })
  createBuffer = (channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (ch: number) => data[ch]!,
      copyToChannel: (src: Float32Array, ch: number) => data[ch]!.set(src),
    }
  }
}
vi.stubGlobal('AudioContext', FakeContext)

const audio = await import('./audio')
const {
  scheduleAudio,
  ensureAudioContext,
  ensureMasterChain,
  getAudioRange,
  rangeCacheBytesForTests,
  GRAPH_FADE_S,
  MIX_GLIDE_S,
  AUTO_LEVEL_LATENCY_S,
  SCHEDULE_LATENCY_S,
  dbToGain,
  forgetAssetAudio,
} = audio
const ctx = ensureAudioContext() as unknown as FakeContext
const { Transport } = await import('./playback')
const { invalidateDenoise } = await import('./denoise')

const VOICE: MediaAsset = { id: 'v', name: 'take.wav', kind: 'audio', blobKey: 'asset/v', durationS: 10, hasAudio: true, hasVideo: false }
const MUSIC: MediaAsset = { id: 'm', name: 'bed.mp3', kind: 'audio', blobKey: 'asset/m', durationS: 10, hasAudio: true, hasVideo: false }
const ASSETS = { v: VOICE, m: MUSIC }

/** The graph's own fader: the one gain that feeds the master sum. */
const graphFader = (): Gain => {
  const master = ensureMasterChain().master as unknown as Node
  const g = ctx.gains.filter((n) => n.out.includes(master))
  return g[g.length - 1]!
}
/** A track's fader: the first gain a track's chain makes is its input. */
const trackGain = (panner: Panner): Gain => ctx.gains.find((g) => g.out.includes(panner))!

beforeEach(() => {
  ctx.currentTime = 10
  ctx.gains.length = 0
  ctx.panners.length = 0
  ctx.sources.length = 0
  decode.mockReset()
  // Whatever range is asked for comes back, starting where it was asked.
  decode.mockImplementation(async (_blob: Blob, _dur: number, fromS = 0, toS = 10) => ({
    kind: 'pcm',
    planes: [new Float32Array(Math.round((toS - fromS) * 48_000)).fill(0.1)],
    sampleRate: 48_000,
    startS: fromS,
  }))
  forgetAssetAudio('v')
  forgetAssetAudio('m')
  noisePass.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const voiceTrack = (over: Partial<Track> = {}): Track =>
  makeTrack({ id: 'A1', kind: 'audio', clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 4 })], ...over })
const musicTrack = (over: Partial<Track> = {}): Track =>
  makeTrack({ id: 'A2', kind: 'audio', clips: [makeClip({ id: 'c2', assetId: 'm', startS: 0, inS: 0, outS: 8 })], ...over })

describe('what scheduleAudio starts', () => {
  it('a ranged buffer is read from the clip’s own place in the file', async () => {
    // Source 3..6 at timeline 0; play from 1 s in, so the file is read from 4 s.
    const track = voiceTrack({ clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 3, outS: 6 })] })
    const stop = await scheduleAudio(makeSeq([track]), ASSETS, 1)
    const [when, offset, duration] = ctx.sources[0]!.started!
    // The range read starts on its 2 s grid (2 s, padded and snapped), so 4 s
    // into the file is 2 s into the buffer.
    expect(decode.mock.calls[0]!.slice(2, 4)).toEqual([2, 8])
    expect(offset).toBeCloseTo(2, 9)
    expect(duration).toBeCloseTo(2, 9)
    expect(when).toBeCloseTo(10 + SCHEDULE_LATENCY_S, 6)
    expect(stop.startsAtCtxS).toBeCloseTo(10 + SCHEDULE_LATENCY_S, 9)
    stop()
  })

  it('beside an Auto-level track, a plain track starts 288 samples later, so the two meet', async () => {
    const stop = await scheduleAudio(makeSeq([voiceTrack({ autoLevel: 'medium' }), musicTrack()]), ASSETS, 0)
    const [auto, plain] = ctx.sources.map((s) => s.started![0])
    expect(plain! - auto!).toBeCloseTo(AUTO_LEVEL_LATENCY_S, 4)
    expect(Math.round((plain! - auto!) * 48_000)).toBe(288)
    stop()
  })

  // The music is down by the time the first word sounds, on a plain music track
  // and on an Auto-level one, whose compressor delays it by those 288 samples.
  for (const autoLevel of [undefined, 'medium'] as const) {
    it(`the duck lands on the voice${autoLevel ? ', behind an Auto-level music track' : ''}`, async () => {
      const voice = voiceTrack({ audioRole: 'voice', clips: [makeClip({ id: 'c1', assetId: 'v', startS: 2, inS: 0, outS: 2 })] })
      const music = musicTrack({ audioRole: 'music', autoLevel })
      const stop = await scheduleAudio(makeSeq([music, voice]), ASSETS, 0)
      const voiceStart = ctx.sources[1]!.started![0]
      // The duck is the gain feeding the music's panner.
      const duck = ctx.gains.find((g) => g.out.includes(ctx.panners[0]!))!.gain
      const down = 10 ** (DUCK_DB / 20)
      // Down exactly as the voice starts, and not a sample before it.
      expect(duck.at(voiceStart)).toBeCloseTo(down, 6)
      expect(duck.at(voiceStart - 0.001)).toBeGreaterThan(down + 1e-4)
      expect(duck.at(voiceStart - DUCK_ATTACK_S)).toBeCloseTo(1, 6)
      stop()
    })
  }
})

describe('the range cache', () => {
  it('a range inside one already read is not read again; one outside it is', async () => {
    await getAudioRange(VOICE, 1, 3)
    expect(decode).toHaveBeenCalledTimes(1)
    await getAudioRange(VOICE, 1.5, 2.5)
    expect(decode).toHaveBeenCalledTimes(1)
    await getAudioRange(VOICE, 0, 9)
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('counts what it holds, and lets go of all of it when the asset is forgotten', async () => {
    const before = rangeCacheBytesForTests()
    const r = await getAudioRange(VOICE, 1, 3)
    expect(rangeCacheBytesForTests() - before).toBe(r!.buffer.length * r!.buffer.numberOfChannels * 4)
    await getAudioRange(VOICE, 6, 9)
    forgetAssetAudio('v')
    expect(rangeCacheBytesForTests()).toBe(before)
  })
})

// ⛔ AU-9. Every mute, solo or fader move while playing stopped every source at
// once (a click) and left 50 ms and more of nothing before a rebuilt graph.
describe('a graph comes in and goes out through its own fader', () => {
  it('fades in at its start', async () => {
    const stop = await scheduleAudio(makeSeq([voiceTrack()]), ASSETS, 0)
    const at = stop.startsAtCtxS
    const fader = graphFader().gain
    expect(fader.at(at - 0.01)).toBe(0)
    expect(fader.at(at)).toBe(0)
    expect(fader.at(at + GRAPH_FADE_S / 2)).toBeCloseTo(0.5, 9)
    expect(fader.at(at + GRAPH_FADE_S)).toBe(1)
    expect(fader.at(at + 5)).toBe(1)
    stop()
  })

  it('a stop fades out from now and stops the sources once silent, not mid-waveform', async () => {
    const stop = await scheduleAudio(makeSeq([voiceTrack()]), ASSETS, 0)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    ctx.currentTime = 12
    stop()
    const fader = graphFader()
    // Full level right up to now, then down to nothing over the fade.
    expect(fader.gain.at(11.9)).toBe(1)
    expect(fader.gain.at(12)).toBe(1)
    expect(fader.gain.at(12 + GRAPH_FADE_S / 2)).toBeCloseTo(0.5, 9)
    expect(fader.gain.at(12 + GRAPH_FADE_S)).toBe(0)
    expect(ctx.sources[0]!.stoppedAt).toBeCloseTo(12 + GRAPH_FADE_S, 9)
    // Still connected while it fades, let go of once it is silent.
    expect(ctx.sources[0]!.disconnected).toBe(false)
    vi.runAllTimers()
    expect(ctx.sources[0]!.disconnected).toBe(true)
    expect(fader.disconnected).toBe(true)
    // Once only.
    const calls = fader.gain.calls.length
    stop()
    expect(fader.gain.calls).toHaveLength(calls)
  })

  it('a stop halfway through its own fade in goes down from where it had got to', async () => {
    const stop = await scheduleAudio(makeSeq([voiceTrack()]), ASSETS, 0)
    const at = stop.startsAtCtxS + GRAPH_FADE_S / 4
    ctx.currentTime = at
    stop()
    const fader = graphFader().gain
    expect(fader.at(at)).toBeCloseTo(0.25, 9)
    expect(fader.at(at + GRAPH_FADE_S)).toBe(0)
    // It never jumps up on the way.
    for (let i = 0; i <= 10; i++) expect(fader.at(at + (GRAPH_FADE_S * i) / 10)).toBeLessThanOrEqual(0.25 + 1e-9)
  })

  it('a handover fades out across the moment the newer graph starts', async () => {
    const stop = await scheduleAudio(makeSeq([voiceTrack()]), ASSETS, 0)
    ctx.currentTime = 12
    stop.stopAt(12.06)
    const old = graphFader().gain
    // ⛔ Still at full level until the moment the new graph starts: this is the
    // hole the first try left, 30 to 50 ms at a few percent, found in Chromium.
    expect(old.at(12)).toBe(1)
    expect(old.at(12.05)).toBe(1)
    expect(old.at(12.06)).toBe(1)
    expect(old.at(12.06 + GRAPH_FADE_S)).toBe(0)
    expect(ctx.sources[0]!.stoppedAt).toBeCloseTo(12.06 + GRAPH_FADE_S, 9)
  })

  it('across a handover the two graphs add up to a steady level', async () => {
    const tracks = [voiceTrack()]
    const first = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    const oldFader = graphFader().gain
    ctx.currentTime = 12
    const second = await scheduleAudio(makeSeq(tracks), ASSETS, 2)
    const newFader = graphFader().gain
    first.stopAt(second.startsAtCtxS)
    const join = second.startsAtCtxS
    for (let i = -10; i <= 20; i++) {
      const t = join + (GRAPH_FADE_S * i) / 10
      expect(oldFader.at(t) + newFader.at(t)).toBeCloseTo(1, 9)
    }
    second()
  })
})

// ⛔ SF-1, review 2026-10-08. A clip edit mid-play rebuilds the sound, and that
// rebuild waits on every read it needs: the whole span again for a clip he
// extended, the whole take and its noise pass for one he turned noise reduction
// on for. The sound used to start from where the playhead was when the rebuild
// was ASKED for, seconds before it was ready, and the picture was moved back
// onto it. Handed `follow`, the scheduler starts it from where the picture is
// at the moment it really sounds.
describe('a rebuild that waits on a slow read starts where the picture is', () => {
  /** The picture for a play heard from timeline 0 at context time 10.05. */
  const picture = (ctxS: number): number => ctxS - 10.05

  /** Decodes that take `slowS` of the context's time to come back. */
  const slowDecodes = (slowS: { s: number }) => {
    decode.mockImplementation(async (_blob: Blob, _dur: number, fromS = 0, toS = 10) => {
      ctx.currentTime += slowS.s
      return {
        kind: 'pcm',
        planes: [new Float32Array(Math.round((toS - fromS) * 48_000)).fill(0.1)],
        sampleRate: 48_000,
        startS: fromS,
      }
    })
  }

  it('a clip extended while it plays: its span is read again for 1.5 s, and the sound starts where the picture got to', async () => {
    const slow = { s: 0 }
    slowDecodes(slow)
    const short = voiceTrack({ clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 4 })] })
    const first = await scheduleAudio(makeSeq([short]), ASSETS, 0)
    expect(first.startsAtCtxS).toBeCloseTo(10.05, 9)
    // 2 s in, he drags the out point to 8 s: a span not read yet.
    ctx.currentTime = 12.05
    slow.s = 1.5
    const longer = voiceTrack({ clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 8 })] })
    const hint = picture(ctx.currentTime + SCHEDULE_LATENCY_S + 0.01)
    const stop = await scheduleAudio(makeSeq([longer]), ASSETS, hint, picture)
    // Ready 1.5 s later, and it starts from there, not from 2 s.
    expect(stop.startsAtCtxS).toBeCloseTo(13.55 + SCHEDULE_LATENCY_S, 9)
    expect(stop.fromS).toBeCloseTo(picture(stop.startsAtCtxS), 9)
    const source = ctx.sources.at(-1)!
    const [when, offset, duration] = source.started!
    expect(when).toBeCloseTo(stop.startsAtCtxS, 4)
    expect(offset).toBeCloseTo(picture(stop.startsAtCtxS), 4)
    expect(duration).toBeCloseTo(8 - picture(stop.startsAtCtxS), 4)
    // Its gain is worked out from there too: the clip's de-clicked end lands on
    // the moment the picture reaches 8 s, not 1.5 s after it.
    const clipGain = (source.out[0] as Gain).gain
    const endsAt = stop.startsAtCtxS + (8 - picture(stop.startsAtCtxS))
    expect(clipGain.at(endsAt - 0.003)).toBeCloseTo(1, 6)
    expect(clipGain.at(endsAt)).toBeCloseTo(0, 6)
    first()
    stop()
  })

  it('noise reduction turned on while it plays: a 2 s noise pass, and the sound starts where the picture got to', async () => {
    invalidateDenoise('v')
    noisePass.mockImplementation((channels: readonly Float32Array[]) => {
      ctx.currentTime += 2
      return Promise.resolve(channels.map((c) => c.slice()))
    })
    const track = voiceTrack({ clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 8, denoise: 1 })] })
    ctx.currentTime = 11.05 // a second in
    const stop = await scheduleAudio(makeSeq([track]), ASSETS, picture(11.05 + SCHEDULE_LATENCY_S + 0.01), picture)
    expect(noisePass).toHaveBeenCalledTimes(1)
    expect(stop.startsAtCtxS).toBeGreaterThan(13)
    expect(stop.fromS).toBeCloseTo(picture(stop.startsAtCtxS), 9)
    const [, offset] = ctx.sources.at(-1)!.started!
    expect(offset).toBeCloseTo(picture(stop.startsAtCtxS), 4)
    stop()
    invalidateDenoise('v')
  })

  it('a clip that ended while the read ran is not started at all', async () => {
    const slow = { s: 1.5 }
    slowDecodes(slow)
    const two = voiceTrack({
      clips: [
        makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 2.5 }),
        makeClip({ id: 'c2', assetId: 'v', startS: 2.5, inS: 5, outS: 9 }),
      ],
    })
    ctx.currentTime = 12.05 // timeline 2: c1 has half a second left
    const stop = await scheduleAudio(makeSeq([two]), ASSETS, 2.06, picture)
    // By the time it sounds (two reads of 1.5 s), c1 is over and c2 is well in.
    expect(picture(stop.startsAtCtxS)).toBeGreaterThan(2.5)
    expect(ctx.sources).toHaveLength(1)
    const [when, offset] = ctx.sources[0]!.started!
    expect(when).toBeCloseTo(stop.startsAtCtxS, 4)
    // c2's read starts on its 2 s grid, at 4 s of the file.
    expect(offset).toBeCloseTo(5 + (picture(stop.startsAtCtxS) - 2.5) - 4, 4)
    stop()
  })

  it('a source started later plays exactly what one scheduled there would, stretched or not', () => {
    const buf = ctx.createBuffer(1, 48_000 * 10, 48_000) as unknown as AudioBuffer
    const on = ctx as unknown as BaseAudioContext
    for (const speed of [1, 2, 0.5]) {
      const clip = makeClip({ id: 'c', assetId: 'v', startS: 1, inS: 2, outS: 8, speed })
      const early = audio.pitchPreservedSource(on, buf, speed, audio.computeClipSchedule(clip, 1.5)!, clip.inS)
      const there = audio.pitchPreservedSource(on, buf, speed, audio.computeClipSchedule(clip, 2.25)!, clip.inS)
      const moved = audio.startLater(early, 0.75)
      expect(moved.buffer).toBe(there.buffer)
      expect(moved.playbackRate).toBe(there.playbackRate)
      expect(moved.offsetS).toBeCloseTo(there.offsetS, 9)
      expect(moved.durationS).toBeCloseTo(there.durationS, 9)
    }
  })

  it('without `follow` it plays from exactly where it was asked to', async () => {
    const slow = { s: 1.5 }
    slowDecodes(slow)
    const stop = await scheduleAudio(makeSeq([voiceTrack()]), ASSETS, 1)
    expect(stop.fromS).toBe(1)
    expect(ctx.sources[0]!.started![1]).toBeCloseTo(1, 9)
    stop()
  })

  it('end to end: the transport plays on through a slow rebuild without a jump', async () => {
    globalThis.requestAnimationFrame = (() => 1) as unknown as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => undefined) as unknown as typeof cancelAnimationFrame
    const slow = { s: 0 }
    slowDecodes(slow)
    let seq = makeSeq([voiceTrack({ clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 4 })] })])
    const t = new Transport({
      getEndS: () => 9,
      onTick: () => undefined,
      schedule: (fromS, follow) => scheduleAudio(seq, ASSETS, fromS, follow),
    })
    await t.play(0)
    expect(ctx.sources[0]!.started![0]).toBeCloseTo(10.05, 4)
    ctx.currentTime = 12.05
    expect(t.currentTime()).toBeCloseTo(2, 9)
    // He extends the clip while it plays, and the new span takes 1.5 s to read.
    seq = makeSeq([voiceTrack({ clips: [makeClip({ id: 'c1', assetId: 'v', startS: 0, inS: 0, outS: 8 })] })])
    slow.s = 1.5
    t.rescheduleAudio({ seamless: true })
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(2))
    // The picture is where it was heading all along, and the new sound starts
    // exactly on it.
    expect(t.currentTime()).toBeCloseTo(picture(ctx.currentTime), 9)
    const [when, offset] = ctx.sources[1]!.started!
    expect(offset).toBeCloseTo(picture(when), 4)
    ctx.currentTime = when + 1
    expect(t.currentTime()).toBeCloseTo(picture(when + 1), 9)
    t.pause()
  })
})

describe('a mix change mid-play moves the live graph without rebuilding it', () => {
  it('a fader glides to its new level, and nothing new is built', async () => {
    const tracks = [voiceTrack(), musicTrack()]
    const stop = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    const built = ctx.sources.length
    ctx.currentTime = 11
    expect(stop.setMix([{ ...tracks[0]!, volumeDb: -6 }, tracks[1]!])).toBe(true)
    const fader = trackGain(ctx.panners[0]!).gain
    expect(fader.calls).toEqual([['target', dbToGain(-6), 11, MIX_GLIDE_S]])
    // A glide, not a step, and there within a few time constants.
    expect(fader.at(11)).toBe(1)
    expect(fader.at(11 + MIX_GLIDE_S)).toBeGreaterThan(dbToGain(-6))
    expect(fader.at(11 + MIX_GLIDE_S)).toBeLessThan(1)
    expect(fader.at(11 + 8 * MIX_GLIDE_S)).toBeCloseTo(dbToGain(-6), 3)
    expect(ctx.sources).toHaveLength(built)
    stop()
  })

  it('a mute glides the track to silence, and unmuting brings it back', async () => {
    const tracks = [voiceTrack(), musicTrack()]
    const stop = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    expect(stop.setMix([tracks[0]!, { ...tracks[1]!, muted: true }])).toBe(true)
    expect(stop.setMix(tracks)).toBe(true)
    const music = trackGain(ctx.panners[1]!).gain.calls.map((c) => c[1])
    expect(music).toEqual([0, 1])
    // The other track is told its own level each time, unchanged.
    expect(trackGain(ctx.panners[0]!).gain.calls.map((c) => c[1])).toEqual([1, 1])
    stop()
  })

  it('a solo silences the others, and a pan glides', async () => {
    const tracks = [voiceTrack(), musicTrack()]
    const stop = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    expect(stop.setMix([{ ...tracks[0]!, solo: true, pan: -0.5 }, tracks[1]!])).toBe(true)
    expect(trackGain(ctx.panners[1]!).gain.calls.map((c) => c[1])).toEqual([0])
    expect(ctx.panners[0]!.pan.calls).toEqual([['target', -0.5, 10, MIX_GLIDE_S]])
    stop()
  })

  it('a track that was silent when the graph was built asks for a rebuild, and nothing moves', async () => {
    const tracks = [voiceTrack(), musicTrack({ muted: true })]
    const stop = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    expect(stop.setMix([tracks[0]!, { ...tracks[1]!, muted: false }])).toBe(false)
    expect(ctx.gains.flatMap((g) => g.gain.calls).filter((c) => c[0] === 'target')).toEqual([])
    stop()
  })

  it('Auto-level, a role or the ducking changing asks for a rebuild', async () => {
    const tracks = [voiceTrack({ audioRole: 'voice' }), musicTrack({ audioRole: 'music' })]
    const stop = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    expect(stop.setMix([{ ...tracks[0]!, autoLevel: 'medium' }, tracks[1]!])).toBe(false)
    expect(stop.setMix([tracks[0]!, { ...tracks[1]!, audioRole: undefined }])).toBe(false)
    // Muting the voice the music ducks under changes the ducking itself.
    expect(stop.setMix([{ ...tracks[0]!, muted: true }, tracks[1]!])).toBe(false)
    // While the music's own fader is fine.
    expect(stop.setMix([tracks[0]!, { ...tracks[1]!, volumeDb: -3 }])).toBe(true)
    stop()
  })

  it('a stopped graph takes no mix change', async () => {
    const tracks = [voiceTrack()]
    const stop = await scheduleAudio(makeSeq(tracks), ASSETS, 0)
    stop()
    expect(stop.setMix([{ ...tracks[0]!, volumeDb: -6 }])).toBe(false)
  })
})
