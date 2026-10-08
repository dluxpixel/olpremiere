// Play goes first in line, through the real decode pool and the real mixer.
//
// ⛔ SF-2, review 2026-10-08. AU-5 gave a read Play is waiting on the front of
// the decode queue, and it did not reach the cases that matter most:
//   - selecting a clip queues a background read of EXACTLY the range Play asks
//     for (the beat scan), so Space got that same read back, still waiting
//     behind every waveform of his long OBS recordings queued before it;
//   - a clip with noise reduction on, or a reversed one, reads the whole file
//     through a path that never asked for the front at all.
// Two stand-in workers that answer only when the test says, and a stand-in
// context, so what is asked of the workers, and in what order, is what is checked.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeClip, makeSeq, makeTrack } from '../components/timelineTestFixtures'
import type { MediaAsset } from './types'

vi.mock('../state/persistence', () => ({ getBlob: async () => new Blob(['bytes']), db: async () => ({}) }))
vi.mock('./limiterNode', () => ({ createLimiterNode: () => Promise.reject(new Error('no worklet in node')) }))
// The noise pass answers at once: the queue under test is the decode's.
vi.mock('./denoiseClient', () => ({
  denoiseOffThread: (channels: readonly Float32Array[]) => Promise.resolve(channels.map((c) => c.slice())),
}))

interface Posted {
  id: number
  op: 'pcm' | 'peaks'
  durationS: number
  fromS?: number
  toS?: number
}

class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: { preventDefault: () => void }) => void) | null = null
  posted: Posted[] = []
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(msg: Posted) {
    this.posted.push(msg)
  }
  /** Finish the read this worker is on. */
  answer() {
    const job = this.posted.at(-1)!
    const result =
      job.op === 'peaks'
        ? { kind: 'peaks', peaks: new Float32Array(4) }
        : {
            kind: 'pcm',
            planes: [new Float32Array(Math.round(((job.toS ?? job.durationS) - (job.fromS ?? 0)) * 100))],
            sampleRate: 100,
            startS: job.fromS ?? 0,
          }
    this.onmessage?.({ data: { id: job.id, ok: true, result } } as MessageEvent)
  }
}

class Node {
  connect(n: unknown) {
    return n
  }
  disconnect() {}
}
class Param {
  value = 0
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class FakeContext {
  currentTime = 10
  sampleRate = 100
  state = 'running'
  destination = new Node()
  resume = () => Promise.resolve()
  createGain = () => Object.assign(new Node(), { gain: new Param(), channelCount: 2 })
  createStereoPanner = () => Object.assign(new Node(), { pan: new Param() })
  createBufferSource = () =>
    Object.assign(new Node(), { buffer: null, playbackRate: new Param(), start: () => {}, stop: () => {} })
  createDynamicsCompressor = () => new Node()
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

/** Two long OBS recordings and a voice take, as he imports them. */
const OBS1: MediaAsset = { id: 'o1', name: 'obs1.mkv', kind: 'video', blobKey: 'b/o1', durationS: 1800, hasAudio: true, hasVideo: true }
const OBS2: MediaAsset = { id: 'o2', name: 'obs2.mkv', kind: 'video', blobKey: 'b/o2', durationS: 1500, hasAudio: true, hasVideo: true }
const OBS3: MediaAsset = { id: 'o3', name: 'obs3.mkv', kind: 'video', blobKey: 'b/o3', durationS: 1200, hasAudio: true, hasVideo: true }
const TAKE: MediaAsset = { id: 't', name: 'take.wav', kind: 'audio', blobKey: 'b/t', durationS: 20, hasAudio: true, hasVideo: false }
const ASSETS = { o1: OBS1, o2: OBS2, o3: OBS3, t: TAKE }

/** Lets every async step before a read is queued (the blob lookup) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let audio: typeof import('./audio')
let client: typeof import('./audioDecodeClient')

beforeEach(async () => {
  vi.resetModules()
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('AudioContext', FakeContext)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  audio = await import('./audio')
  client = await import('./audioDecodeClient')
})

/** Both workers busy with a waveform each, and a third waveform waiting. */
async function waveformsQueued(): Promise<[FakeWorker, FakeWorker]> {
  const blob = new Blob(['x'])
  for (const a of [OBS1, OBS2, OBS3]) void client.peaksOffThread(blob, a.durationS, 2000)
  await settle()
  const [a, b] = FakeWorker.all
  expect(a!.posted).toHaveLength(1)
  expect(b!.posted).toHaveLength(1)
  return [a!, b!]
}

describe('Space after queued waveform jobs is served first', () => {
  it('the range he selected, read in the background, moves to the front when Play waits on it', async () => {
    const [a] = await waveformsQueued()
    const clip = makeClip({ id: 'c', assetId: 't', startS: 0, inS: 3, outS: 9 })
    // Selecting the clip reads its seconds for the beat scan, in the background.
    void audio.getAudioRange(TAKE, clip.inS, clip.outS)
    await settle()
    // Space.
    void audio.scheduleAudio(makeSeq([makeTrack({ id: 'A1', kind: 'audio', clips: [clip] })]), ASSETS, 0)
    await settle()
    a.answer()
    expect(a.posted[1]).toMatchObject({ op: 'pcm', fromS: 2, toS: 10 })
  })

  it('a clip with noise reduction on reads its whole take at the front, even when the noise pass already queued it', async () => {
    const [a] = await waveformsQueued()
    const clip = makeClip({ id: 'c', assetId: 't', startS: 0, inS: 0, outS: 8, denoise: 1 })
    // Turning noise reduction on starts its read early, in the background.
    audio.warmDenoise(clip, TAKE)
    await settle()
    void audio.scheduleAudio(makeSeq([makeTrack({ id: 'A1', kind: 'audio', clips: [clip] })]), ASSETS, 0)
    await settle()
    a.answer()
    expect(a.posted[1]).toMatchObject({ op: 'pcm', durationS: 20 })
    expect(a.posted[1]!.fromS).toBeUndefined()
  })

  it('a reversed clip reads its whole take at the front', async () => {
    const [a] = await waveformsQueued()
    const clip = makeClip({ id: 'c', assetId: 't', startS: 0, inS: 0, outS: 8, speed: -1 })
    void audio.scheduleAudio(makeSeq([makeTrack({ id: 'A1', kind: 'audio', clips: [clip] })]), ASSETS, 0)
    await settle()
    a.answer()
    expect(a.posted[1]).toMatchObject({ op: 'pcm', durationS: 20 })
    expect(a.posted[1]!.fromS).toBeUndefined()
  })

  it('a background read nobody plays keeps its place behind the waveforms', async () => {
    const [a] = await waveformsQueued()
    void audio.getAudioRange(TAKE, 3, 9)
    await settle()
    a.answer()
    expect(a.posted[1]).toMatchObject({ op: 'peaks', durationS: 1200 })
  })
})
