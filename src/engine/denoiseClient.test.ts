// The worker side of noise reduction: what goes in is a copy, what comes back is
// the answer, and a worker that cannot run hands every pass back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: { preventDefault: () => void }) => void) | null = null
  posted: { msg: { id: number; channels: Float32Array[] }; transfer: Transferable[] }[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  postMessage(msg: { id: number; channels: Float32Array[] }, transfer: Transferable[]) {
    this.posted.push({ msg, transfer })
  }
  terminate() {
    this.terminated = true
  }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.last = null
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => vi.unstubAllGlobals())

describe('denoiseOffThread', () => {
  it('sends a copy, so the take the mixers play from is never emptied, and resolves with the answer', async () => {
    const { denoiseOffThread } = await import('./denoiseClient')
    const take = Float32Array.from([0.1, 0.2, 0.3])
    const pending = denoiseOffThread([take], 48_000)!
    const w = FakeWorker.last!
    const { msg, transfer } = w.posted[0]!
    expect(msg.channels[0]).not.toBe(take)
    expect([...msg.channels[0]!]).toEqual([...take])
    expect(transfer).toEqual([msg.channels[0]!.buffer])
    const answer = [Float32Array.from([1, 2, 3])]
    w.onmessage?.({ data: { id: msg.id, ok: true, channels: answer } } as MessageEvent)
    expect(await pending).toBe(answer)
  })

  it('a worker that cannot load fails what it holds, and every later pass is done by the caller', async () => {
    const { denoiseOffThread } = await import('./denoiseClient')
    const pending = denoiseOffThread([new Float32Array(4)], 48_000)!
    FakeWorker.last!.onerror?.({ preventDefault: () => undefined })
    await expect(pending).rejects.toThrow()
    expect(FakeWorker.last!.terminated).toBe(true)
    expect(denoiseOffThread([new Float32Array(4)], 48_000)).toBeNull()
  })

  it('with no Worker at all, says so instead of failing', async () => {
    vi.stubGlobal('Worker', undefined)
    const { denoiseOffThread } = await import('./denoiseClient')
    expect(denoiseOffThread([new Float32Array(4)], 48_000)).toBeNull()
  })
})
