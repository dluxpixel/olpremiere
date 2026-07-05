// Frame-accurate scrub cache (spec §4.2 decode.ts): WebCodecs-backed exact
// frames for the PAUSED/scrubbing preview path. The Monitor redraws every rAF,
// so there is no push notification — a miss kicks an async decode and a later
// rAF picks the frame up from the cache.
//
// mediabunny + persistence are loaded via dynamic import on first decode so
// this module stays importable in a plain node test env (no DOM, no IDB).

import type { CanvasSink, Input } from 'mediabunny'
import type { Id, MediaAsset } from './types'

export const FALLBACK_FPS = 30
export const CACHE_CAP = 96
export const PENDING_CAP = 8

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests — no DOM, no mediabunny)

/** Frame index containing tS at the asset fps (fallback 30). Floor semantics with a float-error epsilon. */
export function frameIndexAt(tS: number, fps: number | undefined): number {
  const f = fps && fps > 0 ? fps : FALLBACK_FPS
  // epsilon ≈ 3e-8s at 30fps: absorbs float error so exact boundaries land on the boundary frame
  return Math.max(0, Math.floor(tS * f + 1e-6))
}

/**
 * Decode target for a frame index: the frame's midpoint. getCanvas returns the
 * last frame starting <= t, so the midpoint is robust to timestamp jitter.
 */
export function frameMidTimeS(index: number, fps: number | undefined): number {
  const f = fps && fps > 0 ? fps : FALLBACK_FPS
  return (index + 0.5) / f
}

/** ±spanFrames around center, nearest-first (forward before backward on ties), clamped to [0, maxIndex]. */
export function spanIndices(center: number, spanFrames: number, maxIndex: number): number[] {
  const out: number[] = []
  const push = (i: number): void => {
    if (i >= 0 && i <= maxIndex) out.push(i)
  }
  push(center)
  for (let d = 1; d <= spanFrames; d++) {
    push(center + d)
    push(center - d)
  }
  return out
}

/** Dedupe + keep the `cap` indices nearest to `latest`, nearest-first (ties: lower index first). */
export function boundPending(indices: number[], latest: number, cap: number): number[] {
  const uniq = [...new Set(indices)]
  uniq.sort((a, b) => Math.abs(a - latest) - Math.abs(b - latest) || a - b)
  return uniq.slice(0, cap)
}

/** Insertion-ordered LRU: get() touches, has() peeks, set() returns evicted keys. */
export class FrameLru<V> {
  private map = new Map<string, V>()
  constructor(readonly cap: number) {}

  get size(): number {
    return this.map.size
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: string, value: V): string[] {
    this.map.delete(key)
    this.map.set(key, value)
    const evicted: string[] = []
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
      evicted.push(oldest)
    }
    return evicted
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  keys(): string[] {
    return [...this.map.keys()]
  }
}

// ---------------------------------------------------------------------------
// Cache runtime (DOM/mediabunny side)

interface AssetEntry {
  asset: MediaAsset
  input: Input | null
  sink: CanvasSink | null
  ready: Promise<void> | null
  /** Queued frame indices, nearest-to-latest first. */
  pending: number[]
  /** Frame index currently decoding, if any. */
  decoding: number | null
  /** Latest requested index — the ranking anchor while scrubbing. */
  latest: number
  pumping: boolean
  failed: boolean
  /** Indices the demuxer has no frame for (before track start) — never re-request. */
  noFrame: Set<number>
}

const cache = new FrameLru<CanvasImageSource>(CACHE_CAP)
const entries = new Map<Id, AssetEntry>()

const cacheKey = (assetId: Id, index: number): string => `${assetId}:${index}`

function ensureEntry(asset: MediaAsset): AssetEntry {
  let e = entries.get(asset.id)
  if (!e) {
    e = {
      asset,
      input: null,
      sink: null,
      ready: null,
      pending: [],
      decoding: null,
      latest: 0,
      pumping: false,
      failed: false,
      noFrame: new Set(),
    }
    entries.set(asset.id, e)
  }
  return e
}

