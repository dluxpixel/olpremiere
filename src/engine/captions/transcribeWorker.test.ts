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
  // The word aligner (alignRunner.ts): a second model, here either broken or a
  // stand-in that hears "hey" at frames 5, 7 and 9 of a one second clip.
  Tensor: class {
    constructor(
      public type: string,
      public data: unknown,
      public dims: number[],
    ) {}
  },
  AutoModelForCTC: {
    from_pretrained: async (_id: string, opts: { device: string; progress_callback?: (p: unknown) => void }) => {
      alignerBuilt.push(opts.device)
      if (!alignerWorks) throw new Error('the aligner will not load')
      opts.progress_callback?.({ status: 'download', file: 'model_q4.onnx' })
      opts.progress_callback?.({ status: 'progress', progress: 50, total: 100 })
      return async (inputs: { input_values: { data: Float32Array } }) => {
        const T = Math.floor(inputs.input_values.data.length / 320)
        const data = new Float32Array(T * ALIGN_V)
        const heard: Record<number, number> = { 5: 2, 7: 3, 9: 4 }
        for (let t = 0; t < T; t++) data[t * ALIGN_V + (heard[t] ?? 0)] = 10
        return { logits: { data, dims: [1, T, ALIGN_V] } }
      }
    },
  },
}))

/** The devices the aligner asked for, and whether it loads at all. */
const alignerBuilt: string[] = []
let alignerWorks = false
/** Outputs 0 to 5: the blank, the delimiter, h, e, y, and an "a" (a vocabulary with one is read in lower case). */
const ALIGN_V = 6
const ALIGN_VOCAB = { '[PAD]': 0, '|': 1, h: 2, e: 3, y: 4, a: 5 }

let posted: TranscribeResponse[] = []
let onmessage: ((e: { data: unknown }) => void) | null = null

beforeEach(async () => {
  posted = []
  built.length = 0
  alignerBuilt.length = 0
  alignerWorks = false
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The aligner's vocabulary comes off the network the first time; here it is a stand-in.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(ALIGN_VOCAB))),
  )
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

// The word aligner runs after the speech model, on the same audio, and only when
// the request asks for it. It may make a caption's times better and may never
// cost it a word.
describe('the word aligner after the speech model', () => {
  const raw = { text: ' hey', timestamp: [0, 0.2] }

  it('is not started for a run that did not ask for it', async () => {
    alignerWorks = true
    const said = await hear({ gpuFailures: 2 })
    expect(alignerBuilt).toEqual([])
    expect(said[said.length - 1]).toEqual({ type: 'done', chunks: [raw] })
  })

  it('times the words, says it is working, and marks the ones it timed', async () => {
    alignerWorks = true
    const said = await hear({ gpuFailures: 2, align: true })
    const kinds = said.map((m) => (m.type === 'progress' ? `${m.phase}${m.downloading ? ' downloading' : ''}` : m.type))
    // Listening, a beat as the aligner starts, its model loading (first time only), a beat
    // when the model is ready (so the main thread's watchdog starts again before the first
    // window, alignRunner.ts), then each window, then done.
    expect(kinds).toEqual(['model downloading', 'model downloading', 'listening', 'align', 'align downloading', 'align', 'align', 'done'])
    const done = said[said.length - 1] as Extract<TranscribeResponse, { type: 'done' }>
    expect(done.chunks).toHaveLength(1)
    expect(done.chunks[0]).toMatchObject({ text: ' hey', aligned: true })
    // 'h' is heard at frame 5 (0.10 s), less the 15 ms the aligner's bias takes off.
    expect(done.chunks[0]!.timestamp[0]).toBeCloseTo(0.085, 3)
  })

  it('still ends in done, with the speech model chunks as they were, when the aligner will not load', async () => {
    alignerWorks = false
    const said = await hear({ gpuFailures: 2, align: true })
    expect(alignerBuilt.length).toBeGreaterThan(0)
    expect(said[said.length - 1]).toEqual({ type: 'done', chunks: [raw] })
    expect(said.some((m) => m.type === 'error')).toBe(false)
  })
})
