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

async function run(pcm: Float32Array): Promise<void> {
  try {
    const { pipeline } = await import('@huggingface/transformers')

    // Surface model-download progress; the largest file dominates, so tracking
    // the biggest total seen reads honestly without summing every sidecar.
    let biggestTotal = 0
    const progress_callback = (p: { status?: string; progress?: number; total?: number; file?: string }) => {
      // One line per model file — invaluable when diagnosing download issues.
      if (p.status === 'initiate' && p.file) console.log('OL Studio transcribe: fetching', p.file)
      if (p.status === 'progress' && typeof p.progress === 'number') {
        if ((p.total ?? 0) >= biggestTotal) {
          biggestTotal = p.total ?? 0
          post({ type: 'progress', phase: 'model', pct: p.progress })
        }
      }
    }

    type Asr = (
      audio: Float32Array,
      opts: Record<string, unknown>,
    ) => Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>
    const makeAsr = async (device: 'webgpu' | 'wasm'): Promise<Asr> =>
      (await pipeline('automatic-speech-recognition', MODEL, {
        device,
        // The int8 ("q8"/quantized) decoder export trips onnxruntime's
        // MatMulNBits weight-transpose pass (its tied-embedding QDQ pattern
        // has no group scales), so session creation fails. The q4 decoder is
        // BUILT for MatMulNBits — scales present — and loads cleanly.
        ...(device === 'wasm' ? { dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' } } : {}),
        progress_callback,
      })) as unknown as Asr

    // Probe the adapter up front: pipeline() resolves lazily, so a missing GPU
    // only explodes at first INFERENCE — too late for a pipeline-level catch.
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    const hasWebgpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null))

    const OPTS = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 }
    let asr = await makeAsr(hasWebgpu ? 'webgpu' : 'wasm')
    post({ type: 'progress', phase: 'listening', pct: null })
    let out: { chunks?: { text: string; timestamp: [number, number | null] }[] }
    try {
      out = await asr(pcm, OPTS)
    } catch (err) {
      // A GPU that probed fine can still fail shader compile — retry on WASM.
      if (!hasWebgpu) throw err
      asr = await makeAsr('wasm')
      out = await asr(pcm, OPTS)
    }
    post({ type: 'done', chunks: out.chunks ?? [] })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