async function openInput(e: AssetEntry): Promise<void> {
  const [{ ALL_FORMATS, BlobSource, CanvasSink: Sink, Input: MbInput }, { getBlob }] = await Promise.all([
    import('mediabunny'),
    import('../state/persistence'),
  ])
  const blob = await getBlob(e.asset.blobKey)
  if (!blob) throw new Error(`frameCache: no blob for key ${e.asset.blobKey}`)
  const input = new MbInput({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    input.dispose()
    throw new Error(`frameCache: no video track in asset ${e.asset.id}`)
  }
  e.input = input
  // poolSize deliberately omitted: 0/undefined disables mediabunny's canvas
  // pool, so every getCanvas yields a FRESH canvas — cached frames must never
  // be recycled underneath us.
  e.sink = new Sink(track)
}

function failAsset(e: AssetEntry, err: unknown): void {
  if (!e.failed) console.warn(`frameCache: decode failed for asset ${e.asset.id}; disabling`, err)
  e.failed = true
  e.pending = []
  e.input?.dispose()
  e.input = null
  e.sink = null
}

/** One serialized decode chain per asset — concurrent seeks on one demuxer corrupt state. */
async function pump(e: AssetEntry): Promise<void> {
  e.pumping = true
  try {
    e.ready ??= openInput(e)
    await e.ready
    while (e.pending.length > 0 && !e.failed) {
      e.pending = boundPending(e.pending, e.latest, PENDING_CAP)
      const idx = e.pending.shift()
      if (idx === undefined || !e.sink) break
      const key = cacheKey(e.asset.id, idx)
      if (cache.has(key)) continue
      e.decoding = idx
      const wrapped = await e.sink.getCanvas(frameMidTimeS(idx, e.asset.fps))
      e.decoding = null
      if (e.failed) break // evicted mid-decode
      if (wrapped) cache.set(key, wrapped.canvas)
      else e.noFrame.add(idx)
    }
  } catch (err) {
    failAsset(e, err)
  } finally {
    e.decoding = null
    e.pumping = false
  }
}

function request(asset: MediaAsset, indices: number[], latest: number): void {
  const e = ensureEntry(asset)
  if (e.failed) return
  e.latest = latest
  const fresh = indices.filter((i) => i !== e.decoding && !e.noFrame.has(i) && !cache.has(cacheKey(asset.id, i)))
  if (fresh.length === 0 && e.pending.length === 0) return
  e.pending = boundPending([...e.pending, ...fresh], latest, PENDING_CAP)
  if (!e.pumping) void pump(e)
}

// ---------------------------------------------------------------------------
// Public API (the contract preview.ts integrates against)

/**
 * Sync cache peek keyed by (asset.id, frame index at the asset fps, fallback
 * 30). On miss: returns null and fire-and-forgets a deduped decode request.
 * Never throws. Non-video assets are a permanent miss.
 */
export function getFrameAt(asset: MediaAsset, tS: number): CanvasImageSource | null {
  if (asset.kind !== 'video') return null
  try {
    const idx = frameIndexAt(tS, asset.fps)
    const hit = cache.get(cacheKey(asset.id, idx))
    if (hit) return hit
    request(asset, [idx], idx)
  } catch {
    // decode path must never break the draw loop
  }
  return null
}

/** Queue decodes ±spanS around tS at the asset frame step, nearest-first. Cheap to call every scrub tick. */
export function prefetchAround(asset: MediaAsset, tS: number, spanS = 0.5): void {
  if (asset.kind !== 'video') return
  try {
    const fps = asset.fps && asset.fps > 0 ? asset.fps : FALLBACK_FPS
    const center = frameIndexAt(tS, asset.fps)
    const span = Math.max(1, Math.round(spanS * fps))
    const maxIdx = asset.durationS > 0 ? Math.max(0, Math.ceil(asset.durationS * fps) - 1) : Number.MAX_SAFE_INTEGER
    request(asset, spanIndices(center, span, maxIdx), center)
  } catch {
    // same guarantee as getFrameAt
  }
}

/** Drop cached frames + close the demuxer for a removed asset. */
export function evictAsset(assetId: Id): void {
  const e = entries.get(assetId)
  if (e) {
    e.failed = true // stops an in-flight pump without a spurious warn (already true on failure)
    e.pending = []
    e.input?.dispose()
    e.input = null
    e.sink = null
    entries.delete(assetId)
  }
  const prefix = `${assetId}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

export function frameCacheStats(): { entries: number; assets: number } {
  return { entries: cache.size, assets: entries.size }
}
