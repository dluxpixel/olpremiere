/**
 * The watchdog on musicTrackForClip's worker round trip. Same shape as
 * transcribe.test.ts's Whisper watchdog tests, and for the same reason: this
 * worker runs the identical class of wasm/ML inference, and until now a
 * classifier that stopped making progress left the promise unresolved
 * forever, which `wordsForClip` awaits AFTER Whisper already finished, so a
 * hang here would strand the caption run's progress pill with no recovery
 * short of reloading the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./transcribe', () => ({
  extractClipPcmAt: async () => new Float32Array(16000 * 3), // 3s, real audio
}))

import { newClipFromAsset, type MediaAsset } from '../types'
import { killMusicWorker, musicTrackForClip } from './musicAnalysis'

class FakeWorker {
  static last: FakeWorker | null = null
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  posted: unknown[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  count(): number {
    return (this.listeners.message ?? []).length + (this.listeners.error ?? []).length
  }
  emit(data: unknown): void {
    for (const fn of [...(this.listeners.message ?? [])]) fn({ data })
  }
}

const asset: MediaAsset = {
  id: 'a',
  name: 'a',
  kind: 'video',
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: true,
}
const clip = newClipFromAsset(asset, 0)

describe('musicTrackForClip watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    killMusicWorker()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    killMusicWorker()
  })

  it('gives up on a request that never replies, and hands the worker back', async () => {
    const result = musicTrackForClip(asset, clip)
    await Promise.resolve() // let the mocked extractClipPcmAt's await settle
    await Promise.resolve()
    const worker = FakeWorker.last!
    // 3s of audio: the floor plus its share of the per-second budget.
    await vi.advanceTimersByTimeAsync(60_000 + 3 * 4_000 + 1)
    await expect(result).resolves.toBeNull()
    expect(worker.terminated).toBe(true)
    expect(worker.count()).toBe(0)
  })

  it('does not fire once a real reply already landed', async () => {
    const result = musicTrackForClip(asset, clip)
    await Promise.resolve()
    await Promise.resolve()
    const worker = FakeWorker.last!
    const id = (worker.posted[0] as { id: number }).id
    worker.emit({ ok: true, scores: new Float32Array([0.9]), windowS: 5, id })
    await expect(result).resolves.toEqual({ scores: new Float32Array([0.9]), windowS: 5 })
    // The clock keeps running well past the budget: the watchdog must not
    // reach back and kill a worker that already answered.
    await vi.advanceTimersByTimeAsync(60_000 + 3 * 4_000 + 1)
    expect(worker.terminated).toBe(false)
  })

  it('does not fire once a hard error already resolved the request', async () => {
    const result = musicTrackForClip(asset, clip)
    await Promise.resolve()
    await Promise.resolve()
    const worker = FakeWorker.last!
    const id = (worker.posted[0] as { id: number }).id
    worker.emit({ ok: false, error: 'model failed to load', id })
    await expect(result).resolves.toBeNull()
    const killedAt = worker.terminated
    expect(killedAt).toBe(true)
    // A second termination from a late-firing watchdog would be harmless but
    // is still worth ruling out: nothing should still be listening.
    expect(worker.count()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000 + 3 * 4_000 + 1)
  })
})
