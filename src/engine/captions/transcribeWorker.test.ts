// The speech worker's GPU fallback (CA-15), with a stand-in for transformers.js.
//
// When the GPU pipeline fails at inference the worker builds a wasm pipeline
// from other weights, about 770 MB the first time. It used to do that in
// silence, under "Listening for words...", while the main thread's listening
// budget ran on, and the count of GPU failures lived only in a worker the
// watchdog could kill. What is proven here is what the worker SAYS while it
// falls back, and that it trusts the count the main thread keeps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeResponse } from './transcribeWorker'

/** Every pipeline the worker asked for, by device. */
const built: string[] = []
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async (_task: string, _model: string, opts: { device: string; progress_callback?: (p: unknown) => void }) => {
    built.push(opts.device)
    if (opts.device === 'webgpu') {
      return async () => {
        throw new Error('shader compile failed')
      }
    }
    // The wasm weights come off the network the first time.
    opts.progress_callback?.({ status: 'initiate', file: 'encoder_model_quantized.onnx' })
    opts.progress_callback?.({ status: 'download', file: 'encoder_model_quantized.onnx' })
    opts.progress_callback?.({ status: 'progress', progress: 40, total: 100 })
    opts.progress_callback?.({ status: 'progress', progress: 100, total: 100 })
    return async () => ({ chunks: [{ text: ' hey', timestamp: [0, 0.2] }] })
  },
}))

let posted: TranscribeResponse[] = []
let onmessage: ((e: { data: unknown }) => void) | null = null

beforeEach(async () => {
  posted = []
  built.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const self = {
    postMessage: (m: TranscribeResponse) => void posted.push(m),
    set onmessage(fn: (e: { data: unknown }) => void) {
      onmessage = fn
    },
  }
  vi.stubGlobal('self', self)
  // A GPU that can do half precision, so the worker starts on it.
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })
  // A fresh worker each time, as one built after the last was killed.
  vi.resetModules()
  await import('./transcribeWorker')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function hear(request: Record<string, unknown>): Promise<TranscribeResponse[]> {
  onmessage!({ data: { pcm: new Float32Array(16000), language: 'en', ...request } })
  await vi.waitFor(() => expect(posted.some((m) => m.type === 'done' || m.type === 'error')).toBe(true))
  return posted
}

describe('a GPU that fails at inference', () => {
  it('says so, shows the fallback download, and starts the clock again when it listens', async () => {
    const said = await hear({})
    expect(built).toEqual(['webgpu', 'wasm'])
    const kinds = said.map((m) => (m.type === 'progress' ? `${m.phase}${m.downloading ? ' downloading' : ''}` : m.type))
    // GPU load, listening on the GPU, the failure, the wasm download, listening again, done.
    expect(kinds).toEqual(['listening', 'gpuFailed', 'model downloading', 'model downloading', 'listening', 'done'])
    expect(said.find((m) => m.type === 'gpuFailed')).toMatchObject({ failures: 1 })
  })

  it('a worker told the GPU already failed twice goes straight to the slower weights', async () => {
    const said = await hear({ gpuFailures: 2 })
    expect(built).toEqual(['wasm'])
    expect(said[said.length - 1]).toMatchObject({ type: 'done' })
  })

  it('a worker told it failed once counts this one as the second', async () => {
    const said = await hear({ gpuFailures: 1 })
    expect(said.find((m) => m.type === 'gpuFailed')).toMatchObject({ failures: 2 })
  })
})
