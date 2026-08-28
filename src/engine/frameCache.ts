// Frame-accurate scrub cache (spec §4.2 decode.ts): WebCodecs-backed exact
// frames for the PAUSED/scrubbing preview path. The Monitor redraws every rAF,
// so there is no push notification: a miss kicks an async decode and a later
// rAF picks the frame up from the cache.
//
// mediabunny + persistence are loaded via dynamic import on first decode so
// this module stays importable in a plain node test env (no DOM, no IDB).

import type { CanvasSink, Input, WrappedCanvas } from 'mediabunny'
import { bumpProxyPriority, hasProxy, proxyKeyFor } from './proxyMedia'
import { budgets } from './memoryBudget'
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
 *
 * 512 MB, raised from 192 MB on 2026-08-19. A 1080x1920 frame is 8.3 MB, so the
 * old budget held twenty-three of them: a half second dissolve wants fifteen
 * frames from EACH side at 30 fps, so a single transition could not fit in the
 * cache at all and every frame of it was decoded twice. The preview copy now
 * keeps a vertical short at its full size rather than shrinking it to 608x1080,
 * which makes each cached frame three times bigger again, so the old number
 * would have held seven. His machine has 32 GB. This is the one place where
 * paying memory buys back decoding he can see.
 */
export const CACHE_BUDGET_BYTES = 512 * 1024 * 1024

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
 * KEYFRAME anyway, typically 2s ≈ 60 frames of work). Behind always reopens.
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
// sequence (vertical 1080×1920 shorts, 4K timelines) gets 1:1 paused frames.
let sequenceH = 0

/**
 * Target decode height for an asset's preview frames, or undefined to decode at
 * native size (never upscales). Pure: the sizing policy the sink uses.
 * At Full quality (scale >= 1) a sequence TALLER than the base cap raises the
 * cap to the sequence height. Capping a 1920-tall short to 1080 softened every
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

/**
 * The decode/upload cap for an asset RIGHT NOW, applying the live quality tier
 * and sequence raster. Undefined when the source is already at or under it.
 * The paused path uses this to decode small; the live preview uses it to stop
 * uploading a native-resolution frame every time it draws.
 */
export const previewCapHeight = (nativeH: number | undefined): number | undefined =>
  previewTargetHeight(nativeH, previewScale, PREVIEW_BASE_MAX_H, sequenceH)

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests, so no DOM and no mediabunny)

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
   * The newest entry is always kept even if it alone exceeds the budget. A
   * cache that refuses the frame it was just asked to hold is worse than one
   * slightly over its ceiling.
   */
  /**
   * ⛔ A FUNCTION IS ACCEPTED, NOT JUST A NUMBER, SINCE 2026-08-24. The ceiling
   * was fixed at construction and therefore fixed for the life of the session,
   * which is how 512 MB of frames was taken on a machine that had 7.6 GB spare
   * and was already paging. A budget that cannot change cannot respond to the
   * machine. A plain number still works and still means "this, forever", which is
   * what every test wants.
   */
  private readonly budgetOf: () => number

  constructor(
    budget: number | (() => number),
    private readonly costOf: (v: V) => number = () => 1,
  ) {
    this.budgetOf = typeof budget === 'function' ? budget : () => budget
  }

  /** The ceiling in force right now. */
  get budgetBytes(): number {
    return this.budgetOf()
  }

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
  /** Latest requested index: the ranking anchor while scrubbing. */
  latest: number
  pumping: boolean
  failed: boolean
  /** Indices the demuxer has no frame for (before track start). Never re-request these. */
  noFrame: Set<number>
  /**
   * Persistent sequential reader. getCanvas() is a RANDOM seek: it decodes
   * forward from the previous keyframe for EVERY requested frame (~a whole GOP
   * of work per frame, the old scrub lag). The iterator decodes each frame
   * once and steps forward; only a backward jump or a large forward jump
   * re-seeks. Every frame it passes is cached, so a forward scrub is ~1 decode
   * per frame instead of ~GOP decodes per frame.
   */
  iter: AsyncGenerator<WrappedCanvas, void, unknown> | null
  /** Nominal frame index the iterator will yield NEXT (advances as it reads). */
  iterIdx: number
  /**
   * Whether the open demuxer is reading the short-GOP preview copy. A proxy can
   * land while an asset is already open, and the entry must then be torn down
   * and reopened: the frames already cached came from the original and are
   * still correct, but every future seek should be paying proxy prices.
   */
  usingProxy: boolean
}

