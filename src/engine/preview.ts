// Live preview compositor. Builds a RenderFrame (pure resolve.ts) and draws it
// with the SHARED WebGL2 renderer — the same renderer the export worker uses,
// so preview and export are pixel-identical. Textures come from pooled <video>
// elements (playing), the WebCodecs frame cache (scrubbing), or <img> (stills).

import { getBlobUrl } from '../state/blobUrls'
import { getFrameAt, prefetchAround, prefetchRange, setPreviewSequenceHeight } from './frameCache'
import { createRenderer, type Renderer } from './render/glRenderer'
import { resolveFrame } from './render/resolve'
import { rasterizeTitle } from './render/titleRaster'
import type { RenderLayer, TextureSource } from './render/types'
import { clipDurationS, clipEndS } from './timeline'
import type { Clip, Id, MediaAsset, Sequence } from './types'

interface PooledVideo {
  el: HTMLVideoElement
  ready: boolean
}
interface PooledImage {
  el: HTMLImageElement
  ready: boolean
}

// Both pools are LRU-bounded: every acquire re-inserts (touch), so anything on
// screen can never be the eviction victim. A 100-asset library previously meant
// 100 buffering <video> decoders alive at once — decoders are a scarce hardware
// resource and each element buffers media.
const VIDEO_POOL_CAP = 12
const IMAGE_POOL_CAP = 48

const videoPool = new Map<Id, PooledVideo>()
const imagePool = new Map<Id, PooledImage>()

function lruTouch<V>(pool: Map<Id, V>, id: Id, v: V): void {
  pool.delete(id)
  pool.set(id, v)
}

function warmVideo(asset: MediaAsset): PooledVideo {
  const existing = videoPool.get(asset.id)
  if (existing) {
    lruTouch(videoPool, asset.id, existing)
    return existing
  }
  const el = document.createElement('video')
  el.muted = true // audio comes from the Web Audio graph, never the elements
  el.playsInline = true
  el.preload = 'auto'
  const pooled: PooledVideo = { el, ready: false }
  videoPool.set(asset.id, pooled)
  // Evict the least-recently-used PAUSED element. Never dispose one that is
  // actively playing (a multi-insert sweep like prewarm would otherwise evict
  // the on-screen video regardless of how recently a frame touched it);
  // tolerate temporary over-cap when everything is playing.
  if (videoPool.size > VIDEO_POOL_CAP) {
    for (const [id, v] of videoPool) {
      if (videoPool.size <= VIDEO_POOL_CAP) break
      if (id === asset.id || !v.el.paused) continue
      disposeVideo(id)
    }
  }
  void getBlobUrl(asset.blobKey).then((url) => {
    if (!url) return
    el.addEventListener('loadeddata', () => (pooled.ready = true), { once: true })
    el.src = url
  })
  return pooled
}

function warmImage(asset: MediaAsset): PooledImage {
  const existing = imagePool.get(asset.id)
  if (existing) {
    lruTouch(imagePool, asset.id, existing)
    return existing
  }
  const el = new Image()
  const pooled: PooledImage = { el, ready: false }
  imagePool.set(asset.id, pooled)
  while (imagePool.size > IMAGE_POOL_CAP) {
    disposeImage(imagePool.keys().next().value as Id)
  }
  void getBlobUrl(asset.blobKey).then((url) => {
    if (!url) return
    el.addEventListener('load', () => (pooled.ready = true), { once: true })
    el.src = url
  })
  return pooled
}

export function prewarmPreview(assets: MediaAsset[]): void {
  // Prewarm is best-effort: it touches what's already pooled and only creates
  // new elements while the pool has room. Only real render-loop acquires may
  // evict — a >cap sweep here would churn the whole pool (and the on-screen
  // element) on every edit.
  for (const a of assets) {
    if (a.kind === 'video') {
      if (videoPool.has(a.id) || videoPool.size < VIDEO_POOL_CAP) warmVideo(a)
    } else if (a.kind === 'image') {
      if (imagePool.has(a.id) || imagePool.size < IMAGE_POOL_CAP) warmImage(a)
    }
  }
}

