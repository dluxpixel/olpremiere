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
  /** Mono PCM at 16kHz (the Whisper feature-extractor rate). */
  pcm: Float32Array
  /** Caption language, which picks the model AND the generation options. */
  language: CaptionLanguage
}

export type TranscribeResponse =
  | { type: 'progress'; phase: 'model' | 'listening'; pct: number | null }
  | { type: 'done'; chunks: { text: string; timestamp: [number, number | null] }[] }
  | { type: 'error'; message: string }

const post = (msg: TranscribeResponse): void => {
  ;(self as unknown as Worker).postMessage(msg)
}

self.onmessage = (e: MessageEvent<TranscribeRequest>) => {
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
    const progress_callback = (p: { status?: string; progress?: number; total?: number; file?: string }) => {
      if (p.status === 'initiate' && p.file) console.log('OL Studio transcribe: fetching', p.file)
      if (p.status === 'progress' && typeof p.progress === 'number') {
        if ((p.total ?? 0) >= biggestTotal) {
          biggestTotal = p.total ?? 0
          post({ type: 'progress', phase: 'model', pct: p.progress })
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

const OPTS = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 }

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