// The ceiling follows the machine now, see engine/memoryBudget.ts. CACHE_BUDGET_BYTES
// is still exported as what it used to be, and is still the ceiling that share can
// never exceed.
const cache = new FrameLru<CanvasImageSource>(() => budgets().frames, frameBytes)
const entries = new Map<Id, AssetEntry>()

/**
 * Running tallies, so a scrub can be asked what it DID rather than guessed at.
 *
 * ⛔ TWENTY SCRUB STEPS ACROSS HIS OWN EDIT LEFT ONE FRAME IN A 512 MB CACHE,
 * 2026-08-22, holding 1.5 percent of its budget. That rules out eviction for
 * size, and it leaves three stories that look identical from outside: frames
 * were never decoded, they were decoded and stored under a key nothing ever asks
 * for, or they were stored and then dropped. These separate the three in one
 * run, and a hit rate near zero while the picture is being drawn means he is
 * watching a held stale frame, which is exactly what "laggy" feels like.
 */
const tally = { hits: 0, misses: 0, stores: 0, lruDropped: 0, assetDropped: 0, decodes: 0, doneEarly: 0, noFramed: 0 }

/** Cache a decoded frame, counting it and anything the LRU had to drop to fit. */
function keep(key: string, canvas: CanvasImageSource): void {
  tally.stores++
  tally.lruDropped += cache.set(key, canvas).length
}

const cacheKey = (assetId: Id, index: number): string => `${assetId}:${index}`

/**
 * ⛔ HOW MANY HARDWARE DECODERS THE PREVIEW MAY HOLD OPEN AT ONCE, 2026-08-28.
 *
 * Every `AssetEntry` owns an open mediabunny `Input` plus a `CanvasSink`, and a
 * CanvasSink owns a hardware VideoDecoder. Nothing closed them. Scrub across a
 * timeline and every asset the playhead touches opens one and keeps it for the
 * rest of the session.
 *
 * That is not merely memory. **Past the platform's concurrent-decoder limit
 * Chromium falls back to SOFTWARE decode**, which costs more RAM and is slower,
 * so after enough scrubbing the app permanently downgrades its own decoding and
 * only a restart clears it. The person with the most footage pays the most.
 *
 * ⚠️ THIS APP ALREADY SOLVED THIS, 300 LINES AWAY, AND ONLY FOR THE EXPORT.
 * `export/providerPool.ts` is a bounded LRU pool with
 * `DEFAULT_MAX_LIVE_PROVIDERS = 8` under a docblock that predicts this exact
 * failure. The same number for the same reason: one clip per video track plus
 * one for the far side of a transition, with headroom.
 */
const MAX_LIVE_DECODERS = 8

/**
 * Close an entry's demuxer and decoder but KEEP its decoded frames.
 *
 * Not `evictAsset`, which also drops the cached frames: those are separately
 * budgeted, they are the expensive thing to rebuild, and throwing them away to
 * free a decoder would trade the cheap resource for the dear one. Same shape as
 * `reopenProxyBacked`, so the next `request` reopens through `e.ready ??=`.
 */
function closeDecoder(e: AssetEntry): void {
  e.pending = []
  closeIter(e)
  e.input?.dispose()
  e.input = null
  e.sink = null
  e.ready = null
}

/**
 * Bring the live decoder count back under the ceiling, oldest first.
 *
 * ⚠️ NEVER TAKES ONE MID-DECODE. An entry that is pumping or has a frame in
 * flight is skipped: closing it would strand the pump on a disposed input and
 * the frame he is waiting for would never arrive. The ceiling can therefore be
 * exceeded briefly, exactly as the export pool allows, rather than break a frame
 * that is genuinely being decoded.
 */
function reapDecoders(keepId: Id): void {
  const open = [...entries.values()].filter((e) => e.input !== null)
  let live = open.length
  if (live <= MAX_LIVE_DECODERS) return
  for (const e of open) {
    if (live <= MAX_LIVE_DECODERS) return
    if (e.asset.id === keepId) continue
    if (e.pumping || e.decoding !== null) continue
    closeDecoder(e)
    live -= 1
  }
}

