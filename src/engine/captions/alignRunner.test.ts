// The model half of the word aligner, with a stand-in for the model.
//
// The maths (ctcAlign.test.ts) is proven on made-up probability tables; what is
// proven here is the plumbing around the model: the windows it is fed, the
// columns it is reduced to, what is written back onto the recogniser's chunks,
// and above all that no failure ever costs a caption its words. The "model" is a
// function that puts a loud spike on a chosen token at a chosen frame and keeps
// the blank everywhere else, so every expected time below can be read off the
// frame numbers (a frame is 20 ms).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alignChunks, normaliseSlice, reduceLogits, type AlignRun, type Logits, type WordChunk } from './alignRunner'
import { setTimeout as sleep } from 'node:timers/promises'
import { LISTEN_FLOOR_MS } from './transcribe'

const hf = vi.hoisted(() => ({ from_pretrained: vi.fn() }))
vi.mock('@huggingface/transformers', () => ({
  env: {},
  Tensor: class {
    constructor(
      public type: string,
      public data: unknown,
      public dims: number[],
    ) {}
  },
  AutoModelForCTC: { from_pretrained: hf.from_pretrained },
}))

/** Ids 0 to 7: the blank, the delimiter, then six letters. */
const VOCAB: Record<string, number> = { '[PAD]': 0, '|': 1, a: 2, b: 3, c: 4, d: 5, x: 6, y: 7 }
const V = 8
const ALIGNER = { id: 'test/aligner', dtype: 'q4' as const, blank: '[PAD]', onsetBiasS: -0.015 }

/** A model that says nothing but the blank, except `spikes` (frame to column). */
function scripted(spikes: Record<number, number>): (slice: Float32Array) => Promise<Logits> {
  return async (slice) => {
    const T = Math.floor(slice.length / 320)
    const data = new Float32Array(T * V)
    for (let t = 0; t < T; t++) data[t * V + (spikes[t] ?? 0)] = 10
    return { data, T, V }
  }
}

// "ab" is said at frames 40 and 44, a pause with the delimiter at 60, "cd" at 80 and 84.
const SAID = { 40: 2, 44: 3, 60: 1, 80: 4, 84: 5 }

const chunk = (text: string, start: number, end: number): WordChunk => ({ text, timestamp: [start, end] })
const run = (over: Partial<AlignRun> = {}): AlignRun => ({
  aligner: ALIGNER,
  vocab: VOCAB,
  logitsOf: scripted(SAID),
  budgetMs: 60_000,
  ...over,
})
const quiet = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * 16_000))

describe('normaliseSlice', () => {
  it('gives zero mean and unit variance, as the model was trained on', () => {
    const out = normaliseSlice(Float32Array.from([0.1, 0.3, -0.2, 0.4, 0.0, -0.5]))
    const mean = out.reduce((s, x) => s + x, 0) / out.length
    const variance = out.reduce((s, x) => s + (x - mean) ** 2, 0) / out.length
    expect(mean).toBeCloseTo(0, 6)
    expect(variance).toBeCloseTo(1, 4)
  })

  it('keeps a silent slice finite', () => {
    const out = normaliseSlice(new Float32Array(100))
    expect(out.every((x) => Number.isFinite(x))).toBe(true)
  })
})

describe('reduceLogits', () => {
  it('is the log softmax over every output, kept for the wanted columns, plus the best of the rest', () => {
    // One frame, four outputs; columns 0 and 2 wanted.
    const logits: Logits = { data: Float32Array.from([1, 3, 2, 0]), T: 1, V: 4 }
    const lse = Math.log(Math.exp(1) + Math.exp(3) + Math.exp(2) + Math.exp(0))
    const out = reduceLogits(logits, [0, 2])
    expect(out.T).toBe(1)
    expect(out.V).toBe(3)
    expect(out.logProbs[0]).toBeCloseTo(1 - lse, 5)
    expect(out.logProbs[1]).toBeCloseTo(2 - lse, 5)
    // The best of the columns that were not kept is output 1, at 3.
    expect(out.logProbs[2]).toBeCloseTo(3 - lse, 5)
  })

  it('refuses a vocabulary larger than the model output', () => {
    expect(() => reduceLogits({ data: new Float32Array(3), T: 1, V: 3 }, [0, 5])).toThrow()
  })

  it('stays finite when every output is wanted', () => {
    const out = reduceLogits({ data: Float32Array.from([1, 2]), T: 1, V: 2 }, [0, 1])
    expect(Number.isFinite(out.logProbs[2]!)).toBe(true)
  })
})

