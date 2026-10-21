/// <reference lib="webworker" />
// Whisper speech-to-text, fully local. Runs in a dedicated worker so model
// download + inference never touch the UI thread, and the transformers.js
// bundle (large) is dynamic-imported HERE, so the main app bundle stays lean.
// WebGPU when the machine has it, WASM otherwise. The model downloads once
// from the Hugging Face CDN and lands in the browser cache; after that the
// whole pipeline is offline. No audio ever leaves the machine.

// Model, weights and generation options come from transcribeConfig.ts: one
// multilingual `_timestamped` onnx-community export for every language (word
// timestamps need the cross-attention outputs only those carry, and older Xenova
// exports trip onnxruntime's session validation outright).
import { generationOptsFor, modelFor, modelsInUse, staleModelKeys, whisperModel, type CaptionLanguage } from './transcribeConfig'
import { alignRecognised } from './alignRunner'

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
  /**
   * How often the GPU has failed this session for this model, as the main
   * thread has kept it. A worker that was killed starts from nothing, so the
   * count it was told is the one it trusts (see gpuFailures below).
   */
  gpuFailures?: number
  /**
   * Time every word against the sound after the speech model has said them
   * (alignRunner.ts), and mark the ones it timed `aligned`. Asked for only by a
   * caller that cuts or places captions on the exact moment (transcribeActions
   * `wantsExact`); the rest never pay for the second model.
   */
  align?: boolean
}

export type TranscribeResponse =
  | { type: 'progress'; phase: 'model' | 'listening' | 'align'; pct: number | null; downloading?: boolean }
  | { type: 'done'; chunks: { text: string; timestamp: [number, number | null]; aligned?: boolean }[] }
  | { type: 'warmed' }
  /** The GPU failed at inference: how many times now, for the main thread to keep. */
  | { type: 'gpuFailed'; model: string; failures: number }
  /**
   * ⛔ `warm` SAYS WHOSE FAILURE THIS IS, and without it a warm could kill a run.
   *
   * The worker is shared and kept alive, and it has no request id, so every
   * message goes to whoever is listening. `'warmed'` was already special-cased
   * for exactly that reason and the error path was left as the catch-all: a boot
   * warm that failed while a real caption run was mid-inference made the RUN
   * treat the warm's failure as its own. It terminated the worker, rejected with
   * the name of a model it was not even using, and the next run paid for a full
   * pipeline rebuild.
   *
   * Now each side ignores the other's errors, in both directions.
   */
  | { type: 'error'; message: string; warm?: boolean }

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
      .then(() => {
        post({ type: 'warmed' })
        void forgetRetiredModels()
      })
      .catch((err: unknown) =>
        post({ type: 'error', message: err instanceof Error ? err.message : String(err), warm: true }),
      )
    return
  }
  void run(e.data.pcm, e.data.language ?? 'en', e.data.gpuFailures ?? 0, e.data.align === true)
}

/**
 * Delete the cached files of Whisper models no caption language uses any more
 * (transcribeConfig.staleModelKeys says which). Called only once the current
 * model has loaded. Best effort: a cache that will not open costs nothing.
 */
