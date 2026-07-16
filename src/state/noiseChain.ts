// Real background-noise removal for the voice recorder. Three stages, each
// earning its place by measurement (_verify/noise-variants-probe.mjs):
//
//   high-pass ×2  → mains hum and traffic rumble, -39 dB in the 40-60 Hz band
//   RNNoise       → neural, speech-aware; strong through the voice bands but it
//                   leaves high-frequency hiss almost untouched (-0.6 dB @ 4-12k)
//   Speex         → classic spectral subtraction; takes the hiss RNNoise leaves
//
// Either denoiser alone scores ~8-9 dB on a realistic room tone; together they
// score 21.3 dB with the voice measurably intact (-0.2 dB). The browser's own
// `noiseSuppression` barely touches cars/hum, so it's only the fallback.
// 100% local: wasm + worklets ship with the app, audio never leaves the machine.
//
// The DSP graph (createNoiseNodes) is deliberately split from the mic/stream
// plumbing (createNoiseChain) so it can be rendered in an OfflineAudioContext:
// a real-time graph measured through MediaRecorder swings ±5 dB run to run,
// which is useless as proof. See _verify/noise-reduction-verify.mjs.

// The suppressor package is imported lazily (its node class extends
// AudioWorkletNode at module scope, which only exists in a browser) so this
// module stays importable anywhere and RNNoise stays out of the main bundle
// until someone actually records. The ?url imports are plain strings.
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import speexWorkletPath from '@sapphi-red/web-noise-suppressor/speexWorklet.js?url'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import speexWasmPath from '@sapphi-red/web-noise-suppressor/speex.wasm?url'

/**
 * Below ~85 Hz is rumble/hum, not voice (male fundamentals start there) — the
 * standard broadcast voice roll-off. TWO cascaded biquads (24 dB/oct): one
 * alone is only 12 dB/oct, which leaves 50 Hz mains hum barely 10 dB down.
 */
const HIGHPASS_HZ = 85
const HIGHPASS_STAGES = 2
/**
 * Butterworth Q. The BiquadFilterNode default is 1, which resonates: cascading
 * two of those put a measured +2.2 dB bump at 60-120 Hz — right on the male
 * voice fundamental, and it lifts the very rumble the filter is here to remove.
 * Two Q=0.707 sections cascade into a Linkwitz-Riley 4th order: no peak.
 */
const HIGHPASS_Q = Math.SQRT1_2

/** RNNoise is trained on 48 kHz frames; the context must run at exactly that. */
const RNNOISE_RATE = 48_000

export interface NoiseChain {
  /** Wire the raw mic in; returns the cleaned stream to hand to MediaRecorder. */
  attach: (raw: MediaStream) => MediaStream
  /** Tear down the graph and free the wasm state. Safe to call more than once. */
  dispose: () => void
}

export interface NoiseNodes {
  /** Connect the source here. */
  input: AudioNode
  /** The cleaned signal. */
  output: AudioNode
  /** Free the wasm denoise state. */
  destroy: () => void
}

// One wasm fetch per binary for the app's lifetime — takes 2..n reuse them. A
// failed load clears the cache so a later take can retry (e.g. flaky first load).
const wasmCache = new Map<string, Promise<ArrayBuffer>>()
function cachedWasm(key: string, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  let p = wasmCache.get(key)
  if (!p) {
    p = load().catch((err: unknown) => {
      wasmCache.delete(key)
      throw err
    })
    wasmCache.set(key, p)
  }
  return p
}

/**
 * The DSP graph alone: high-pass cascade → RNNoise. Works in any context, so
 * the verification harness can render it offline and deterministically. The
 * context MUST run at 48 kHz (RNNoise's trained frame rate).
 */
export async function createNoiseNodes(ctx: BaseAudioContext): Promise<NoiseNodes> {
  const { RnnoiseWorkletNode, SpeexWorkletNode, loadRnnoise, loadSpeex } = await import(
    '@sapphi-red/web-noise-suppressor'
  )
  const [rnnoiseBinary, speexBinary] = await Promise.all([
    cachedWasm('rnnoise', () => loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath })),
    cachedWasm('speex', () => loadSpeex({ url: speexWasmPath })),
  ])
  await Promise.all([
    ctx.audioWorklet.addModule(rnnoiseWorkletPath),
    ctx.audioWorklet.addModule(speexWorkletPath),
  ])

  const filters = Array.from({ length: HIGHPASS_STAGES }, () => ctx.createBiquadFilter())
  for (const f of filters) {
    f.type = 'highpass'
    f.frequency.value = HIGHPASS_HZ
    f.Q.value = HIGHPASS_Q
  }
  // The worklet node types say AudioContext, but an AudioWorkletNode is legal
  // on any BaseAudioContext — offline rendering is exactly how this graph gets
  // measured.
  const rnnoise = new RnnoiseWorkletNode(ctx as AudioContext, {
    wasmBinary: rnnoiseBinary,
    maxChannels: 1,
  })
  const speex = new SpeexWorkletNode(ctx as AudioContext, {
    wasmBinary: speexBinary,
    maxChannels: 1,
  })
  const chain: AudioNode[] = [...filters, rnnoise, speex]
  const output = chain.reduce((prev, node) => (prev.connect(node), node))
  return {
    input: chain[0]!,
    output,
    destroy: () => {
      for (const n of [rnnoise, speex]) {
        try {
          n.destroy()
        } catch {
          // Worklet already gone (context closed first) — nothing left to free.
        }
      }
    },
  }
}

/**
 * Build the processing graph BEFORE the mic is opened, so the recorder knows
 * whether real suppression is available and can fall back to the browser's
 * `noiseSuppression` constraint when it isn't (old browser, blocked wasm).
 * Throws on any setup failure; the caller owns the fallback.
 */
export async function createNoiseChain(): Promise<NoiseChain> {
  const ctx = new AudioContext({ sampleRate: RNNOISE_RATE })
  try {
    const nodes = await createNoiseNodes(ctx)
    const dest = ctx.createMediaStreamDestination()
    nodes.output.connect(dest)
    // Created from the record-button click, so resume() is gesture-blessed.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    let disposed = false
    return {
      attach: (raw) => {
        ctx.createMediaStreamSource(raw).connect(nodes.input)
        return dest.stream
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        nodes.destroy()
        void ctx.close().catch(() => {})
      },
    }
  } catch (err) {
    void ctx.close().catch(() => {})
    throw err
  }
}
