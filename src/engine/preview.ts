// Live preview compositor. Builds a RenderFrame (pure resolve.ts) and draws it
// with the SHARED WebGL2 renderer — the same renderer the export worker uses,
// so preview and export are pixel-identical. Textures come from pooled <video>
// elements (playing), the WebCodecs frame cache (scrubbing), or <img> (stills).

import { getBlobUrl } from '../state/blobUrls'
import { getFrameAt, prefetchAround } from './frameCache'
import { createRenderer, type Renderer } from './render/glRenderer'
import { resolveFrame } from './render/resolve'
import { rasterizeTitle } from './render/titleRaster'
import type { RenderLayer, TextureSource } from './render/types'
import type { Id, MediaAsset, Sequence } from './types'

interface PooledVideo {
  el: HTMLVideoElement
  ready: boolean
}
interface PooledImage {
  el: HTMLImageElement
  ready: boolean
}

const videoPool = new Map<Id, PooledVideo>()
const imagePool = new Map<Id, PooledImage>()

function warmVideo(asset: MediaAsset): PooledVideo {
  const existing = videoPool.get(asset.id)
  if (existing) return existing
  const el = document.createElement('video')
  el.muted = true // audio comes from the Web Audio graph, never the elements
  el.playsInline = true
  el.preload = 'auto'
  const pooled: PooledVideo = { el, ready: false }
  videoPool.set(asset.id, pooled)
  void getBlobUrl(asset.blobKey).then((url) => {
    if (!url) return
    el.addEventListener('loadeddata', () => (pooled.ready = true), { once: true })
    el.src = url
  })
  return pooled
}

function warmImage(asset: MediaAsset): PooledImage {
  const existing = imagePool.get(asset.id)
  if (existing) return existing
  const el = new Image()
  const pooled: PooledImage = { el, ready: false }
  imagePool.set(asset.id, pooled)
  void getBlobUrl(asset.blobKey).then((url) => {
    if (!url) return
    el.addEventListener('load', () => (pooled.ready = true), { once: true })
    el.src = url
  })
  return pooled
}

export function prewarmPreview(assets: MediaAsset[]): void {
  for (const a of assets) {
    if (a.kind === 'video') warmVideo(a)
    else if (a.kind === 'image') warmImage(a)
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
export function disposePreviewAsset(assetId: Id): void {
  const v = videoPool.get(assetId)
  if (v) {
    if (!v.el.paused) v.el.pause()
    v.el.removeAttribute('src')
    v.el.load() // drops the decoder + buffered data held by the element
    videoPool.delete(assetId)
  }
  const img = imagePool.get(assetId)
  if (img) {
    img.el.removeAttribute('src')
    imagePool.delete(assetId)
  }
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
      renderer = createRenderer(gl)
    } catch (err) {
      console.error('OL Studio: WebGL2 renderer init failed', err)
      renderer = null
    }
  }
  renderers.set(canvas, renderer)
  return renderer
}

/**
 * Resolve a layer to a texture. Playing → pooled <video> free-runs with drift
 * correction; paused → exact WebCodecs frame (miss returns null, a later rAF
 * catches it); stills → the decoded <img>. Side-effects (seek/play) live here.
 */
function makeTextureSource(
  assets: Record<Id, MediaAsset>,
  fps: number,
  playing: boolean,
  frameW: number,
  frameH: number,
  markPending: () => void,
): TextureSource {
  return (layer: RenderLayer): TexImageSource | null => {
    // Titles are generated, not imported — rasterize at sequence resolution.
    if (layer.title) return rasterizeTitle(layer.title, frameW, frameH)
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
      else {
        active.add(op.from.assetId)
        active.add(op.to.assetId)
      }
    }
    for (const [id, { el }] of videoPool) if (!active.has(id) && !el.paused) el.pause()
  }
  // A frame is "complete" only when every layer resolved to its FINAL texture
  // (the exact decoded frame / loaded image) — not a still-seeking <video>
  // fallback. While anything is pending, the caller keeps polling so the async
  // seek/decode lands instead of the preview freezing on a stale frame.
  let complete = true
  const source = makeTextureSource(assets, seq.fps, playing, frame.width, frame.height, () => {
    complete = false
  })
  renderer.render(frame, source)
  return complete
}
