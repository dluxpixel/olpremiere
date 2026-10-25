// The model half of the word aligner. ctcAlign.ts is the maths on a table of
// per-frame log probabilities; this file feeds it: it cuts a recording into the
// windows ctcAlign picks, runs the multilingual wav2vec2 on each, and writes the
// aligner's word times back onto the recogniser's chunks. It runs in the speech
// worker right after Whisper, on the same PCM (transcribeWorker.ts).
//
// ⛔ IT MAY ONLY EVER MAKE A CAPTION BETTER, SO IT NEVER THROWS. The aligner is a
// second model on top of one that already works. A download that fails, a GPU
// that cannot run it, a window that does not match the audio: every one of those
// hands back Whisper's chunks exactly as they came, and the old path (the lag
// taken off by wordTiming.correctWordLag) carries on as if this did not exist.
// `alignChunks` below does the work and may throw; `alignRecognised` is the
// door the worker uses, and it cannot.

import { FRAME_S, alignWords, alignmentWindows, echoedWords, extendAlignedEnds, isSilentText, makeAlignVocab, vocabTokens } from './ctcAlign'
import type { AlignInput, AlignVocab, AlignedWord, Emissions } from './ctcAlign'
import { alignerFor } from './transcribeConfig'
import type { AlignerModel, CaptionLanguage } from './transcribeConfig'

/** Whisper's sample rate, which is also the aligner's. */
const RATE = 16_000

/** One word as the recogniser hands it back; `aligned` is set only by this file. */
export interface WordChunk {
  text: string
  timestamp: [number, number | null]
  aligned?: boolean
}

/** Raw model output for one slice: T frames of V logits, row-major. */
export interface Logits {
  data: Float32Array
  T: number
  V: number
}

export interface AlignRun {
  aligner: AlignerModel
  /** The model's vocabulary (vocab.json): token text to id. */
  vocab: Readonly<Record<string, number>>
  /** Runs the model on one slice that has already been normalised. */
  logitsOf: (slice: Float32Array) => Promise<Logits>
  /** Told the share done (0 to 100) after each window. */
  report?: (pct: number) => void
  /** No window is started after this long; the words in later ones keep Whisper's times. */
  budgetMs: number
  now?: () => number
  /** How long one `logitsOf` may take before the aligner gives up (AlignTimeout); ALIGN_WINDOW_MS when absent. */
  windowMs?: number
}

export interface AlignResult {
  chunks: WordChunk[]
  /** Words timed by the aligner. */
  aligned: number
  /** Words it was asked about: every chunk that is a word, not a tag or a mark. */
  asked: number
  windows: number
  /** Windows actually run (fewer than `windows` when the budget ran out). */
  windowsRun: number
}

/** Bracketed noise tags ([MUSIC], (laughs)) are not words; wordsFromAsrChunks drops them too. */
const BRACKETED = /^[[(].*[\])]$/

/** Under 0.1 s of audio the model has no frame to read a letter from. */
const MIN_SLICE = 1600

// ⛔ EVERY WAIT IN THIS FILE ENDS BEFORE THE MAIN THREAD LOSES PATIENCE. The aligner
// runs inside the speech run, and transcribe.ts keeps one watchdog over all of it
// (LISTEN_FLOOR_MS, 60 s, plus 10 s per second of audio), wound back by every
// progress message the worker posts. A wait with no deadline here, a download that
// stalls on 247 MB, a session that never answers, a vocabulary fetch with no
// reply, therefore ended in that watchdog killing the worker, and the run failed
// as "The speech model stopped responding" with every word Whisper had finished
// thrown away, for a model whose whole job is to make a caption a little better.
// So each wait has its own shorter deadline, it throws AlignTimeout, and
// alignRecognised answers that like any other failure: Whisper's chunks, unchanged.
//
// They are shorter than the 60 s floor because the quietest stretch the watchdog
// can see is one of these waits, started right after a progress message
// (alignRecognised posts one before the load, one when it is done and one after
// each window). alignRunner.test.ts pins the sizes against the watchdog's floor.

