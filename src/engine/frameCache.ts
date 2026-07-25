// Frame-accurate scrub cache (spec §4.2 decode.ts): WebCodecs-backed exact
// frames for the PAUSED/scrubbing preview path. The Monitor redraws every rAF,
// so there is no push notification — a miss kicks an async decode and a later
// rAF picks the frame up from the cache.
//
// mediabunny + persistence are loaded via dynamic import on first decode so
// this module stays importable in a plain node test env (no DOM, no IDB).

import type { CanvasSink, Input, WrappedCanvas } from 'mediabunny'
import type { Id, MediaAsset } from './types'

export const FALLBACK_FPS = 30
/**
 * Memory the decoded-frame cache may hold, in bytes.
 *
 * This used to be a COUNT (96 frames), which bounds nothing that matters: 96
 * frames of 4K RGBA is about 3 GB, while 96 frames of a 640x360 preview is 88
 * MB. One number could not be right for both, so it was set for the small case
 * and simply hoped for on the large one. A byte budget is the thing anybody
 * actually cares about, and it holds whatever number of frames fits.
 */
export const CACHE_BUDGET_BYTES = 192 * 1024 * 1024

/** RGBA bytes a decoded frame occupies, from whatever shape the source has. */
export function frameBytes(src: CanvasImageSource): number {
  const w = (src as { width?: number; displayWidth?: number }).width ?? (src as { displayWidth?: number }).displayWidth ?? 0
  const h =
    (src as { height?: number; displayHeight?: number }).height ?? (src as { displayHeight?: number }).displayHeight ?? 0
  const n = Number(w) * Number(h) * 4
  return Number.isFinite(n) && n > 0 ? n : 1
}
// With sequential decode (see pump) a queued frame is cheap, so the queue can
// afford to be deeper than the old seek-per-frame path allowed.
export const PENDING_CAP = 16
/**
 * Reopen threshold for the sequential reader: when the target frame is at most
 * this many frames AHEAD of the iterator, decoding forward through the gap is
 * cheaper than a random-access re-seek (which decodes forward from the previous
 * KEYFRAME anyway — typically 2s ≈ 60 frames of work). Behind always reopens.
 */
export const SEQ_REOPEN_GAP = 90

// Preview frames are decoded at PREVIEW-resolution, not necessarily source
// resolution. At Full quality typical (≤1080p) footage decodes untouched, while
// 4K is capped to 1080p; the Half/Quarter tiers then halve/quarter that so big
// sources scrub cheaply and each cached frame costs far less memory. Export
// decodes separately at full resolution, so this never affects the output file.
export const PREVIEW_BASE_MAX_H = 1080

let previewScale = 1
// Sequence raster height, fed by renderPreview each frame (no-op unless it
// changes). At FULL quality the decode cap follows it, so a >1080-tall
// sequence (vertical 1080×1920 reels, 4K timelines) gets 1:1 paused frames.
let sequenceH = 0

/**
 * Target decode height for an asset's preview frames, or undefined to decode at
 * native size (never upscales). Pure — the sizing policy the sink uses.
 * At Full quality (scale >= 1) a sequence TALLER than the base cap raises the
 * cap to the sequence height — capping a 1920-tall reel to 1080 softened every
 * paused frame. Half/Quarter keep the base cap: cheap scrubbing is their point.
 */
