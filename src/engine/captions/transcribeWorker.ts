/// <reference lib="webworker" />
// Whisper speech-to-text, fully local. Runs in a dedicated worker so model
// download + inference never touch the UI thread, and the transformers.js
// bundle (large) is dynamic-imported HERE — the main app bundle stays lean.
// WebGPU when the machine has it, WASM otherwise. The model downloads once
// from the Hugging Face CDN and lands in the browser cache; after that the
// whole pipeline is offline. No audio ever leaves the machine.

// English-only model: the Jettism format is English-first. For multilingual
// captions swap to 'Xenova/whisper-base' (bigger, slower).
const MODEL = 'Xenova/whisper-base.en'

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
    const progress_callback = (p: { status?: string; progress?: number; total?: number }) => {
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
    let asr: Asr
    try {
      asr = (await pipeline('automatic-speech-recognition', MODEL, {
        device: 'webgpu',
        progress_callback,
      })) as unknown as Asr
    } catch {
      // No WebGPU (or its shader compile failed) — WASM is slower but universal.
      asr = (await pipeline('automatic-speech-recognition', MODEL, {
        device: 'wasm',
        progress_callback,
      })) as unknown as Asr
    }

    post({ type: 'progress', phase: 'listening', pct: null })
    const out = await asr(pcm, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    post({ type: 'done', chunks: out.chunks ?? [] })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
