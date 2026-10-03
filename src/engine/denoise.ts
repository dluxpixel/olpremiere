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
//    sources), so every mixer inherits it from the buffer itself.
//  - ⛔ THE MODEL IS 960 SAMPLES LATE, AND THAT IS COMPENSATED HERE. This comment
//    used to say RNNoise's output frame "aligns 1:1 with its input frame". It
//    does not: its analysis window spans two frames, so what comes out is 20 ms
//    behind what went in. Measured on his own takes, 2026-09-29: best match at
//    lag 959, r = 0.991, and r = 0.01 at lag 0. Uncompensated, every strength
//    under 100% laid his voice over a copy of itself 20 ms late (notches every
//    50 Hz, as deep as 14.5 dB) and 100% played the voice 20 ms behind the
//    picture. denoiseChannel now feeds the model that many samples past the end
//    and drops them from the front, so wet lines up with dry sample for sample.
//  - RNNoise is a 48 kHz model. A take at any other rate (a lossless take keeps
//    the mic's own rate, 44.1 kHz on plenty of devices) goes up to 48 kHz for the
//    model and back down after, through engine/resample.ts, which adds no delay.
//  - 100% is not digital silence. It gated his room tone to -118 dBFS between
//    words, the room vanishing in every pause and returning under every word.
//    The strongest setting now takes the room down 18 dB and no further.
//
// The wasm (@shiguredo/rnnoise-wasm, the binding under OBS-adjacent web
// stacks) embeds its binary in the JS module: no asset plumbing, loads in any
// environment with WebAssembly. It is imported lazily so the model only costs
// anything once someone actually enables denoise.

import { budgets } from './memoryBudget'
import { resamplePlane } from './resample'
import type { MediaAsset } from './types'

/**
 * RNNoise expects 16-bit-PCM-range floats; AudioBuffer floats are ±1.
 * Exported because captions/voiceActivity.ts feeds the SAME net to read its
 * voice-activity output, and a second copy of this number would be a silent way
 * for the two paths to start disagreeing about what the model was shown.
 */
export const PCM_SCALE = 0x7fff

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

/** The one rate the model was trained at. */
export const RNNOISE_SAMPLE_RATE = 48_000

/**
 * How late RNNoise's output is against its input: two frames, 960 samples at
 * 48 kHz. Measured on the real wasm (denoise.test.ts pins it): the best match of
 * wet against dry sits at 959.7 samples on a voice, the fraction being the
 * model's own low cut, which leads the low end by a hair.
 */
export const rnnoiseLatency = (engine: DenoiseEngine): number => 2 * engine.frameSize

/**
 * Run RNNoise over one channel. Pure w.r.t. the input (returns a new array);
 * deterministic: same samples in → same samples out.
 *
 * The output LINES UP with the input: the model is fed `latency` samples of
 * silence past the end and the first `latency` samples it returns are dropped,
 * so sample i out is sample i in, cleaned. A partial tail frame is zero padded
 * through the net like any other. `latency` is the real model's by default; the
 * unit tests' stand-in engines have none and pass 0.
 */
export function denoiseChannel(
  engine: DenoiseEngine,
  data: Float32Array,
  latency: number = rnnoiseLatency(engine),
): Float32Array {
  const state = engine.createDenoiseState()
  try {
    const out = new Float32Array(data.length)
    const size = engine.frameSize
    const frame = new Float32Array(size)
    const total = data.length + latency
    for (let i = 0; i < total; i += size) {
      for (let k = 0; k < size; k++) {
        const j = i + k
        frame[k] = j < data.length ? data[j]! * PCM_SCALE : 0
      }
      state.processFrame(frame)
      for (let k = 0; k < size; k++) {
        const o = i + k - latency
        if (o >= 0 && o < data.length) out[o] = frame[k]! / PCM_SCALE
      }
    }
    return out
  } finally {
    state.destroy()
  }
}

/**
 * One channel through the model at ANY rate. A 48 kHz channel goes straight in.
 * Anything else goes up to 48 kHz, through the model, and back to its own rate
 * and exact length, so the wet copy still lines up with the dry one.
 */