export function previewTargetHeight(
  nativeH: number | undefined,
  scale: number,
  maxH = PREVIEW_BASE_MAX_H,
  seqH = 0,
): number | undefined {
  if (!nativeH || nativeH <= 0) return undefined
  const base = scale >= 1 ? Math.max(maxH, seqH) : maxH
  const cap = Math.max(2, Math.round(Math.min(nativeH, base) * (scale > 0 ? scale : 1)))
  return cap < nativeH ? cap : undefined
}

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
  private map = new Map<string, { value: V; bytes: number }>()
  private total = 0

  /**
   * `budgetBytes` is the memory ceiling; `costOf` reports what one value weighs.
   * The newest entry is always kept even if it alone exceeds the budget — a
   * cache that refuses the frame it was just asked to hold is worse than one
   * slightly over its ceiling.
   */
  constructor(
    readonly budgetBytes: number,
    private readonly costOf: (v: V) => number = () => 1,
  ) {}

  get size(): number {
    return this.map.size
  }

  /** Bytes currently held. */
  get bytes(): number {
    return this.total
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (e === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: V): string[] {
    const prev = this.map.get(key)
    if (prev) this.total -= prev.bytes
    this.map.delete(key)
    const bytes = Math.max(0, this.costOf(value))
    this.map.set(key, { value, bytes })
    this.total += bytes

    const evicted: string[] = []
    while (this.total > this.budgetBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.total -= this.map.get(oldest)!.bytes
      this.map.delete(oldest)
      evicted.push(oldest)
    }
    return evicted
  }

  delete(key: string): void {
    const e = this.map.get(key)
    if (!e) return
    this.total -= e.bytes
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
  /**
   * Persistent sequential reader. getCanvas() is a RANDOM seek: it decodes
   * forward from the previous keyframe for EVERY requested frame (~a whole GOP
   * of work per frame — the old scrub lag). The iterator decodes each frame
   * once and steps forward; only a backward jump or a large forward jump
   * re-seeks. Every frame it passes is cached, so a forward scrub is ~1 decode
   * per frame instead of ~GOP decodes per frame.
   */
  iter: AsyncGenerator<WrappedCanvas, void, unknown> | null
  /** Nominal frame index the iterator will yield NEXT (advances as it reads). */
  iterIdx: number
}

const cache = new FrameLru<CanvasImageSource>(CACHE_BUDGET_BYTES, frameBytes)
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
      iter: null,
      iterIdx: -1,
    }
    entries.set(asset.id, e)
  }
  return e
}

/** Should the sequential reader re-seek to reach `target`? (Pure, tested.) */
export function needsReopen(iterIdx: number, target: number, gap = SEQ_REOPEN_GAP): boolean {
  if (iterIdx < 0) return true // no reader yet
  if (target < iterIdx) return true // behind — the reader is forward-only
  return target - iterIdx > gap // too far ahead to decode through
}

function closeIter(e: AssetEntry): void {
  if (e.iter) {
    void e.iter.return?.(undefined)
    e.iter = null
  }
  e.iterIdx = -1
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
  // be recycled underneath us. Decode at PREVIEW height (downscaled) so large
  // sources scrub cheaply; export uses its own full-res decode.
  const th = previewTargetHeight(e.asset.height, previewScale, PREVIEW_BASE_MAX_H, sequenceH)
  e.sink = th ? new Sink(track, { height: th }) : new Sink(track)
}

function failAsset(e: AssetEntry, err: unknown): void {
  if (!e.failed) console.warn(`frameCache: decode failed for asset ${e.asset.id}; disabling`, err)
  e.failed = true
  e.pending = []
  closeIter(e)
  e.input?.dispose()
  e.input = null
  e.sink = null
}

/**
 * Decode frame `idx` via the sequential reader, caching every frame passed on
 * the way (they're the very frames a scrub is about to ask for). Handles a
 * source whose real timing differs from the nominal fps grid: on overshoot the
 * last frame at-or-before the target is cached UNDER the target index (the
 * frame actually displayed at that time), so a sparse-timestamped source can't
 * loop forever re-requesting an index no packet maps to.
 */
async function decodeSequential(e: AssetEntry, idx: number): Promise<void> {
  if (!e.sink) return
  if (needsReopen(e.iterIdx, idx)) {
    closeIter(e)
    e.iter = e.sink.canvases(frameMidTimeS(idx, e.asset.fps))
    e.iterIdx = idx
  }
  const targetKey = cacheKey(e.asset.id, idx)
  let prev: WrappedCanvas | null = null
  while (e.iter) {
    const r = await e.iter.next()
    if (e.failed) return // evicted mid-decode
    if (r.done) {
      // Source exhausted before the target: the last decoded frame IS the
      // display at the target time (freeze on last), else mark no-frame.
      if (prev) cache.set(targetKey, prev.canvas)
      else e.noFrame.add(idx)
      closeIter(e)
      return
    }
    const w = r.value
    const wIdx = frameIndexAt(w.timestamp, e.asset.fps)
    cache.set(cacheKey(e.asset.id, wIdx), w.canvas)
    e.iterIdx = wIdx + 1
    if (wIdx === idx) return // exact hit
    if (wIdx > idx) {
      // Overshot the nominal grid (sparse/VFR timestamps): the frame shown at
      // the target time is the last one before it — clamp-to-first otherwise.
      cache.set(targetKey, (prev ?? w).canvas)
      return
    }
    prev = w
  }
}

