/// <reference lib="webworker" />
// Whisper speech-to-text, fully local. Runs in a dedicated worker so model
// download + inference never touch the UI thread, and the transformers.js
// bundle (large) is dynamic-imported HERE, so the main app bundle stays lean.
// WebGPU when the machine has it, WASM otherwise. The model downloads once
// from the Hugging Face CDN and lands in the browser cache; after that the
// whole pipeline is offline. No audio ever leaves the machine.

// Model + generation options route per language (transcribeConfig.ts):
// English keeps the `.en` model, Czech/auto use the multilingual export. Both
// are `_timestamped` onnx-community exports: word timestamps need the
// cross-attention outputs only those carry, and older Xenova exports trip
// onnxruntime's session validation outright.
import { generationOptsFor, modelFor, type CaptionLanguage } from './transcribeConfig'

export interface TranscribeRequest {
  /** Mono PCM at 16kHz (the Whisper feature-extractor rate). Absent on a warm. */
  pcm: Float32Array
  /** Caption language, which picks the model AND the generation options. */
  language: CaptionLanguage
  /**
   * Load the model and stop. Used by the boot card so the FIRST caption run
   * does not pay for the download and the pipeline build in the middle of an
   * edit. Never transcribes and never touches `pcm`.
   */
  warm?: boolean
}

export type TranscribeResponse =
  | { type: 'progress'; phase: 'model' | 'listening'; pct: number | null; downloading?: boolean }
  | { type: 'done'; chunks: { text: string; timestamp: [number, number | null] }[] }
  | { type: 'warmed' }
  | { type: 'error'; message: string }

const post = (msg: TranscribeResponse): void => {
  ;(self as unknown as Worker).postMessage(msg)
}

self.onmessage = (e: MessageEvent<TranscribeRequest>) => {
  // A warm request loads the model and nothing else, so the boot card can pay
  // for it instead of his first caption run doing it mid-edit. It goes through
  // the SAME getAsr cache the real run uses, so warming costs the real run
  // nothing and cannot load a second copy.
  if (e.data.warm) {
    void getAsr(modelFor(e.data.language ?? 'en'))
      .then(() => post({ type: 'warmed' }))
      .catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
    return
  }
  void run(e.data.pcm, e.data.language ?? 'en')
}

type Asr = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>

// Loaded pipelines are cached PER MODEL in module scope and this worker is
// kept ALIVE across transcriptions (see transcribe.ts), so each model loads at
// most once per session. Switching English↔Czech keeps both resident rather
// than thrashing. The Hugging Face files live in the browser Cache Storage,
// so downloads also survive reloads.
const asrCache = new Map<string, Asr>()
const loadingAsr = new Map<string, Promise<Asr>>()

async function getAsr(model: string): Promise<Asr> {
  const cached = asrCache.get(model)
  if (cached) return cached
  const loading = loadingAsr.get(model)
  if (loading) return loading
  const load = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    // Persist model files in the browser Cache Storage across sessions.
    ;(env as { useBrowserCache?: boolean; allowLocalModels?: boolean }).useBrowserCache = true
    ;(env as { useBrowserCache?: boolean; allowLocalModels?: boolean }).allowLocalModels = false

    let biggestTotal = 0
    // Whether anything is coming off the NETWORK this time. transformers.js emits
    // `download` only when it actually fetches a file; a load served out of the
    // cache goes straight to progress and done. Without this the pill claimed
    // "Downloading Whisper (once)" every single time the model was loaded from
    // disk, which is why he saw it on every new version and stopped believing it.
    let downloading = false
    const progress_callback = (p: { status?: string; progress?: number; total?: number; file?: string }) => {
      if (p.status === 'initiate' && p.file) console.log('OL Premiere transcribe: fetching', p.file)
      if (p.status === 'download') downloading = true
      if (p.status === 'progress' && typeof p.progress === 'number') {
        if ((p.total ?? 0) >= biggestTotal) {
          biggestTotal = p.total ?? 0
          post({ type: 'progress', phase: 'model', pct: p.progress, downloading })
        }
      }
    }
    const makeAsr = async (device: 'webgpu' | 'wasm'): Promise<Asr> =>
      (await pipeline('automatic-speech-recognition', model, {
        device,
        // The int8 ("q8") decoder trips onnxruntime's MatMulNBits pass; the q4
        // decoder is built for it and loads cleanly.
        ...(device === 'wasm' ? { dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' } } : {}),
        progress_callback,
      })) as unknown as Asr

    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    const hasWebgpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null))
    const asr = await makeAsr(hasWebgpu ? 'webgpu' : 'wasm')
    asrCache.set(model, asr)
    return asr
  })()
  loadingAsr.set(model, load)
  try {
    return await load
  } finally {
    loadingAsr.delete(model)
  }
}