export function denoiseAtRate(engine: DenoiseEngine, data: Float32Array, sampleRate: number): Float32Array {
  if (Math.round(sampleRate) === RNNOISE_SAMPLE_RATE) return denoiseChannel(engine, data)
  const up = resamplePlane(data, sampleRate, RNNOISE_SAMPLE_RATE)
  return resamplePlane(denoiseChannel(engine, up), RNNOISE_SAMPLE_RATE, sampleRate, data.length)
}

/**
 * Dry/wet mix into a new array: out is raw times (one minus strength), plus
 * wet times strength.
 * strength 0 returns samples numerically identical to raw; 1 returns wet.
 */
export function mixDryWet(raw: Float32Array, wet: Float32Array, strength: number): Float32Array {
  const s = Math.min(1, Math.max(0, strength))
  const out = new Float32Array(raw.length)
  const dry = 1 - s
  for (let i = 0; i < raw.length; i++) out[i] = raw[i]! * dry + (wet[i] ?? 0) * s
  return out
}

/** The most the strongest setting takes off his room: 18 dB, never to silence. */
export const MAX_REDUCTION_DB = 18

/**
 * A clip's strength (0..1, the Inspector's %) as the share of wet in the mix.
 *
 * The strength is HOW MUCH OF THE ROOM COMES OFF, even in decibels: 50% takes
 * 9 dB off, 100% takes 18 dB off. Where the model has removed the room, the mix
 * is left holding one minus the share of the dry room, so a share of one minus
 * ten to the power of (minus dB over 20) lands the floor exactly that far down. Where the model passes the voice, wet
 * and dry are the same samples (lined up, see denoiseChannel), so the voice
 * stays at unity whatever the strength.
 */
export function wetShareFor(strength: number): number {
  const s = Math.min(1, Math.max(0, strength))
  return 1 - Math.pow(10, (-MAX_REDUCTION_DB * s) / 20)
}

// ---------------------------------------------------------------------------
// Per-asset caches. The full-wet pass is the expensive one (one RNNoise run per
// channel) and is cached per asset; the crossfade is a multiply-add over the PCM
// (~ms) cached at the latest strength only, so a slider drag never accumulates
// one buffer per step.
//
// This used to claim 50-100x realtime. Measured in headless chromium on his
// machine, 2026-08-09: 77 ms per second of audio per channel, so about 13x, and
// a stereo minute is roughly 9 s of work. The cache is doing more for him than
// that number suggested, not less.

// ⛔ BUDGETED, AND UNTIL 2026-08-24 THESE TWO WERE THE ONLY CACHES IN THE APP
// THAT WERE NOT.
//
// Both hold FULL decoded channel data as Float32: roughly 230 MB for one ten
// minute stereo clip, twice over, because the wet copy and the mixed copy are
// each the length of the source. Nothing ever dropped them but deleting the
// asset outright, so every clip he ever denoised stayed resident for the life of
// the session. The frame cache is capped at 512 MB and the audio cache at
// 256 MB; these grew without end beside them.
//
// His words, 2026-08-24: *"it also somehow takes 99% of my fucking RAM"* and
// then *"the lag sucks tho"*. Measured while he said it: the app was holding
// 3.9 GB with 4 GB free of 32.
//
// Insertion ordered, so the first key out of `keys()` is the least recently
// ADDED. Re-reading a cached entry does not refresh it, which is the honest
// simple thing: an evicted entry costs one re-run of the wasm over that clip,
// never a wrong answer.
// Follows the machine now, see engine/memoryBudget.ts.
const denoiseCacheMaxBytes = (): number => budgets().denoise
const wetCache = new Map<string, Promise<Float32Array[] | null>>()
const mixCache = new Map<string, { strength: number; channels: Float32Array[] }>()
/** Bytes charged per asset, counting both copies, so the budget is the truth. */
const denoiseBytes = new Map<string, number>()
let denoiseTotalBytes = 0

