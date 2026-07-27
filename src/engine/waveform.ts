// Waveform peaks for audio clips. The decoded AudioBuffer (shared with the
// mixer's cache in audio.ts) is reduced to an abs-peak-per-bucket array once
// per asset; the timeline samples a clip's trimmed sub-range from it to draw.

import { getAudioBuffer } from './audio'
import type { Id, MediaAsset } from './types'

const PEAKS_PER_S = 60
const MIN_BUCKETS = 200
const MAX_BUCKETS = 16000

/**
 * Abs-peak amplitude (0..1) per bucket over a mono sample array. Pure, and the
 * unit-testable core. The last bucket absorbs any remainder so no samples are
 * dropped.
 */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const n = Math.max(1, Math.floor(buckets))
  const out = new Float32Array(n)
  if (samples.length === 0) return out
  const per = samples.length / n
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * per)
    const end = i === n - 1 ? samples.length : Math.floor((i + 1) * per)
    let peak = 0
    for (let j = start; j < end; j++) {
      const a = samples[j] < 0 ? -samples[j] : samples[j]
      if (a > peak) peak = a
    }
    out[i] = peak > 1 ? 1 : peak
  }
  return out
}

/** Peaks across ALL channels of a buffer without allocating a downmix copy. */
function computeBufferPeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const n = Math.max(1, Math.floor(buckets))
  const out = new Float32Array(n)
  const len = buffer.length
  if (len === 0) return out
  const chans: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c))
  const per = len / n
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * per)
    const end = i === n - 1 ? len : Math.floor((i + 1) * per)
    let peak = 0
    for (const data of chans) {
      for (let j = start; j < end; j++) {
        const a = data[j] < 0 ? -data[j] : data[j]
        if (a > peak) peak = a
      }
    }
    out[i] = peak > 1 ? 1 : peak
  }
  return out
}

const peaksCache = new Map<Id, Promise<Float32Array | null>>()

/**
 * Full-source peaks for an asset (0..1), resolution scaled to its duration and
 * bounded so a long file can't blow memory. Null for silent/image assets or a
 * decode failure. Cached + deduped per asset id like getAudioBuffer.
 */
export function getAssetPeaks(asset: MediaAsset): Promise<Float32Array | null> {
  let pending = peaksCache.get(asset.id)
  if (!pending) {
    pending = (async () => {
      const buf = await getAudioBuffer(asset)
      if (!buf) return null
      const buckets = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, Math.round(buf.duration * PEAKS_PER_S)))
      return computeBufferPeaks(buf, buckets)
    })()
    peaksCache.set(asset.id, pending)
  }
  return pending
}

/**
 * Resample the slice of `peaks` covering source seconds [inS, outS) into `cols`
 * columns for drawing a clip that wide. Pure so the draw path stays trivial.
 */
export function slicePeaks(
  peaks: Float32Array,
  sourceDurationS: number,
  inS: number,
  outS: number,
  cols: number,
): Float32Array {
  const n = Math.max(1, Math.floor(cols))
  const out = new Float32Array(n)
  if (peaks.length === 0 || sourceDurationS <= 0) return out
  const startFrac = Math.max(0, inS / sourceDurationS)
  const endFrac = Math.min(1, outS / sourceDurationS)
  const span = Math.max(1e-9, endFrac - startFrac)
  for (let x = 0; x < n; x++) {
    const frac = startFrac + (x / n) * span
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)))
    out[x] = peaks[idx]
  }
  return out
}