/** A model load that has gone this long without one download report is stalled. Each report starts the count again, so a slow download that keeps moving is let be. */
export const ALIGN_LOAD_STALL_MS = 40_000
/** The vocabulary is one 147 KB file; if it has not come in this long it is not coming. */
export const ALIGN_VOCAB_MS = 20_000
/** One window through the model. A 20 s slice takes a few seconds on the CPU; this is the hung session, not the slow one. */
export const ALIGN_WINDOW_MS = 40_000

export type AlignStage = 'load' | 'vocabulary' | 'window'

/** A step of the aligner stopped answering. Thrown inside alignRecognised's try, so the chunks come back as they were. */
export class AlignTimeout extends Error {
  constructor(
    readonly stage: AlignStage,
    ms: number,
  ) {
    super(`The word timing ${stage} did not answer in ${Math.round(ms / 1000)} s`)
    this.name = 'AlignTimeout'
  }
}

/**
 * Runs `start` and gives up on it, with an AlignTimeout, if it has not finished
 * `ms` after the last `touch` (the first touch is now). `start` is handed `touch`
 * so work that reports as it goes, like a download, can start the count again.
 *
 * The work itself cannot be cancelled (a model load and an inference run are not
 * abortable), so it is left to finish or fail on its own with nobody listening.
 */
function guarded<T>(start: (touch: () => void) => PromiseLike<T>, ms: number, stage: AlignStage): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let over = false
  let expire!: (reason: unknown) => void
  const clock = new Promise<never>((_, reject) => {
    expire = reject
  })
  const touch = (): void => {
    if (over) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      over = true
      expire(new AlignTimeout(stage, ms))
    }, ms)
  }
  touch()
  // An async wrapper, so a `start` that throws outright is a rejection like any other.
  const work = (async () => start(touch))()
  return Promise.race([work, clock]).finally(() => {
    over = true
    clearTimeout(timer)
  })
}

/** Zero mean and unit variance over the slice: what the model's feature extractor does (preprocessor_config.json, do_normalize). */
export function normaliseSlice(slice: Float32Array): Float32Array {
  const n = slice.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += slice[i]!
  mean /= n || 1
  let variance = 0
  for (let i = 0; i < n; i++) variance += (slice[i]! - mean) * (slice[i]! - mean)
  variance /= n || 1
  const inv = 1 / Math.sqrt(variance + 1e-7)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (slice[i]! - mean) * inv
  return out
}

/**
 * The few columns of the model's output one window needs: the blank, the
 * delimiter and every token its words spell. The model has ~10,000 outputs (a
 * character for every script it knows) and a window needs about 30 of them, so
 * the lattice is built over those, plus one last column that holds the best of
 * all the others. That column is what the star tokens (number words) are scored
 * against, so the numbers are the same as scoring all 10,000.
 */
function columnsFor(words: readonly AlignInput[], full: AlignVocab): { ids: number[]; vocab: AlignVocab } {
  const need = new Set<number>([full.blankId])
  if (full.delimiterId !== null) need.add(full.delimiterId)
  for (const w of words) for (const id of vocabTokens(w.text, full) ?? []) need.add(id)
  const ids = [...need].sort((a, b) => a - b)
  const column = new Map(ids.map((id, k) => [id, k]))
  const reduced = new Map<string, number>()
  for (const [ch, id] of full.ids) {
    const k = column.get(id)
    if (k !== undefined) reduced.set(ch, k)
  }
  return {
    ids,
    vocab: {
      ids: reduced,
      blankId: column.get(full.blankId)!,
      delimiterId: full.delimiterId === null ? null : column.get(full.delimiterId)!,
      fold: full.fold,
    },
  }
}

