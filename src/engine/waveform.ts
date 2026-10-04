// Waveform peaks for audio clips: an abs-peak-per-bucket array once per asset;
// the timeline samples a clip's trimmed sub-range from it to draw.
//
// ⛔ NEVER ON THE MAIN THREAD, AND NEVER TWICE, 2026-09-28. These used to come
// from the mixer's whole asset AudioBuffer, so drawing one clip of his 30 minute
// music track decoded all 674 MB of it on the main thread, on every open of the
// project, and the first 16 s after opening his biggest project went to that.
// Now a worker reduces the sound to peaks as it decodes (audioDemux.ts), and the
// peaks are kept with his media, so the next open draws them without decoding.

import { getAudioBuffer } from './audio'
import { peaksOffThread } from './audioDecodeClient'
import { db, getBlob } from '../state/persistence'
import type { Id, MediaAsset } from './types'

/** Bump when the peak format changes, so old stored peaks are simply ignored. */
const STORED_PEAKS_VERSION = 1
const storedKey = (asset: MediaAsset): string => `peaks:v${STORED_PEAKS_VERSION}:${asset.blobKey}`

async function readStoredPeaks(asset: MediaAsset): Promise<Float32Array | null> {
  try {
    const raw = (await (await db()).get('meta', storedKey(asset))) as Float32Array | undefined
    return raw instanceof Float32Array && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

function storePeaks(asset: MediaAsset, peaks: Float32Array): void {
  // Best effort: a failed write only means the next open computes them again.
  void db()
    .then((d) => d.put('meta', peaks, storedKey(asset)))
    .catch(() => undefined)
}

/** Buckets for a source this long: resolution scaled to duration, bounded both ways. */
const bucketsFor = (durationS: number): number => Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, Math.round(durationS * PEAKS_PER_S)))

async function computeAssetPeaks(asset: MediaAsset): Promise<Float32Array | null> {
  if (asset.kind === 'image' || !asset.hasAudio) return null
  const stored = await readStoredPeaks(asset)
  if (stored) return stored
  const blob = await getBlob(asset.blobKey)
  if (!blob) return null
  if (asset.durationS > 0) {
    try {
      const r = await peaksOffThread(blob, asset.durationS, bucketsFor(asset.durationS))
      if (r.kind === 'peaks') {
        storePeaks(asset, r.peaks)
        return r.peaks
      }
      if (r.kind === 'silent') return null
    } catch {
      // fall through to the whole buffer path below
    }
  }
  // A container the demuxer cannot read, or an asset with no known duration: the
  // mixer's own decode, exactly as before.
  const buf = await getAudioBuffer(asset)
  if (!buf) return null
  const peaks = computeBufferPeaks(buf, bucketsFor(buf.duration))
  storePeaks(asset, peaks)
  return peaks
}

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
    pending = computeAssetPeaks(asset)
    peaksCache.set(asset.id, pending)
  }
  return pending
}

/** Forget one asset's peaks. They come back from the next getAssetPeaks. */
export function forgetAssetPeaks(assetId: Id): void {
  peaksCache.delete(assetId)
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