describe('alignChunks', () => {
  it('writes the aligner times and the flag onto the words, and leaves tags alone', async () => {
    const chunks = [chunk(' ab', 0.9, 1.2), chunk('[MUSIC]', 1.2, 1.5), chunk(' cd', 1.7, 2.0)]
    const r = await alignChunks(chunks, quiet(4), run())
    expect(r.asked).toBe(2)
    expect(r.aligned).toBe(2)
    // 'a' is heard at frame 40 (0.80 s) and the bias pulls it 15 ms earlier.
    expect(r.chunks[0]!.timestamp[0]).toBeCloseTo(0.785, 3)
    // 'b' holds frame 44, so the word ends at frame 45 (0.90 s, less the bias), then runs on 0.16 s.
    expect(r.chunks[0]!.timestamp[1]).toBeCloseTo(0.885 + 0.16, 3)
    expect(r.chunks[2]!.timestamp[0]).toBeCloseTo(1.585, 3)
    expect(r.chunks[2]!.timestamp[1]).toBeCloseTo(1.685 + 0.16, 3)
    expect(r.chunks[0]!.aligned).toBe(true)
    expect(r.chunks[2]!.aligned).toBe(true)
    // The tag is the very same chunk, and the text keeps its leading space.
    expect(r.chunks[1]).toBe(chunks[1])
    expect(r.chunks[0]!.text).toBe(' ab')
  })

  it('does not change the chunks it was given', async () => {
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)]
    await alignChunks(chunks, quiet(4), run())
    expect(chunks[0]).toEqual({ text: ' ab', timestamp: [0.9, 1.2] })
  })

  it('gives a word the recogniser timed too far from the sound back untouched, and does not run the word before over it', async () => {
    // 'cd' is heard at 1.6 s but the recogniser put it at 2.9 s: 1.3 s away, past the 1 s limit.
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 2.9, 3.2)]
    const r = await alignChunks(chunks, quiet(4), run())
    expect(r.aligned).toBe(1)
    expect(r.chunks[1]).toBe(chunks[1])
    expect(r.chunks[0]!.aligned).toBe(true)
    // No tail: the word after it is the recogniser's, and late until its lag is taken off.
    expect(r.chunks[0]!.timestamp[1]).toBeCloseTo(0.885, 3)
  })

  it('leaves a passage the recogniser wrote out twice alone, and times the one that was said', async () => {
    // "ab cd" is heard once, but the text has it three times, the copies with the same times.
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0), chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0), chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)]
    const r = await alignChunks(chunks, quiet(4), run())
    expect(r.asked).toBe(6)
    expect(r.aligned).toBe(2)
    expect(r.chunks[0]!.timestamp[0]).toBeCloseTo(0.785, 3)
    expect(r.chunks[1]!.timestamp[0]).toBeCloseTo(1.585, 3)
    for (const k of [2, 3, 4, 5]) expect(r.chunks[k]).toBe(chunks[k])
  })

  it('tells the share done after each window', async () => {
    const seen: number[] = []
    await alignChunks([chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)], quiet(4), run({ report: (p) => seen.push(p) }))
    expect(seen).toEqual([100])
  })

  it('starts no window after the time is up, and the words in it keep the recogniser times', async () => {
    // Two words 29 s apart cannot share a window, so there are two.
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 30.0, 30.3)]
    const logitsOf = vi.fn(scripted(SAID))
    let t = 0
    const r = await alignChunks(chunks, quiet(40), run({ logitsOf, budgetMs: 1000, now: () => (t += 600) }))
    expect(r.windows).toBe(2)
    expect(r.windowsRun).toBe(1)
    expect(logitsOf).toHaveBeenCalledTimes(1)
    expect(r.chunks[1]).toBe(chunks[1])
  })

  it('has nothing to do for a recording with no words', async () => {
    const logitsOf = vi.fn(scripted({}))
    const r = await alignChunks([chunk('[MUSIC]', 0, 2)], quiet(3), run({ logitsOf }))
    expect(r).toMatchObject({ asked: 0, aligned: 0, windows: 0 })
    expect(logitsOf).not.toHaveBeenCalled()
  })

  it('gives up on a window the model never answers, with a timeout that says which step', async () => {
    const logitsOf = (): Promise<Logits> => new Promise(() => {})
    await expect(alignChunks([chunk(' ab', 0.9, 1.2)], quiet(4), run({ logitsOf, windowMs: 50 }))).rejects.toMatchObject({
      name: 'AlignTimeout',
      stage: 'window',
    })
  })

  it('lets the model throw, for alignRecognised to catch', async () => {
    const logitsOf = async (): Promise<Logits> => {
      throw new Error('out of memory')
    }
    await expect(alignChunks([chunk(' ab', 0.9, 1.2)], quiet(4), run({ logitsOf }))).rejects.toThrow('out of memory')
  })
})

