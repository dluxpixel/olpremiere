/// <reference lib="webworker" />
// Whisper speech-to-text, fully local. Runs in a dedicated worker so model
// download + inference never touch the UI thread, and the transformers.js
// bundle (large) is dynamic-imported HERE — the main app bundle stays lean.
// WebGPU when the machine has it, WASM otherwise. The model downloads once
// from the Hugging Face CDN and lands in the browser cache; after that the
// whole pipeline is offline. No audio ever leaves the machine.

// English-only model: the Jettism format is English-first. For multilingual
// captions swap to 'onnx-community/whisper-base_timestamped'. It MUST be a
// `_timestamped` onnx-community export: word-level timestamps need the
// cross-attention outputs only those exports carry, and the older Xenova
// exports trip the current onnxruntime's session validation outright.
const MODEL = 'onnx-community/whisper-base.en_timestamped'

export interface TranscribeRequest {
  /** Mono PCM at 16kHz (the Whisper feature-extractor rate). */
  pcm: Float32Array
}

export type TranscribeResponse =
  | { type: 'progress'; phase: 'model' | 'listening'; pct: number | null }
  | { type: 'done'; chunks: { text: string; timestamp: [number, number | null] }[] }
  | { type: 'error'; message: string }

const post = (msg: TranscribeResponse): void => {
  ;(self as unknown as Worker).postMessage(msg)
}

self.onmessage = (e: MessageEvent<TranscribeRequest>) => {
  void run(e.data.pcm)
}

type Asr = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>

// The loaded pipeline is cached in module scope and this worker is kept ALIVE
// across transcriptions (see transcribe.ts), so the model loads exactly ONCE
// per session — no "Downloading Whisper" every time. The Hugging Face files
// themselves live in the browser Cache Storage, so it also survives reloads.
let asrCache: Asr | null = null
let loadingAsr: Promise<Asr> | null = null

async function getAsr(): Promise<Asr> {
  if (asrCache) return asrCache
  if (loadingAsr) return loadingAsr
  loadingAsr = (async () => {
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
      (await pipeline('automatic-speech-recognition', MODEL, {
        device,
        // The int8 ("q8") decoder trips onnxruntime's MatMulNBits pass; the q4
        // decoder is built for it and loads cleanly.
        ...(device === 'wasm' ? { dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' } } : {}),
        progress_callback,
      })) as unknown as Asr

    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    const hasWebgpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null))
    asrCache = await makeAsr(hasWebgpu ? 'webgpu' : 'wasm')
    return asrCache
  })()
  try {
    return await loadingAsr
  } finally {
    loadingAsr = null
  }
}

const OPTS = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 }

async function run(pcm: Float32Array): Promise<void> {
  try {
    const asr = await getAsr()
    post({ type: 'progress', phase: 'listening', pct: null })
    let out: { chunks?: { text: string; timestamp: [number, number | null] }[] }
    try {
      out = await asr(pcm, OPTS)
    } catch (err) {
      // A GPU pipeline can still fail shader compile at inference — fall back to
      // a WASM pipeline once and cache THAT for subsequent runs.
      const { pipeline } = await import('@huggingface/transformers')
      asrCache = (await pipeline('automatic-speech-recognition', MODEL, {
        device: 'wasm',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
      })) as unknown as Asr
      out = await asrCache(pcm, OPTS)
      void err
    }
    post({ type: 'done', chunks: out.chunks ?? [] })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