/** Log-softmax over ALL of the model's outputs, then only the wanted columns kept, plus the best of the rest. */
export function reduceLogits(logits: Logits, ids: readonly number[]): Emissions {
  const { data, T, V } = logits
  if (ids.some((id) => id >= V)) throw new Error('The aligner vocabulary is larger than the model output')
  const W = ids.length + 1
  const wanted = new Uint8Array(V)
  for (const id of ids) wanted[id] = 1
  const logProbs = new Float32Array(T * W)
  for (let t = 0; t < T; t++) {
    const o = t * V
    let max = -Infinity
    for (let k = 0; k < V; k++) if (data[o + k]! > max) max = data[o + k]!
    let sum = 0
    let rest = -Infinity
    for (let k = 0; k < V; k++) {
      const x = data[o + k]!
      sum += Math.exp(x - max)
      if (!wanted[k] && x > rest) rest = x
    }
    const lse = max + Math.log(sum)
    for (let j = 0; j < ids.length; j++) logProbs[t * W + j] = data[o + ids[j]!]! - lse
    // -Infinity when the wanted columns are every output (a toy vocabulary): kept finite.
    logProbs[t * W + ids.length] = Math.max(rest - lse, -1e4)
  }
  return { logProbs, T, V: W }
}

/**
 * Times every word chunk against the audio. Chunks that are not words, and
 * words the aligner did not trust (ctcAlign.alignWords says when), come back
 * untouched; the rest get the aligner's start and end and `aligned: true`.
 * Throws if the model does; see alignRecognised for the door that does not.
 */
export async function alignChunks(chunks: readonly WordChunk[], pcm: Float32Array, run: AlignRun): Promise<AlignResult> {
  const now = run.now ?? Date.now
  // The chunks that are words, with the times wordsFromAsrChunks would give them.
  const where: number[] = []
  const rough: AlignInput[] = []
  chunks.forEach((c, i) => {
    const text = c.text.trim()
    if (!text || BRACKETED.test(text)) return
    const startS = Math.max(0, c.timestamp[0] ?? 0)
    let endS = c.timestamp[1] ?? NaN
    if (!Number.isFinite(endS) || endS <= startS) endS = startS + Math.max(0.2, 0.05 * text.length)
    where.push(i)
    rough.push({ text, startS, endS })
  })
  // A passage the recogniser wrote out twice is left out of the alignment (it keeps
  // its time): the audio has it once, and two copies of the text would squeeze one.
  const echo = echoedWords(rough)
  const live: number[] = []
  rough.forEach((_, i) => {
    if (!echo[i]) live.push(i)
  })
  const heard = live.map((i) => rough[i]!)
  const windows = heard.length > 0 ? alignmentWindows(heard, pcm.length / RATE) : []
  const timed: AlignedWord[] = rough.map((w) => ({ startS: w.startS, endS: w.endS, aligned: false }))
  const full = makeAlignVocab(run.vocab, run.aligner.blank)
  const started = now()
  let windowsRun = 0
  for (const win of windows) {
    if (now() - started > run.budgetMs) break
    windowsRun++
    const a = Math.floor(win.fromS * RATE)
    const b = Math.min(pcm.length, Math.ceil(win.toS * RATE))
    if (b - a < MIN_SLICE) continue
    const words = heard.slice(win.first, win.end)
    const cols = columnsFor(words, full)
    const slice = normaliseSlice(pcm.subarray(a, b))
    const logits = await guarded(() => run.logitsOf(slice), run.windowMs ?? ALIGN_WINDOW_MS, 'window')
    const emissions = reduceLogits(logits, cols.ids)
    const got = alignWords(words, emissions, FRAME_S, a / RATE, cols.vocab, { biasS: run.aligner.onsetBiasS })
    got.words.forEach((w, k) => {
      timed[live[win.first + k]!] = w
    })
    run.report?.(Math.round((100 * windowsRun) / windows.length))
  }
  // Once, over every word in order, so a window's last word is held back by the next window's first.
  // A word the aligner did not time keeps the recogniser's time, which runs late until
  // correctWordLag moves it, so the word before it keeps its own end: the tail could
  // otherwise run over it. Marks with nothing to say aloud are looked through.
  const final = extendAlignedEnds(timed).map((w, k) => {
    if (!w.aligned) return w
    let j = k + 1
    while (j < timed.length && isSilentText(rough[j]!.text)) j++
    return j < timed.length && !timed[j]!.aligned ? timed[k]! : w
  })
  const out = chunks.map((c) => c)
  let aligned = 0
  final.forEach((w, k) => {
    if (!w.aligned) return
    const i = where[k]!
    out[i] = { ...chunks[i]!, timestamp: [w.startS, w.endS], aligned: true }
    aligned++
  })
  return { chunks: out, aligned, asked: rough.length, windows: windows.length, windowsRun }
}