export function pauseAllPreviewVideos(): void {
  for (const { el } of videoPool.values()) if (!el.paused) el.pause()
}

/**
 * Release the pooled <video>/<img> for a removed asset so its decoder + buffered
 * media don't leak for the session (pair with frameCache.evictAsset). Safe to
 * call for an unknown id; the element re-warms on next preview if the asset
 * comes back (undo).
 */
function disposeVideo(assetId: Id): void {
  const v = videoPool.get(assetId)
  if (!v) return
  if (!v.el.paused) v.el.pause()
  v.el.removeAttribute('src')
  v.el.load() // drops the decoder + buffered data held by the element
  videoPool.delete(assetId)
}

function disposeImage(assetId: Id): void {
  const img = imagePool.get(assetId)
  if (!img) return
  img.el.removeAttribute('src')
  imagePool.delete(assetId)
}

export function disposePreviewAsset(assetId: Id): void {
  disposeVideo(assetId)
  disposeImage(assetId)
}

// Live on-canvas transform override (Monitor gizmo). While the user drags a
// clip in the preview we override just that layer's x/y/scale so the frame
// updates in real time; the store commits once on release.
let liveTransform: { clipId: Id; x: number; y: number; scale: number } | null = null

// Monotonic token bumped whenever an imperative preview input changes that the
// store doesn't cover (the live gizmo transform). The Monitor's draw loop folds
// this into its dirty-check so a drag repaints even though the playhead and the
// stored project are unchanged.
let epoch = 0

/** Current preview invalidation token (see `epoch`). */
export function previewEpoch(): number {
  return epoch
}

/**
 * Force the next preview frame to redraw even if the playhead/project are
 * unchanged. Used when an out-of-band input lands — e.g. a bundled title font
 * finishing loading, which invalidates any title rasterized with the fallback.
 */
export function invalidatePreview(): void {
  epoch++
}

export function setLivePreviewTransform(v: { clipId: Id; x: number; y: number; scale: number } | null): void {
  liveTransform = v
  epoch++
}

// One renderer per canvas (a canvas keeps a single GL context for its life).
const renderers = new WeakMap<HTMLCanvasElement, Renderer | null>()

/**
 * The raster the LIVE canvas is actually drawing into, in device px. Titles are
 * rasterized against this instead of the sequence, so a small monitor does not
 * pay for a full 1080x1920 text canvas per caption.
 */
let previewRasterH = 0

/**
 * How much of the sequence raster a preview title needs. 1.5x the canvas gives
 * headroom for a resize or a hi-dpi display without a visible re-raster, and it
 * never exceeds the sequence (drawing text LARGER than the sequence would be
 * paying for detail the export path is the one that actually wants).
 */
function titleRasterScale(seqH: number): number {
  if (previewRasterH <= 0 || seqH <= 0) return 1
  const wanted = (previewRasterH * 1.5) / seqH
  if (wanted >= 1) return 1
  // Quantized, so a drag-resize of the panel does not invalidate the cache on
  // every pixel — only when it crosses a step.
  return Math.max(0.25, Math.ceil(wanted * 8) / 8)
}

function rendererFor(canvas: HTMLCanvasElement): Renderer | null {
  const cached = renderers.get(canvas)
  if (cached !== undefined) return cached
  // preserveDrawingBuffer so tests/screenshots can sample the last frame.
  const gl = canvas.getContext('webgl2', {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  })
  let renderer: Renderer | null = null
  if (gl) {
    try {
      // mipmapPreview: the panel raster is 3-6x below source res — mipmapped
      // minification kills the aliasing/shimmer. PREVIEW ONLY: the export
      // renderer must stay flagless (golden byte-tests pin its LINEAR path).
      renderer = createRenderer(gl, { mipmapPreview: true })
    } catch (err) {
      console.error('OL Studio: WebGL2 renderer init failed', err)
      renderer = null
    }
  }
  renderers.set(canvas, renderer)
  return renderer
}

