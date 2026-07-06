// Live preview compositor. Builds a RenderFrame (pure resolve.ts) and draws it
// with the SHARED WebGL2 renderer — the same renderer the export worker uses,
// so preview and export are pixel-identical. Textures come from pooled <video>
// elements (playing), the WebCodecs frame cache (scrubbing), or <img> (stills).

import { getBlobUrl } from '../state/blobUrls'
import { getFrameAt, prefetchAround } from './frameCache'
import { createRenderer, type Renderer } from './render/glRenderer'
import { resolveFrame } from './render/resolve'
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
      console.error('OT Premiere: WebGL2 renderer init failed', err)
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
): TextureSource {
  return (layer: RenderLayer): TexImageSource | null => {
    const asset = assets[layer.assetId]
    if (!asset) return null

    if (asset.kind === 'image') {
      const pooled = warmImage(asset)
      return pooled.ready ? pooled.el : null
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
      // Fallback to a nearest <video> seek while the exact frame decodes.
      if (!pooled.ready) return null
      if (Math.abs(pooled.el.currentTime - srcT) > 1 / (2 * fps)) pooled.el.currentTime = srcT
      return pooled.el
    }

    const pooled = warmVideo(asset)
    if (!pooled.ready) return null
    const el = pooled.el
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
 */
export function renderPreview(
  canvas: HTMLCanvasElement,
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  tS: number,
  playing: boolean,
): void {
  const renderer = rendererFor(canvas)
  if (!renderer) return
  const frame = resolveFrame(seq, tS)
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
  renderer.render(frame, makeTextureSource(assets, seq.fps, playing))
}