// ----------------------------------------------------------------- the model

/** Told how far the model has loaded (null: unknown) and whether files are coming off the network. */
export type LoadReport = (pct: number | null, downloading: boolean) => void

type LoadProgress = { status?: string; progress?: number; total?: number }

/**
 * Only the biggest file reports, like the speech model's loader (transcribeWorker.modelProgress).
 * Answers whether this event was passed on, which is the one the main thread hears.
 */
function fileProgress(report: LoadReport): (p: LoadProgress) => boolean {
  let biggest = 0
  let downloading = false
  return (p) => {
    if (p.status === 'download') downloading = true
    if (p.status === 'progress' && typeof p.progress === 'number' && (p.total ?? 0) >= biggest) {
      biggest = p.total ?? 0
      report(p.progress, downloading)
      return true
    }
    return false
  }
}

/**
 * The model's vocabulary, from the same browser cache transformers.js keeps the
 * model files in. transformers.js reads it through a tokenizer, and the
 * multilingual model ships no tokenizer.json, so it is fetched here: the first
 * time off the network, ever after out of the cache (so offline is fine).
 */
async function fetchVocab(id: string, signal: AbortSignal): Promise<Record<string, number>> {
  const url = `https://huggingface.co/${id}/resolve/main/vocab.json`
  const cache = typeof caches === 'undefined' ? null : await caches.open('transformers-cache').catch(() => null)
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined
  if (hit) return (await hit.json()) as Record<string, number>
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`The word timing vocabulary did not load (${res.status})`)
  await cache?.put(url, res.clone()).catch(() => {})
  return (await res.json()) as Record<string, number>
}

/** fetchVocab with a deadline (ALIGN_VOCAB_MS): a request that never answers is aborted and is an AlignTimeout. */
function readVocab(id: string, ms = ALIGN_VOCAB_MS): Promise<Record<string, number>> {
  const ctl = new AbortController()
  return guarded(() => fetchVocab(id, ctl.signal), ms, 'vocabulary').catch((err: unknown) => {
    ctl.abort()
    throw err
  })
}

interface Loaded {
  vocab: Record<string, number>
  logitsOf: (slice: Float32Array) => Promise<Logits>
}

/** One loaded model per aligner and device, for the life of the worker. */
const loaded = new Map<string, Promise<Loaded>>()
/** The GPU failed to run the aligner: wasm for the rest of the session. Said once. */
let gpuBad = false
let warned = false

async function buildModel(aligner: AlignerModel, device: 'webgpu' | 'wasm', report: LoadReport): Promise<Loaded> {
  const tf = await import('@huggingface/transformers')
  ;(tf.env as { useBrowserCache?: boolean; allowLocalModels?: boolean }).useBrowserCache = true
  ;(tf.env as { useBrowserCache?: boolean; allowLocalModels?: boolean }).allowLocalModels = false
  // The model first: if it cannot even be asked for, no vocabulary fetch is left running.
  // Its deadline is a STALL: every report the download passes on starts the count again, so a
  // slow connection that keeps moving is let be and one that has gone quiet is not. Only the
  // reports the main thread hears count, or its watchdog could run out while this one did not.
  const progress = fileProgress(report)
  const loading = guarded(
    (touch) =>
      tf.AutoModelForCTC.from_pretrained(aligner.id, {
        device,
        dtype: aligner.dtype,
        progress_callback: (p: LoadProgress) => {
          if (progress(p)) touch()
        },
      }),
    ALIGN_LOAD_STALL_MS,
    'load',
  )
  const [model, vocab] = await Promise.all([loading, readVocab(aligner.id)])
  const callable = model as unknown as {
    (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }>
    sessions?: Record<string, { inputNames?: string[] } | undefined>
  }
  // base-960h takes no attention mask and the multilingual model needs one; an input the
  // session does not name only draws a warning, so when the names cannot be read, send it.
  const names = callable.sessions?.model?.inputNames
  const wantsMask = names ? names.includes('attention_mask') : true
  console.log(`OL Premiere transcribe: aligner ${aligner.id} on ${device} ${aligner.dtype}`)
  return {
    vocab,
    logitsOf: async (slice) => {
      const inputs: Record<string, unknown> = { input_values: new tf.Tensor('float32', slice, [1, slice.length]) }
      if (wantsMask) inputs.attention_mask = new tf.Tensor('int64', new BigInt64Array(slice.length).fill(1n), [1, slice.length])
      const { logits } = await callable(inputs)
      const [, T, V] = logits.dims
      return { data: logits.data, T: T!, V: V! }
    },
  }
}