// ---------------------------------------------------------------------------
// Pair-transition pre-roll. During a pair transition the resolver samples the
// OUTGOING clip past its cut while the INCOMING clip needs the pooled <video>
// — and when both clips come from the SAME asset (one take split into
// segments, the standard reel edit) they need the ONE pooled element at two
// source times at once: each rAF re-seeks it twice, the element never
// accumulates playback, and the window degenerates into a seek-decode
// slideshow. The cure: within TRANSITION_PRE_ROLL_S of a window the outgoing
// side's window frames are decoded into the frame cache, and during the window
// the from-layer reads the cache — the element belongs to the incoming side.

export const TRANSITION_PRE_ROLL_S = 1

/** Mirrors resolve.ts ADJ_EPS: pair windows must match the resolver's. */
const PAIR_ADJ_EPS = 1e-6

export interface PairTransitionWindow {
  /** Sequence-time window [startS, endS) at the incoming clip's head. */
  startS: number
  endS: number
  fromAssetId: Id
  toAssetId: Id
  /** Outgoing clip's source time at startS/endS (start > end when reversed). */
  fromSourceStartS: number
  fromSourceEndS: number
  /** Incoming clip's source time at startS. */
  toSourceStartS: number
}

/**
 * The pair-transition window at B's head, or null. Pure. Duplicates the
 * resolver's pair rules (adjacency, enabled, non-adjustment, duration clamp)
 * because resolve.ts keeps them private — keep in sync with resolveTrack.
 */
export function pairTransitionWindow(a: Clip, b: Clip, fps: number): PairTransitionWindow | null {
  if (!a.enabled || !b.enabled || a.adjustment || b.adjustment) return null
  if (Math.abs(clipEndS(a) - b.startS) >= PAIR_ADJ_EPS) return null
  const tr = b.transitionIn ?? a.transitionOut
  if (!tr) return null
  const maxD = Math.min(clipDurationS(a), clipDurationS(b))
  const d = Math.min(Math.max(tr.durationS, 1 / fps), maxD)
  const rate = Math.abs(a.speed || 1)
  const srcA = (t: number): number => (a.speed < 0 ? a.outS - (t - a.startS) * rate : a.inS + (t - a.startS) * rate)
  return {
    startS: b.startS,
    endS: b.startS + d,
    fromAssetId: a.assetId,
    toAssetId: b.assetId,
    fromSourceStartS: srcA(b.startS),
    fromSourceEndS: srcA(b.startS + d),
    toSourceStartS: b.speed < 0 ? b.outS : b.inS,
  }
}

/**
 * Every pair-transition window whose span or pre-roll contains tS. Pure.
 * Binary search finds the clip at the playhead; only pairs whose window can
 * still matter are examined (earlier windows have fully passed, later heads
 * sit beyond the pre-roll), so a long track costs O(log n) per frame.
 */
export function transitionWindowsNear(
  seq: Sequence,
  tS: number,
  preRollS = TRANSITION_PRE_ROLL_S,
): PairTransitionWindow[] {
  const out: PairTransitionWindow[] = []
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    const clips = track.clips
    // Last clip with startS <= tS (same sorted/non-overlap invariant resolve's
    // activeIndex relies on).
    let lo = 0
    let hi = clips.length - 1
    let i = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (clips[mid].startS <= tS) {
        i = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    // Pair (i-1, i) may still be inside its window; later pairs matter while
    // the incoming head is within the pre-roll horizon.
    for (let j = Math.max(1, i); j < clips.length && clips[j].startS <= tS + preRollS; j++) {
      const w = pairTransitionWindow(clips[j - 1], clips[j], seq.fps)
      if (w && tS < w.endS) out.push(w)
    }
  }
  return out
}

/**
 * rAF-driven pre-roll (playing only): decode the outgoing side's window frames
 * ahead of the cut and warm the incoming element so the window's first frame
 * doesn't cold-start a seek. No window near the playhead → near no-op.
 */