/** One serialized decode chain per asset — concurrent seeks on one demuxer corrupt state. */
async function pump(e: AssetEntry): Promise<void> {
  e.pumping = true
  try {
    e.ready ??= openInput(e)
    await e.ready
    while (e.pending.length > 0 && !e.failed) {
      e.pending = boundPending(e.pending, e.latest, PENDING_CAP)
      // Order for sequential decode WITHOUT starving the displayed frame: the
      // at-or-after-playhead half ascending FIRST (the playhead frame leads and
      // the forward span rides the same iterator pass), then the behind half
      // ascending (one re-seek covers all of it).
      const fwd = e.pending.filter((i) => i >= e.latest).sort((a, b) => a - b)
      const back = e.pending.filter((i) => i < e.latest).sort((a, b) => a - b)
      e.pending = [...fwd, ...back]
      const idx = e.pending.shift()
      if (idx === undefined || !e.sink) break
      const key = cacheKey(e.asset.id, idx)
      if (cache.has(key)) continue
      e.decoding = idx
      await decodeSequential(e, idx)
      e.decoding = null
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

/** Hard bound on how many indices one range request may enqueue per call. */
export const RANGE_REQUEST_CAP = 240

/**
 * Ascending frame indices covering source-time range [aS, bS] (either order —
 * a reversed clip's window runs backward), clamped to the asset's last frame
 * and capped at `cap`. Pure — the transition pre-roll's window math.
 */
export function rangeIndices(
  aS: number,
  bS: number,
  fps: number | undefined,
  durationS: number,
  cap = RANGE_REQUEST_CAP,
): number[] {
  const f = fps && fps > 0 ? fps : FALLBACK_FPS
  const maxIdx = durationS > 0 ? Math.max(0, Math.ceil(durationS * f) - 1) : Number.MAX_SAFE_INTEGER
  const lo = Math.min(frameIndexAt(Math.min(aS, bS), fps), maxIdx)
  const hi = Math.min(frameIndexAt(Math.max(aS, bS), fps), maxIdx)
  const out: number[] = []
  for (let i = lo; i <= hi && out.length < cap; i++) out.push(i)
  return out
}

/**
 * Queue decode of every frame covering source-time range [aS, bS]. Transition
 * pre-roll: called each rAF while a pair-transition window is near so the
 * combine pass reads exact cached frames instead of seeking a <video>. Memory
 * stays bounded: only the window's frames are requested (RANGE_REQUEST_CAP,
 * then PENDING_CAP per pump pass) and the frame LRU (CACHE_BUDGET_BYTES) ages them out
 * once the cut has passed. Anchored at the range start so decode proceeds
 * ascending; a later getFrameAt re-anchors `latest` to the live playhead.
 */
export function prefetchRange(asset: MediaAsset, aS: number, bS: number): void {
  if (asset.kind !== 'video') return
  try {
    const indices = rangeIndices(aS, bS, asset.fps, asset.durationS)
    if (indices.length > 0) request(asset, indices, indices[0])
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
    closeIter(e)
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

/**
 * Set the preview decode scale (1 = Full, 0.5 = Half, 0.25 = Quarter). Changing
 * it drops every open demuxer + cached frame so subsequent decodes use the new
 * size. No-op when unchanged.
 */
export function setPreviewScale(scale: number): void {
  const s = scale > 0 ? scale : 1
  if (s === previewScale) return
  previewScale = s
  for (const id of [...entries.keys()]) evictAsset(id)
}

/**
 * Feed the active sequence's raster height (renderPreview calls this every
 * frame; no-op unless it changes). Only the Full tier decodes against it, so
 * only then does a change invalidate open demuxers + cached frames.
 */
export function setPreviewSequenceHeight(h: number): void {
  const v = Number.isFinite(h) && h > 0 ? Math.round(h) : 0
  if (v === sequenceH) return
  sequenceH = v
  if (previewScale >= 1) for (const id of [...entries.keys()]) evictAsset(id)
}

export function frameCacheStats(): { entries: number; assets: number } {
  return { entries: cache.size, assets: entries.size }
}