function ensureEntry(asset: MediaAsset): AssetEntry {
  let e = entries.get(asset.id)
  if (e) {
    // Touch: re-inserting moves it to the end, so `entries` reads oldest-first
    // and `reapDecoders` above closes the least recently ASKED FOR rather than
    // the least recently opened. Without this a decoder opened early and used
    // constantly would be the first one taken.
    entries.delete(asset.id)
    entries.set(asset.id, e)
  }
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
      usingProxy: false,
    }
    entries.set(asset.id, e)
  }
  return e
}

/** Should the sequential reader re-seek to reach `target`? (Pure, tested.) */
export function needsReopen(iterIdx: number, target: number, gap = SEQ_REOPEN_GAP): boolean {
  if (iterIdx < 0) return true // no reader yet
  if (target < iterIdx) return true // behind, and the reader is forward-only
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
  // PREVIEW ONLY. When a short-GOP preview copy exists, decode from it: a
  // random seek in it costs at most a dozen small frames instead of decoding
  // through to the next keyframe of the camera original, which is the entire
  // reason cuts could not be served in time. Export never comes through here;
  // it resolves blobKey itself and always gets the original.
  //
  // The STORED COPY decides, not a flag. Asking storage directly means this is
  // right after a reload, right across a module boundary, and right when the
  // transcode finished a moment ago, none of which an in-memory set can promise.
  const proxy = fullQuality ? null : await getBlob(proxyKeyFor(e.asset.id))
  const blob = proxy && proxy.size > 0 ? proxy : await getBlob(e.asset.blobKey)
  if (!blob) throw new Error(`frameCache: no blob for key ${e.asset.blobKey}`)
  e.usingProxy = blob === proxy
  const input = new MbInput({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    input.dispose()
    throw new Error(`frameCache: no video track in asset ${e.asset.id}`)
  }
  e.input = input
  // poolSize deliberately omitted: 0/undefined disables mediabunny's canvas
  // pool, so every getCanvas yields a FRESH canvas: cached frames must never
  // be recycled underneath us. Decode at PREVIEW height (downscaled) so large
  // sources scrub cheaply; export uses its own full-res decode.
  const th = previewTargetHeight(e.asset.height, previewScale, PREVIEW_BASE_MAX_H, sequenceH)
  e.sink = th ? new Sink(track, { height: th }) : new Sink(track)
  // The decoder exists from this line on, so this is where the ceiling is
  // enforced. See MAX_LIVE_DECODERS: unbounded, this is where Chromium quietly
  // drops the whole app to software decode.
  reapDecoders(e.asset.id)
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
  tally.decodes++
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
      tally.doneEarly++
      if (prev) keep(targetKey, prev.canvas)
      else {
        tally.noFramed++
        e.noFrame.add(idx)
      }
      closeIter(e)
      return
    }
    const w = r.value
    const wIdx = frameIndexAt(w.timestamp, e.asset.fps)
    keep(cacheKey(e.asset.id, wIdx), w.canvas)
    e.iterIdx = wIdx + 1
    if (wIdx === idx) return // exact hit
    if (wIdx > idx) {
      // Overshot the nominal grid (sparse/VFR timestamps): the frame shown at
      // the target time is the last one before it, else clamp to the first.
      keep(targetKey, (prev ?? w).canvas)
      return
    }
    prev = w
  }
}