async function forgetRetiredModels(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    const cache = await caches.open('transformers-cache')
    const keys = (await cache.keys()).map((r) => r.url)
    const stale = staleModelKeys(keys, modelsInUse())
    for (const k of stale) await cache.delete(k)
    if (stale.length) console.log(`OL Premiere transcribe: removed ${stale.length} files of speech models no longer used`)
  } catch {
    // Nothing to do: the files stay, exactly as before this existed.
  }
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
/** Which device each cached pipeline is really on, so nothing has to guess. */
const asrDevice = new Map<string, 'webgpu' | 'wasm'>()
/**
 * How many times the GPU pipeline has failed AT INFERENCE for a model this session.
 *
 * ⛔ ONE FAILURE USED TO CONDEMN THE WHOLE SESSION, SILENTLY. The catch below builds
 * a wasm pipeline when a GPU one throws mid-inference, which is right, and then wrote
 * it into `asrCache` as the pipeline for that model, which is not. A single shader
 * compile hiccup on clip 3 of a 41 clip sweep therefore ran clips 4 to 41 on the q8
 * encoder and q4 decoder, the worst quality the app has, with nothing said anywhere.
 *
 * That is a very good candidate for his oldest complaint about this feature, 2026-08-18:
 * *"It reads words bad, like really fucking bad."* It would be intermittent, it would
 * affect most of a batch but not the first clips, and nothing on screen would differ.
 *
 * So a failure is COUNTED instead. The next clip rebuilds on the GPU and gets the good
 * weights back. Only after this many failures does the session settle on wasm, because
 * at that point the GPU path really is broken on this machine and rebuilding it every
 * clip would cost him more than the accuracy is worth.
 */
const gpuFailures = new Map<string, number>()
const GPU_GIVE_UP_AFTER = 2

type LoadProgress = { status?: string; progress?: number; total?: number; file?: string }

/**
 * A fresh progress reporter for one pipeline load: the 'model' phase with the
 * percentage of the biggest file, and whether anything is really downloading.
 */
function modelProgress(): (p: LoadProgress) => void {
  let biggestTotal = 0
  // Whether anything is coming off the NETWORK this time. transformers.js emits
  // `download` only when it actually fetches a file; a load served out of the
  // cache goes straight to progress and done. Without this the pill claimed
  // "Downloading Whisper (once)" every single time the model was loaded from
  // disk, which is why he saw it on every new version and stopped believing it.
  let downloading = false
  return (p) => {
    if (p.status === 'initiate' && p.file) console.log('OL Premiere transcribe: fetching', p.file)
    if (p.status === 'download') downloading = true
    if (p.status === 'progress' && typeof p.progress === 'number') {
      if ((p.total ?? 0) >= biggestTotal) {
        biggestTotal = p.total ?? 0
        post({ type: 'progress', phase: 'model', pct: p.progress, downloading })
      }
    }
  }
}

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

    const spec = whisperModel(model)
    const makeAsr = async (device: 'webgpu' | 'wasm'): Promise<Asr> => {
      const dtype = device === 'wasm' ? spec.wasmDtype : spec.gpuDtype
      return (await pipeline('automatic-speech-recognition', model, {
        device,
        ...(dtype ? { dtype } : {}),
        progress_callback: modelProgress(),
      })) as unknown as Asr
    }

    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ features?: ReadonlySet<string> } | null> } }).gpu
    const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null
    // Half precision weights need the GPU to do half precision maths. A GPU that
    // cannot is a GPU this model does not run on, so it goes straight to wasm
    // rather than failing the load and the run with it.
    const halfOk = !!adapter?.features?.has('shader-f16') || !Object.values(spec.gpuDtype ?? {}).some((d) => /16/.test(d))
    const hasWebgpu = !!adapter && halfOk
    const givenUp = (gpuFailures.get(model) ?? 0) >= GPU_GIVE_UP_AFTER
    const device: 'webgpu' | 'wasm' = hasWebgpu && !givenUp ? 'webgpu' : 'wasm'
    const asr = await makeAsr(device)
    asrCache.set(model, asr)
    asrDevice.set(model, device)
    // Said out loud, always. Which weights produced a transcript is the single
    // most useful fact about it when he says the words came out wrong, and it
    // used to be unknowable from outside.
    const weights = JSON.stringify((device === 'wasm' ? spec.wasmDtype : spec.gpuDtype) ?? 'fp32')
    console.log(
      `OL Premiere transcribe: ${model} on ${device} ${weights}` +
        (device === 'wasm'
          ? hasWebgpu
            ? ' because the GPU pipeline failed twice this session'
            : adapter
              ? ' because this GPU has no half precision'
              : ' because this machine has no WebGPU'
          : ''),
    )
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