const channelsBytes = (channels: readonly Float32Array[]): number =>
  channels.reduce((n, c) => n + c.byteLength, 0)

function chargeDenoise(assetId: string, bytes: number): void {
  denoiseBytes.set(assetId, (denoiseBytes.get(assetId) ?? 0) + bytes)
  denoiseTotalBytes += bytes
}

/**
 * WHICH assets to drop, as a pure decision, so it can be tested without the
 * wasm. Same split `blobGc.ts` uses for the same reason: the planner decides and
 * the caller does the deleting.
 *
 * `order` is insertion order, oldest first. `keepId` is the asset just computed
 * and is never chosen: evicting it would make the call that triggered this
 * pointless and the next one would rebuild it immediately.
 */
export function denoiseEvictionPlan(
  order: readonly string[],
  bytesOf: (id: string) => number,
  total: number,
  budget: number,
  keepId: string,
): string[] {
  const drop: string[] = []
  let running = total
  for (const id of order) {
    if (running <= budget) break
    if (id === keepId) continue
    drop.push(id)
    running -= bytesOf(id)
  }
  return drop
}

/** Drop least-recently-added assets until the total is inside the budget. */
function evictDenoiseOverflow(keepId: string): void {
  const drop = denoiseEvictionPlan(
    [...wetCache.keys()],
    (id) => denoiseBytes.get(id) ?? 0,
    denoiseTotalBytes,
    denoiseCacheMaxBytes(),
    keepId,
  )
  for (const id of drop) {
    denoiseTotalBytes -= denoiseBytes.get(id) ?? 0
    denoiseBytes.delete(id)
    wetCache.delete(id)
    mixCache.delete(id)
  }
}

/** Denoised (full-wet) channels for an asset's decoded buffer, cached. */
function ensureWetChannels(asset: MediaAsset, src: AudioBuffer): Promise<Float32Array[] | null> {
  let pending = wetCache.get(asset.id)
  if (!pending) {
    pending = ensureRnnoise()
      .then((engine) => {
        const channels: Float32Array[] = []
        for (let ch = 0; ch < src.numberOfChannels; ch++) {
          channels.push(denoiseAtRate(engine, src.getChannelData(ch), src.sampleRate))
        }
        chargeDenoise(asset.id, channelsBytes(channels))
        evictDenoiseOverflow(asset.id)
        return channels
      })
      .catch((err: unknown) => {
        // Wasm unavailable (old browser, blocked wasm): fail SOFT to raw audio
        // so the toggle just does nothing rather than muting the clip, but
        // clear the cache so a retry is possible.
        console.warn('OL Premiere: noise reduction unavailable', err)
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
    // A replaced mix at a new strength is the same size, so only a NEW entry
    // adds to the total. Charging both would double count every slider move.
    const had = mixCache.has(asset.id)
    mixed = {
      strength: s,
      channels: wet.map((w, ch) => mixDryWet(src.getChannelData(ch), w, wetShareFor(s))),
    }
    mixCache.set(asset.id, mixed)
    if (!had) {
      chargeDenoise(asset.id, channelsBytes(mixed.channels))
      evictDenoiseOverflow(asset.id)
    }
  }
  const out = createBuffer(src.numberOfChannels, src.length, src.sampleRate)
  for (let ch = 0; ch < src.numberOfChannels; ch++) out.getChannelData(ch).set(mixed.channels[ch]!)
  return out
}

/** Drop cached denoise work for an asset (asset deleted / replaced). */
export function invalidateDenoise(assetId: string): void {
  // The running total has to come down with them, or the budget slowly counts
  // bytes that no longer exist and starts evicting live work to pay for ghosts.
  denoiseTotalBytes -= denoiseBytes.get(assetId) ?? 0
  denoiseBytes.delete(assetId)
  wetCache.delete(assetId)
  mixCache.delete(assetId)
}

/** What the denoise caches are holding, for the test that guards the budget. */
export function denoiseCacheBytesForTests(): number {
  return denoiseTotalBytes
}