function modelOn(aligner: AlignerModel, device: 'webgpu' | 'wasm', report: LoadReport): Promise<Loaded> {
  const key = `${aligner.id}|${device}`
  const known = loaded.get(key)
  if (known) return known
  const made = buildModel(aligner, device, report)
  loaded.set(key, made)
  // A load that failed or timed out is forgotten, so the next run tries again. Only
  // its own entry: a newer one under the same key is somebody else's.
  made.catch(() => {
    if (loaded.get(key) === made) loaded.delete(key)
  })
  return made
}

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  if (gpuBad || typeof navigator === 'undefined') return 'wasm'
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null
  return adapter ? 'webgpu' : 'wasm'
}

/**
 * How long the aligner may spend on one recording before the rest of it keeps
 * Whisper's own times: a floor, plus a share of the audio's length.
 */
export const ALIGN_BUDGET_FLOOR_MS = 30_000
export const ALIGN_BUDGET_PER_AUDIO_SECOND_MS = 1_000

/**
 * Times Whisper's words against the sound, for the worker. Never throws: any
 * failure returns the chunks exactly as they came (see the top of this file).
 */
export async function alignRecognised(
  chunks: readonly WordChunk[],
  pcm: Float32Array,
  language: CaptionLanguage,
  report: LoadReport,
): Promise<WordChunk[]> {
  try {
    const aligner = alignerFor(language)
    const budgetMs = ALIGN_BUDGET_FLOOR_MS + (pcm.length / RATE) * ALIGN_BUDGET_PER_AUDIO_SECOND_MS
    for (;;) {
      // A beat before each attempt, the load and the windows (see the deadlines at the
      // top): the main thread's watchdog starts again on every one of them.
      report(null, false)
      const device = await pickDevice()
      try {
        const began = Date.now()
        const model = await modelOn(aligner, device, report)
        report(0, false)
        const r = await alignChunks(chunks, pcm, {
          aligner,
          vocab: model.vocab,
          logitsOf: model.logitsOf,
          report: (pct) => report(pct, false),
          budgetMs,
        })
        console.log(
          `OL Premiere transcribe: timed ${r.aligned} of ${r.asked} words against the sound on ${device} in ${((Date.now() - began) / 1000).toFixed(1)} s` +
            (r.windowsRun < r.windows ? ` (stopped after ${r.windowsRun} of ${r.windows} windows: out of time)` : ''),
        )
        return r.chunks
      } catch (err) {
        if (err instanceof AlignTimeout) {
          // Something stopped answering. No second attempt on the other device in the same
          // run: it would wait on the same download, and the watchdog is not far off.
          // A load that timed out has dropped its own entry (modelOn); a model that loaded
          // and then hung on a window is dropped here, so the next run builds a fresh
          // session instead of waiting on this one, and off the GPU if that is where it hung.
          if (err.stage === 'window') {
            loaded.delete(`${aligner.id}|${device}`)
            if (device === 'webgpu') gpuBad = true
          }
          throw err
        }
        if (device === 'wasm') throw err
        // The GPU could not run it. Said once, then wasm for the rest of the session.
        gpuBad = true
        loaded.delete(`${aligner.id}|${device}`)
        console.warn('OL Premiere transcribe: the word timing model failed on the GPU, trying the CPU', err)
      }
    }
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn('OL Premiere transcribe: word timing was skipped, the words keep the speech model\'s times', err)
    }
    return chunks.map((c) => c)
  }
}