/**
 * Deliberately NOT sent: a prompt of his vocabulary. Built and measured on
 * 2026-10-03 and it made his captions worse; vocabulary.ts has the numbers.
 */
async function run(pcm: Float32Array, language: CaptionLanguage, gpuFailuresTold: number, align: boolean): Promise<void> {
  try {
    const model = modelFor(language)
    // A worker built after the last one was killed starts with no count of its
    // own, so the main thread's is the one that holds.
    if (gpuFailuresTold > (gpuFailures.get(model) ?? 0)) gpuFailures.set(model, gpuFailuresTold)
    // language/task are GENERATION options: a multilingual model must be told
    // the language (English included) and to transcribe, never translate.
    const opts = { ...OPTS, ...generationOptsFor(language) }
    const asr = await getAsr(model)
    post({ type: 'progress', phase: 'listening', pct: null })
    let out: { chunks?: { text: string; timestamp: [number, number | null] }[] }
    try {
      out = await asr(pcm, opts)
    } catch (err) {
      // A GPU pipeline can still fail shader compile at inference. Run THIS clip
      // on wasm so he does not lose it.
      //
      // ⛔ AND THEN LET THE NEXT CLIP TRY THE GPU AGAIN. See gpuFailures above for
      // what caching the fallback used to cost: one hiccup silently ran the rest
      // of a whole-timeline sweep on the worst weights in the app.
      const failures = (gpuFailures.get(model) ?? 0) + 1
      gpuFailures.set(model, failures)
      post({ type: 'gpuFailed', model, failures })
      console.warn(
        `OL Premiere transcribe: the GPU pipeline for ${model} failed at inference (${failures} of ${GPU_GIVE_UP_AFTER} before this session settles on the slower weights).`,
        err,
      )
      // ⛔ THE FALLBACK SAYS IT IS LOADING (CA-15). Its weights are other files,
      // about 770 MB the first time, and it used to load them in silence under
      // "Listening for words...", with the main thread's listening clock still
      // running: the download was killed half way and the run failed. Each
      // 'model' report shows the download and starts the main thread's budget
      // again (transcribe.ts), and 'listening' starts it once more when the
      // wasm pipeline is ready. It does not stop the clock: only the biggest
      // file reports, so a smaller file's tail and the session build run on
      // the listening budget, a minute at the least. The files load side by
      // side, so the biggest is in practice the last to finish (N-5).
      const { pipeline } = await import('@huggingface/transformers')
      const wasmAsr = (await pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype: whisperModel(model).wasmDtype,
        progress_callback: modelProgress(),
      })) as unknown as Asr
      post({ type: 'progress', phase: 'listening', pct: null })
      if (failures >= GPU_GIVE_UP_AFTER) {
        asrCache.set(model, wasmAsr)
        asrDevice.set(model, 'wasm')
      } else {
        // Drop the broken GPU pipeline without putting wasm in its place, so the
        // next call rebuilds on the GPU and gets the good weights back.
        asrCache.delete(model)
        asrDevice.delete(model)
      }
      out = await wasmAsr(pcm, opts)
    }
    // ⛔ THE ALIGNER ONLY EVER MAKES A CAPTION BETTER. It is a second model on top
    // of one that works, so it cannot fail the run: alignRecognised never throws and
    // hands back these same chunks when anything goes wrong, and the catch below is
    // for the case that it somehow does. The words are the speech model's either way;
    // only their times can change.
    let chunks: { text: string; timestamp: [number, number | null]; aligned?: boolean }[] = out.chunks ?? []
    if (align && chunks.length > 0) {
      try {
        chunks = await alignRecognised(chunks, pcm, language, (pct, downloading) =>
          post({ type: 'progress', phase: 'align', pct, ...(downloading ? { downloading } : {}) }),
        )
      } catch (err) {
        console.warn('OL Premiere transcribe: word timing was skipped', err)
        chunks = out.chunks ?? []
      }
    }
    post({ type: 'done', chunks })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
