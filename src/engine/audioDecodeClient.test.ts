// The decode pool: two workers, and a read Play is waiting on goes first.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: { preventDefault: () => void }) => void) | null = null
  posted: { id: number; fromS?: number }[] = []
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(msg: { id: number; fromS?: number }) {
    this.posted.push(msg)
  }
  answer(id: number) {
    this.onmessage?.({ data: { id, ok: true, result: { kind: 'silent' } } } as MessageEvent)
  }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => vi.unstubAllGlobals())

describe('decodeAudioOffThread', () => {
  // ⛔ AU-5. First come first served meant Space waited behind every waveform,
  // beat scan and loudness read queued before it.
  it('a read Play is waiting on goes ahead of background reads still queued', async () => {
    const { decodeAudioOffThread } = await import('./audioDecodeClient')
    const blob = new Blob(['x'])
    // Both workers busy with background reads, and one more background read waiting.
    void decodeAudioOffThread(blob, 60, 0, 10)
    void decodeAudioOffThread(blob, 60, 10, 20)
    void decodeAudioOffThread(blob, 60, 20, 30)
    const play = decodeAudioOffThread(blob, 60, 40, 50, true)
    const [a] = FakeWorker.all
    a!.answer(a!.posted[0]!.id)
    // The worker that came free took Play's read, not the older background one.
    expect(a!.posted[1]!.fromS).toBe(40)
    a!.answer(a!.posted[1]!.id)
    await expect(play).resolves.toEqual({ kind: 'silent' })
    expect(a!.posted).toHaveLength(3)
    expect(a!.posted[2]!.fromS).toBe(20)
  })

  // ⛔ SF-2, review 2026-10-08. Selecting a clip queues a background read of
  // exactly the range Play asks for, and Play then got that same read back,
  // still waiting behind every waveform queued before it.
  it('a background read stays in line until Play comes to wait on it, then goes first', async () => {
    const { decodeAudioOffThread, decodeLane, peaksOffThread, promoteLane } = await import('./audioDecodeClient')
    const blob = new Blob(['x'])
    void peaksOffThread(blob, 600, 2000)
    void peaksOffThread(blob, 600, 2000)
    void peaksOffThread(blob, 900, 2000) // a third long recording's waveform, waiting
    const lane = decodeLane()
    const selected = decodeAudioOffThread(blob, 60, 40, 50, lane)
    const [a, b] = FakeWorker.all
    // Not promoted: it keeps its place behind the waveform.
    a!.answer(a!.posted[0]!.id)
    expect(a!.posted[1]).toMatchObject({ op: 'peaks', durationS: 900 })
    void decodeAudioOffThread(blob, 60, 0, 10) // more background behind it
    void peaksOffThread(blob, 1200, 2000)
    // Space: Play waits on that very read now.
    promoteLane(lane)
    b!.answer(b!.posted[0]!.id)
    expect(b!.posted[1]).toMatchObject({ op: 'pcm', fromS: 40 })
    b!.answer(b!.posted[1]!.id)
    await expect(selected).resolves.toEqual({ kind: 'silent' })
  })

  it('a read promoted before it reaches the queue goes in at the front', async () => {
    const { decodeAudioOffThread, decodeLane, peaksOffThread, promoteLane } = await import('./audioDecodeClient')
    const blob = new Blob(['x'])
    for (let i = 0; i < 4; i++) void peaksOffThread(blob, 600, 2000)
    const lane = decodeLane()
    promoteLane(lane)
    void decodeAudioOffThread(blob, 60, 40, 50, lane)
    const [a] = FakeWorker.all
    a!.answer(a!.posted[0]!.id)
    expect(a!.posted[1]).toMatchObject({ op: 'pcm', fromS: 40 })
  })

  it('background reads keep their order among themselves', async () => {
    const { decodeAudioOffThread } = await import('./audioDecodeClient')
    const blob = new Blob(['x'])
    for (const from of [0, 10, 20, 30]) void decodeAudioOffThread(blob, 60, from, from + 10)
    const [a] = FakeWorker.all
    a!.answer(a!.posted[0]!.id)
    expect(a!.posted[1]!.fromS).toBe(20)
  })
})