function prerollTransitions(seq: Sequence, assets: Record<Id, MediaAsset>, tS: number): void {
  for (const w of transitionWindowsNear(seq, tS)) {
    const from = assets[w.fromAssetId]
    if (from?.kind === 'video') prefetchRange(from, w.fromSourceStartS, w.fromSourceEndS)
    const to = assets[w.toAssetId]
    if (to?.kind === 'video') {
      const pooled = warmVideo(to)
      // Pre-seek only BEFORE the window and only a PAUSED element — a playing
      // one is on screen (including the same-asset case, where the outgoing
      // clip still owns it until the cut).
      if (
        tS < w.startS &&
        pooled.ready &&
        pooled.el.paused &&
        Math.abs(pooled.el.currentTime - w.toSourceStartS) > 0.15
      ) {
        pooled.el.currentTime = w.toSourceStartS
      }
    }
  }
}

/**
 * Resolve a layer to a texture. Playing → pooled <video> free-runs with drift
 * correction; paused → exact WebCodecs frame (miss returns null, a later rAF
 * catches it); stills → the decoded <img>. Side-effects (seek/play) live here.
 * `transitionFrom`: layers that are the OUTGOING side of a live pair
 * transition — served from the frame cache, never from an element seek.
 */
function makeTextureSource(
  assets: Record<Id, MediaAsset>,
  fps: number,
  playing: boolean,
  frameW: number,
  frameH: number,
  markPending: () => void,
  transitionFrom?: ReadonlySet<RenderLayer>,
): TextureSource {
  return (layer: RenderLayer): TexImageSource | null => {
    // Titles are generated, not imported. Rasterize them at PREVIEW size, not at
    // sequence size: a 1080x1920 caption canvas is an 8.3 MB allocation plus a
    // full-frame text raster on the main thread plus a texture upload and a
    // mipmap rebuild — and on a two-word caption cadence a NEW one lands roughly
    // twice a second while the video is playing, which is exactly when there is
    // no budget for it. On screen it is the same picture.
    if (layer.title) {
      const scale = titleRasterScale(frameH)
      return scale === 1
        ? rasterizeTitle(layer.title, frameW, frameH)
        : rasterizeTitle(layer.title, Math.round(frameW * scale), Math.round(frameH * scale), scale)
    }
    const asset = assets[layer.assetId]
    if (!asset) return null

    if (asset.kind === 'image') {
      const pooled = warmImage(asset)
      if (pooled.ready) return pooled.el
      markPending() // still loading — keep polling
      return null
    }
    if (asset.kind !== 'video') return null

    const srcT = layer.sourceTimeS
    if (playing && transitionFrom?.has(layer)) {
      // Outgoing side of a live pair transition, sampled past its cut. The
      // incoming side owns the pooled element (the SAME element when both clips
      // come from one asset — seeking it from here too would fight it twice per
      // rAF, the transition stutter). Serve the pre-rolled exact frame; on a
      // miss show the element AS-IS (never seek it) until the decode lands —
      // getFrameAt already queued it. Sampling past the media end freeze-frames
      // on the last real frame, which an element cannot do.
      const exact = getFrameAt(asset, srcT)
      if (exact) return exact as TexImageSource
      markPending()
      const pooled = videoPool.get(asset.id)
      return pooled?.ready ? pooled.el : null
    }
    if (!playing) {
      const pooled = warmVideo(asset)
      if (!pooled.el.paused) pooled.el.pause()
      const exact = getFrameAt(asset, srcT)
      prefetchAround(asset, srcT)
      // The cache only ever yields OffscreenCanvas/ImageBitmap — valid texture
      // sources — but its return type is the wider CanvasImageSource.
      if (exact) return exact as TexImageSource
      // No exact frame yet. Fall back to a nearest <video> seek — but the seek
      // is ASYNC, so this frame is NOT final: mark it pending so the draw loop
      // keeps polling until the exact decode lands (else it freezes mid-seek).
      markPending()
      if (!pooled.ready) return null
      if (Math.abs(pooled.el.currentTime - srcT) > 1 / (2 * fps)) pooled.el.currentTime = srcT
      return pooled.el
    }

    const pooled = warmVideo(asset)
    if (!pooled.ready) {
      markPending() // element still warming up — keep polling
      return null
    }
    const el = pooled.el
    // Match the element's rate to the clip's speed so a slowed/sped clip's
    // picture advances exactly as fast as the compositor samples it — otherwise
    // the source drifts and the tolerance re-seek below fires every few frames,
    // which is the stutter on slow-motion. Native <video> can't play backward,
    // so a reversed clip keeps rate 1 and rides the seek path. Browsers clamp
    // playbackRate to about [0.0625, 16].
    const wantRate = layer.speed > 0 ? Math.min(16, Math.max(0.0625, layer.speed)) : 1
    if (el.playbackRate !== wantRate) el.playbackRate = wantRate
    if (el.paused) {
      el.currentTime = srcT
      void el.play().catch(() => {})
    } else if (Math.abs(el.currentTime - srcT) > 0.15) {
      el.currentTime = srcT
    }
    return el
  }
}