/**
 * Hard ceiling on the tokens Whisper may generate for ONE chunk. This is what
 * stops a music-only clip from taking the whole window down, and the mechanism
 * is specific enough to be worth writing out.
 *
 * With word timestamps on, transformers.js does not simply decode a chunk. It
 * runs a SEEK LOOP (`_generate_with_seek`, models/whisper/modeling_whisper.js):
 * generate, find the last pair of consecutive timestamp tokens, advance `seek`
 * to whatever time that pair points at, repeat until `seek` reaches the end of
 * the audio. On a long uninterrupted instrumental bed Whisper falls into its
 * documented repetition loop and emits degenerate timestamp pairs pointing back
 * at 0.00, so the offset it computes is ZERO, `seek` never moves, and the loop
 * never terminates. Every pass appends more tokens and allocates another set of
 * cross-attention tensors for the timestamp alignment, so memory climbs until
 * the worker dies. A worker shares its renderer process, which is why the page
 * went with it instead of the run simply failing.
 *
 * Setting max_new_tokens fixes both halves at once. It caps the decode, and the
 * library skips that seek loop entirely when it is set. Skipping it costs
 * nothing here: the loop exists to walk audio LONGER than one 30 s Whisper
 * window, and `chunk_length_s` below already hands the model exactly one window
 * per call, so a correct run only ever made a single pass through it.
 *
 * The number cannot cost him a word. Whisper's decoder holds 448 positions
 * total, so no chunk was ever going to run past that anyway. 300 tokens over a
 * 30 s chunk is 10 per second; the fastest real speech is around 4 words a
 * second, near 6 tokens, so ordinary speech keeps a wide margin and it is only
 * the runaway, which repeats far faster than anyone talks, that gets cut.
 */
const MAX_NEW_TOKENS_PER_CHUNK = 300

/**
 * Deliberately NOT set here: `no_repeat_ngram_size`. Banning a repeated token
 * run is the textbook answer to a Whisper repetition loop and it was measured
 * on 2026-08-09 rather than assumed. It backfired. Stopping the loop does not
 * stop the DECODE, so the model simply wanders and fills the same budget with
 * varied junk instead of repeated junk: on the 60 s rigid bed the invented word
 * count went from 9 to 242, and on the 40 s one it only fell from 296 to 234.
 * Worse in total, so it was taken back out. The repetition is dealt with after
 * the fact instead, in tidyTranscribedWords, where a filter can only ever
 * remove words and can never change one.
 */
const OPTS = {
  return_timestamps: 'word',
  chunk_length_s: 30,
  stride_length_s: 5,
  max_new_tokens: MAX_NEW_TOKENS_PER_CHUNK,
}

async function run(pcm: Float32Array, language: CaptionLanguage): Promise<void> {
  try {
    const model = modelFor(language)
    // language/task are GENERATION options (multilingual only, since a `.en`
    // pipeline rejects them); the model choice above is what routes Czech.
    const opts = { ...OPTS, ...generationOptsFor(language) }
    const asr = await getAsr(model)
    post({ type: 'progress', phase: 'listening', pct: null })
    let out: { chunks?: { text: string; timestamp: [number, number | null] }[] }
    try {
      out = await asr(pcm, opts)
    } catch (err) {
      // A GPU pipeline can still fail shader compile at inference. Fall back to
      // a WASM pipeline once and cache THAT for subsequent runs.
      const { pipeline } = await import('@huggingface/transformers')
      const wasmAsr = (await pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
      })) as unknown as Asr
      asrCache.set(model, wasmAsr)
      out = await wasmAsr(pcm, opts)
      void err
    }
    post({ type: 'done', chunks: out.chunks ?? [] })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