describe('alignRecognised', () => {
  const calls: string[] = []
  /** The loaded model: the spikes in SAID, however long the slice. */
  const model = () => {
    const spoken = scripted(SAID)
    return Object.assign(
      async (inputs: { input_values: { data: Float32Array } }) => {
        const l = await spoken(inputs.input_values.data)
        return { logits: { data: l.data, dims: [1, l.T, l.V] } }
      },
      { sessions: undefined },
    )
  }

  beforeEach(() => {
    calls.length = 0
    hf.from_pretrained.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The vocabulary comes from the network the first time; here it is a stand-in.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(VOCAB))),
    )
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('hands back the chunks exactly as they came when the model will not load', async () => {
    hf.from_pretrained.mockRejectedValue(new Error('no network'))
    const { alignRecognised } = await import('./alignRunner')
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)]
    const told: Array<[number | null, boolean]> = []
    const out = await alignRecognised(chunks, quiet(4), 'en', (p, d) => told.push([p, d]))
    expect(out).toEqual(chunks)
    expect(out.some((c) => c.aligned)).toBe(false)
    expect(told[0]).toEqual([null, false])
  })

  it('hands them back too when the vocabulary cannot be fetched', async () => {
    hf.from_pretrained.mockResolvedValue(model())
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { alignRecognised } = await import('./alignRunner')
    const chunks = [chunk(' ab', 0.9, 1.2)]
    expect(await alignRecognised(chunks, quiet(4), 'en', () => {})).toEqual(chunks)
  })

  it('times the words with the loaded model', async () => {
    hf.from_pretrained.mockResolvedValue(model())
    const { alignRecognised } = await import('./alignRunner')
    const out = await alignRecognised([chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)], quiet(4), 'en', () => {})
    expect(out.map((c) => c.aligned)).toEqual([true, true])
    expect(out[0]!.timestamp[0]).toBeCloseTo(0.785, 3)
  })

  it('falls back to the CPU when the GPU cannot run it, once, and keeps the model after', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } })
    hf.from_pretrained.mockImplementation(async (_id: string, opts: { device: string }) => {
      calls.push(opts.device)
      if (opts.device === 'webgpu') throw new Error('shader compile failed')
      return model()
    })
    const { alignRecognised } = await import('./alignRunner')
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)]
    const first = await alignRecognised(chunks, quiet(4), 'en', () => {})
    const second = await alignRecognised(chunks, quiet(4), 'en', () => {})
    expect(first.map((c) => c.aligned)).toEqual([true, true])
    expect(second.map((c) => c.aligned)).toEqual([true, true])
    expect(calls).toEqual(['webgpu', 'wasm'])
  })

  // A step that stops answering must cost the caption nothing and must end BEFORE the
  // main thread's watchdog (transcribe.ts, LISTEN_FLOOR_MS at the least) kills the
  // worker, which would throw away every word Whisper had finished. Each case lets
  // one millisecond less than that floor pass on a fake clock and asks whether the run is over.
  describe('when a step stops answering', () => {
    const never = (): Promise<never> => new Promise(() => {})
    const chunks = [chunk(' ab', 0.9, 1.2), chunk(' cd', 1.7, 2.0)]
    /** A real pause, which the fake clock does not touch: the module load and the vocabulary are real I/O. */
    const real = (ms: number): Promise<void> => sleep(ms)
    /**
     * Starts a run and, once `ready` says the step under test has begun, lets `ms` of fake time pass five seconds at a
     * time and says what the run had come back with by then (null: still waiting). The clock only starts when the
     * step does, so how long the real I/O before it took cannot move a deadline.
     */
    async function runFor(ms: number, ready: () => boolean) {
      const { alignRecognised } = await import('./alignRunner')
      // The model module is loaded before the clock is faked: a dynamic import under it never comes back.
      await import('@huggingface/transformers')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      let out: WordChunk[] | null = null
      void alignRecognised(chunks, quiet(4), 'en', () => {}).then((c) => (out = c))
      for (let i = 0; !ready() && i < 2_000; i++) await real(1)
      for (let t = 0; t < ms; t += 5_000) {
        await real(1)
        await vi.advanceTimersByTimeAsync(Math.min(5_000, ms - t))
      }
      await real(5)
      return out as WordChunk[] | null
    }
    const loadBegan = () => hf.from_pretrained.mock.calls.length > 0
    /** A loaded model whose session never answers, and the spy that says when it was asked. */
    const hung = () => {
      const session = vi.fn(never)
      return { model: Object.assign(session, { sessions: undefined }), asked: () => session.mock.calls.length > 0 }
    }

    it('gives up on a model that never loads, in time, with the chunks as they came', async () => {
      hf.from_pretrained.mockReturnValue(never())
      expect(await runFor(LISTEN_FLOOR_MS - 1, loadBegan)).toEqual(chunks)
    })

    it('gives up on a download that reported once and then went quiet', async () => {
      hf.from_pretrained.mockImplementation((_id: string, opts: { progress_callback: (p: object) => void }) => {
        opts.progress_callback({ status: 'progress', progress: 10, total: 247_000_000 })
        return never()
      })
      expect(await runFor(LISTEN_FLOOR_MS - 1, loadBegan)).toEqual(chunks)
    })

    it('lets a slow download be as long as it keeps reporting', async () => {
      // 120 s in all, never 40 s between two reports.
      hf.from_pretrained.mockImplementation(async (_id: string, opts: { progress_callback: (p: object) => void }) => {
        for (let i = 1; i <= 4; i++) {
          await new Promise((r) => setTimeout(r, 30_000))
          opts.progress_callback({ status: 'progress', progress: i * 25, total: 247_000_000 })
        }
        return model()
      })
      const out = await runFor(121_000, loadBegan)
      expect(out?.map((c) => c.aligned)).toEqual([true, true])
    })

    it('gives up on a vocabulary that never arrives, and cancels the request', async () => {
      hf.from_pretrained.mockResolvedValue(model())
      let signal: AbortSignal | undefined
      const fetching = vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return never()
      })
      vi.stubGlobal('fetch', fetching)
      expect(await runFor(LISTEN_FLOOR_MS - 1, () => fetching.mock.calls.length > 0)).toEqual(chunks)
      expect(signal?.aborted).toBe(true)
    })

    it('gives up on a model that loaded and then never answers a window', async () => {
      const { model: stuck, asked } = hung()
      hf.from_pretrained.mockResolvedValue(stuck)
      expect(await runFor(LISTEN_FLOOR_MS - 1, asked)).toEqual(chunks)
    })

    it('forgets a load that timed out, so the next run tries again', async () => {
      hf.from_pretrained.mockReturnValueOnce(never()).mockResolvedValue(model())
      expect(await runFor(LISTEN_FLOOR_MS - 1, loadBegan)).toEqual(chunks)
      const { alignRecognised } = await import('./alignRunner')
      const second = await alignRecognised(chunks, quiet(4), 'en', () => {})
      expect(second.map((c) => c.aligned)).toEqual([true, true])
      expect(hf.from_pretrained).toHaveBeenCalledTimes(2)
    })

    it('drops a session that hung on a window and keeps off the GPU after it', async () => {
      vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } })
      const { model: stuck, asked } = hung()
      hf.from_pretrained.mockImplementation(async (_id: string, opts: { device: string }) => {
        calls.push(opts.device)
        return calls.length === 1 ? stuck : model()
      })
      expect(await runFor(LISTEN_FLOOR_MS - 1, asked)).toEqual(chunks)
      const { alignRecognised } = await import('./alignRunner')
      const second = await alignRecognised(chunks, quiet(4), 'en', () => {})
      expect(second.map((c) => c.aligned)).toEqual([true, true])
      expect(calls).toEqual(['webgpu', 'wasm'])
    })

    it('tells the main thread before the load, after it and after each window, so its watchdog starts again', async () => {
      hf.from_pretrained.mockResolvedValue(model())
      const told: Array<[number | null, boolean]> = []
      const { alignRecognised } = await import('./alignRunner')
      await alignRecognised(chunks, quiet(4), 'en', (p, d) => told.push([p, d]))
      expect(told).toEqual([
        [null, false],
        [0, false],
        [100, false],
      ])
    })

    it('has every deadline shorter than the least the main thread waits', async () => {
      const m = await import('./alignRunner')
      for (const ms of [m.ALIGN_LOAD_STALL_MS, m.ALIGN_VOCAB_MS, m.ALIGN_WINDOW_MS]) {
        expect(ms).toBeGreaterThan(0)
        expect(ms).toBeLessThan(LISTEN_FLOOR_MS)
      }
    })
  })
})