/**
 * Render the sequence at time `tS` into `canvas` (already sized to the target
 * raster). Falls back to a cleared canvas when WebGL2 is unavailable.
 *
 * Returns `true` when every referenced layer resolved to a texture this frame,
 * `false` when something was still decoding/loading (a null texture source). The
 * Monitor's draw loop uses this to keep polling a paused frame until its exact
 * decode lands, then stop — instead of redrawing on every rAF forever.
 */
export function renderPreview(
  canvas: HTMLCanvasElement,
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  tS: number,
  playing: boolean,
): boolean {
  const renderer = rendererFor(canvas)
  if (!renderer) return true
  // Keep the scrub cache's Full-quality decode cap matched to this raster.
  setPreviewSequenceHeight(seq.height)
  // The live raster drives how big preview-only rasters (titles) need to be.
  previewRasterH = canvas.height
  const frame = resolveFrame(seq, tS)
  // Apply the live drag override to its layer (frame is freshly built, safe to mutate).
  if (liveTransform) {
    for (const op of frame.ops) {
      if (op.type === 'layer' && op.layer.clipId === liveTransform.clipId) {
        op.layer.transform.x = liveTransform.x
        op.layer.transform.y = liveTransform.y
        op.layer.transform.scale = liveTransform.scale
      }
    }
  }
  // Pause any pooled video no longer referenced this frame.
  if (playing) {
    const active = new Set<Id>()
    for (const op of frame.ops) {
      if (op.type === 'layer') active.add(op.layer.assetId)
      else if (op.type === 'transition') {
        active.add(op.from.assetId)
        active.add(op.to.assetId)
      }
      // adjustment ops reference no asset
    }
    for (const [id, { el }] of videoPool) if (!active.has(id) && !el.paused) el.pause()
  }
  // Transition pre-roll + the from-layers served from the frame cache this
  // frame. whiteFlash stand-ins (from/to are the same clip) keep the element
  // path — their "from" is the clip's own continuously-playing layer.
  let transitionFrom: Set<RenderLayer> | undefined
  if (playing) {
    prerollTransitions(seq, assets, tS)
    for (const op of frame.ops) {
      if (op.type === 'transition' && op.from.clipId !== op.to.clipId) {
        (transitionFrom ??= new Set()).add(op.from)
      }
    }
  }
  // A frame is "complete" only when every layer resolved to its FINAL texture
  // (the exact decoded frame / loaded image) — not a still-seeking <video>
  // fallback. While anything is pending, the caller keeps polling so the async
  // seek/decode lands instead of the preview freezing on a stale frame.
  let complete = true
  const source = makeTextureSource(
    assets,
    seq.fps,
    playing,
    frame.width,
    frame.height,
    () => {
      complete = false
    },
    transitionFrom,
  )
  renderer.render(frame, source)
  return complete
}
