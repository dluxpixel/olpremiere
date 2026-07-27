// Non-destructive voice noise reduction: RNNoise (the same model OBS's
// "Noise Suppression" filter runs) applied OFFLINE to an asset's decoded PCM,
// never at record time. The recording stays raw forever, and a clip's `denoise`
// strength only changes which samples the mixers read, so the result can be
// A/B'd with one toggle and undone like any other edit.
//
// Design notes, learned the hard way (see vault ol-premiere-noise-reduction):
//  - RNNoise ALONE. Stacking a second suppressor (Speex) measured "better" on
//    a level bench and sounded watery on a real mic. OBS ships them either/or.
//  - Offline buffer processing, not an AudioWorklet: one deterministic pass,
//    cached per asset; live preview and export read the SAME samples, so
//    preview==export holds by construction and there is no worklet-load race.
//  - Strength is a dry/wet crossfade done sample-wise here (not dual graph
//    sources), so every mixer inherits it from the buffer itself. RNNoise's
//    output frame aligns 1:1 with its input frame (past-context model), which
//    keeps the crossfade phase-aligned rather than comb-filtering.
//
// The wasm (@shiguredo/rnnoise-wasm, the binding under OBS-adjacent web
// stacks) embeds its binary in the JS module: no asset plumbing, loads in any
// environment with WebAssembly. It is imported lazily so the model only costs
// anything once someone actually enables denoise.

import type { MediaAsset } from './types'

/** RNNoise expects 16-bit-PCM-range floats; AudioBuffer floats are ±1. */
const PCM_SCALE = 0x7fff

/**
 * The slice of the wasm module denoiseBuffer needs, injectable so unit tests
 * can exercise the chunking/scaling with a deterministic fake processor.
 */
export interface DenoiseEngine {
  frameSize: number
  createDenoiseState(): { processFrame(frame: Float32Array): number; destroy(): void }
}

let enginePromise: Promise<DenoiseEngine> | null = null

/** Load the RNNoise wasm once per app lifetime. A failed load clears the cache so a later toggle retries. */
export function ensureRnnoise(): Promise<DenoiseEngine> {
  enginePromise ??= import('@shiguredo/rnnoise-wasm')
    .then(({ Rnnoise }) => Rnnoise.load())
    .catch((err: unknown) => {
      enginePromise = null
      throw err
    })
  return enginePromise
}

/**
 * Run RNNoise over one channel. Pure w.r.t. the input (returns a new array);
 * deterministic: same samples in → same samples out. The tail frame is
 * zero-padded through the net and truncated back, matching the worklet
 * behaviour for partial frames.
 */
export function denoiseChannel(engine: DenoiseEngine, data: Float32Array): Float32Array {
  const state = engine.createDenoiseState()
  try {
    const out = new Float32Array(data.length)
    const frame = new Float32Array(engine.frameSize)
    for (let i = 0; i < data.length; i += engine.frameSize) {
      const n = Math.min(engine.frameSize, data.length - i)
      if (n < engine.frameSize) frame.fill(0)
      for (let k = 0; k < n; k++) frame[k] = data[i + k] * PCM_SCALE
      state.processFrame(frame)
      for (let k = 0; k < n; k++) out[i + k] = frame[k] / PCM_SCALE
    }
    return out
  } finally {
    state.destroy()
  }
}

/**
 * Dry/wet mix into a new array: out = raw·(1−strength) + wet·strength.
 * strength 0 returns samples numerically identical to raw; 1 returns wet.
 */
export function mixDryWet(raw: Float32Array, wet: Float32Array, strength: number): Float32Array {
  const s = Math.min(1, Math.max(0, strength))
  const out = new Float32Array(raw.length)
  const dry = 1 - s
  for (let i = 0; i < raw.length; i++) out[i] = raw[i]! * dry + (wet[i] ?? 0) * s
  return out
}

// ---------------------------------------------------------------------------
// Per-asset caches. The full-wet pass is the expensive one (one RNNoise run
// per channel, ~50-100× realtime) and is cached per asset; the crossfade is a
// multiply-add over the PCM (~ms) cached at the latest strength only, so a
// slider drag never accumulates one buffer per step.

const wetCache = new Map<string, Promise<Float32Array[] | null>>()
const mixCache = new Map<string, { strength: number; channels: Float32Array[] }>()

/** Denoised (full-wet) channels for an asset's decoded buffer, cached. */
function ensureWetChannels(asset: MediaAsset, src: AudioBuffer): Promise<Float32Array[] | null> {
  let pending = wetCache.get(asset.id)
  if (!pending) {
    pending = ensureRnnoise()
      .then((engine) => {
        const channels: Float32Array[] = []
        for (let ch = 0; ch < src.numberOfChannels; ch++) {
          channels.push(denoiseChannel(engine, src.getChannelData(ch)))
        }
        return channels
      })
      .catch((err: unknown) => {
        // Wasm unavailable (old browser, blocked wasm): fail SOFT to raw audio
        // so the toggle just does nothing rather than muting the clip, but
        // clear the cache so a retry is possible.
        console.warn('OL Studio: noise reduction unavailable', err)
        wetCache.delete(asset.id)
        return null
      })
    wetCache.set(asset.id, pending)
  }
  return pending
}

/**
 * The denoised buffer for an asset at `strength`, built from the raw decoded
 * buffer. Returns null when the wasm can't load (caller falls back to raw).
 * The returned AudioBuffer preserves length/rate/channel-count exactly, so
 * every downstream consumer (schedules, reversal, export) is agnostic to it.
 */
export async function denoisedBufferFor(
  asset: MediaAsset,
  src: AudioBuffer,
  strength: number,
  createBuffer: (channels: number, length: number, sampleRate: number) => AudioBuffer,
): Promise<AudioBuffer | null> {
  const wet = await ensureWetChannels(asset, src)
  if (!wet) return null
  const s = Math.min(1, Math.max(0, strength))
  let mixed = mixCache.get(asset.id)
  if (!mixed || mixed.strength !== s) {
    mixed = {
      strength: s,
      channels: wet.map((w, ch) => mixDryWet(src.getChannelData(ch), w, s)),
    }
    mixCache.set(asset.id, mixed)
  }
  const out = createBuffer(src.numberOfChannels, src.length, src.sampleRate)
  for (let ch = 0; ch < src.numberOfChannels; ch++) out.getChannelData(ch).set(mixed.channels[ch]!)
  return out
}

/** Drop cached denoise work for an asset (asset deleted / replaced). */
export function invalidateDenoise(assetId: string): void {
  wetCache.delete(assetId)
  mixCache.delete(assetId)
}