/** One serialized decode chain per asset: concurrent seeks on one demuxer corrupt state. */
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
  // A preview copy finished transcoding while this asset was already open.
  // Reopen against it, or every seek keeps paying the original's price for the
  // rest of the session, which is the whole cost the proxy was built to remove.
  if (!e.usingProxy && hasProxy(asset.id) && e.ready) {
    closeIter(e)
    e.input?.dispose()
    e.input = null
    e.sink = null
    e.ready = null
  } else if (!e.usingProxy && !hasProxy(asset.id)) {
    // Being asked for a frame of this asset is the app's best evidence about
    // which clip he is on, and it is exactly the asset whose copy is worth
    // building first. Costs an index lookup on a list that is only long right
    // after a big import, which is the one time it matters.
    bumpProxyPriority(asset.id)
  }
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
    if (hit) {
      tally.hits++
      return hit
    }
    tally.misses++
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
 * Ascending frame indices covering source-time range [aS, bS] (either order,
 * since a reversed clip's window runs backward), clamped to the asset's last
 * frame and capped at `cap`. Pure: the transition pre-roll's window math.
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

/**
 * While this is on, every decode opens the CAMERA ORIGINAL and the preview copy
 * is ignored.
 *
 * ⛔ HIS SCREENSHOTS WERE COMING OUT OF THE PROXY, AND HE SAW IT. 2026-08-19:
 * *"the screenshot quality from the app is really bad."* `grabFrame` renders at
 * the sequence's own size and its header says it goes "through the renderer the
 * export uses", but it does not: it comes through here, and here preferred the
 * proxy. The proxy is capped at 1080 lines and re-encoded at crf, so a still of
 * a 1080x1920 short was being UPSCALED out of a compressed half height copy.
 * Full size and soft, which reads as a broken feature rather than a setting.
 *
 * ⚠️ IT IS A SESSION WIDE SWITCH AND IT MUST BE TURNED BACK OFF. Anything
 * decoded while it is on pays the original's seek cost, which is exactly what
 * the proxy exists to avoid. `withFullQuality` is the only thing that should
 * touch it, because it puts it back in a finally.
 */
let fullQuality = false

/**
 * Run `fn` with every decode reading the original.
 *
 * ⛔ THE OPEN DEMUXERS ARE THROWN AWAY ON BOTH SIDES. A clip already open
 * against its proxy would keep serving proxy frames however this flag is set,
 * and on the way back out the same clip would keep paying the original's price
 * for the rest of the session. Reopening twice costs one seek each and buys a
 * still that is actually his footage.
 */
export async function withFullQuality<T>(fn: () => Promise<T>): Promise<T> {
  fullQuality = true
  reopenProxyBacked()
  try {
    return await fn()
  } finally {
    fullQuality = false
    reopenProxyBacked()
  }
}

/**
 * Close every demuxer whose source no longer matches what we now want.
 *
 * What we want is `usingProxy === !fullQuality`, so a clip is closed exactly
 * when `usingProxy` still equals `fullQuality`. Going back to normal, a clip
 * with no proxy on disk is left alone: reopening it would land on the same file
 * it already has and cost a seek for nothing.
 */
function reopenProxyBacked(): void {
  for (const e of entries.values()) {
    if (e.usingProxy !== fullQuality) continue
    if (!fullQuality && !hasProxy(e.asset.id)) continue
    closeIter(e)
    e.input?.dispose()
    e.input = null
    e.sink = null
    e.ready = null
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
    if (key.startsWith(prefix)) {
      cache.delete(key)
      tally.assetDropped++
    }
  }
}

/**
 * Set the preview decode scale (1 = Full, 0.5 = Half, 0.25 = Quarter). Changing
 * it drops every open demuxer + cached frame so subsequent decodes use the new
 * size. No-op when unchanged.
 */
/**
 * The decode scale in force right now (1 = Full). The still grab reads it so it
 * can lift the tier to Full for one frame and put his own tier back after.
 */
export function currentPreviewScale(): number {
  return previewScale
}

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

/**
 * What the decoded-frame cache is actually holding.
 *
 * ⛔ `bytes` AND `budget` ARE HERE BECAUSE THE COUNT ALONE LIES. Measured on his
 * own 44 clip edit, 2026-08-22: twenty scrub steps left the cache holding ONE
 * frame against a 512 MB budget, and one entry is the exact signature of the
 * LRU evicting down to its floor. Without the weight there is no way to tell
 * that from "nothing was ever decoded", and those two want opposite fixes.
 */
export function frameCacheStats(): Record<string, number> {
  const live = [...entries.values()]
  return {
    entries: cache.size,
    assets: entries.size,
    bytes: cache.bytes,
    budget: cache.budgetBytes,
    ...tally,
    // ⛔ THE TWO THAT SEPARATE "IDLE" FROM "STUCK". A pump holds `pumping` for
    // its whole loop, so a pump that never returns blocks every later request
    // from starting one: the queue grows and nothing drains it. Idle looks the
    // same from the outside and wants the opposite fix.
    pumping: live.filter((e) => e.pumping).length,
    queued: live.reduce((n, e) => n + e.pending.length, 0),
    decodingNow: live.filter((e) => e.decoding !== null).length,
    failed: live.filter((e) => e.failed).length,
    // ⛔ THE ONE THAT SAYS WHETHER CHROMIUM HAS DROPPED US TO SOFTWARE DECODE.
    // `assets` above counts entries, most of which hold no decoder; this counts
    // the ones that do, which is the number the platform has a ceiling on. It is
    // the only way to see the failure from outside, because a software fallback
    // is not an error: it is silent, permanent for the session, and just slow.
    openDecoders: live.filter((e) => e.input !== null).length,
    decoderCap: MAX_LIVE_DECODERS,
  }
}
