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

  it('background reads keep their order among themselves', async () => {
    const { decodeAudioOffThread } = await import('./audioDecodeClient')
    const blob = new Blob(['x'])
    for (const from of [0, 10, 20, 30]) void decodeAudioOffThread(blob, 60, from, from + 10)
    const [a] = FakeWorker.all
    a!.answer(a!.posted[0]!.id)
    expect(a!.posted[1]!.fromS).toBe(20)
  })
})
