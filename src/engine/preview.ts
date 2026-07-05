// MVP preview compositor (spec §4.3): pooled <video>/<img> elements drawn
// onto a 2D canvas each rAF. Replaced by WebCodecs getFrameAt in Phase 3.

import { getBlobUrl } from '../state/blobUrls'
import { getFrameAt, prefetchAround } from './frameCache'
import { clipEndS } from './timeline'
import { videoTracks, type Id, type MediaAsset, type Sequence } from './types'

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

/** Pre-create pool entries so first playback doesn't stutter on load. */
export function prewarmPreview(assets: MediaAsset[]): void {
  for (const a of assets) {
    if (a.kind === 'video') warmVideo(a)
    else if (a.kind === 'image') warmImage(a)
  }
}

export function pauseAllPreviewVideos(): void {
  for (const { el } of videoPool.values()) {
    if (!el.paused) el.pause()
  }
}

function drawContain(
  c2d: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  W: number,
  H: number,
  opacity: number,
): void {
  if (sw <= 0 || sh <= 0) return
  const scale = Math.min(W / sw, H / sh)
  const dw = sw * scale
  const dh = sh * scale
  const prevAlpha = c2d.globalAlpha
  c2d.globalAlpha = Math.max(0, Math.min(1, opacity))
  c2d.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh)
  c2d.globalAlpha = prevAlpha
}

/**
 * Composite the sequence at time tS onto the canvas, bottom track first.
 * While playing, pooled videos free-run (drift-corrected) instead of seeking
 * every frame; while paused/scrubbing they hard-seek to the exact time.
 */
export function drawSequenceFrame(
  c2d: CanvasRenderingContext2D,
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  tS: number,
  W: number,
  H: number,
  playing: boolean,
): void {
  c2d.fillStyle = '#000'
  c2d.fillRect(0, 0, W, H)

  const activeVideoAssets = new Set<Id>()

  for (const track of videoTracks(seq)) {
    if (track.muted) continue
    const clip = track.clips.find((c) => c.enabled && tS >= c.startS && tS < clipEndS(c))
    if (!clip) continue
    const asset = assets[clip.assetId]
    if (!asset) continue

    if (asset.kind === 'image') {
      const pooled = warmImage(asset)
      if (pooled.ready) {
        drawContain(c2d, pooled.el, pooled.el.naturalWidth, pooled.el.naturalHeight, W, H, clip.opacity)
      }
      continue
    }

    if (asset.kind !== 'video') continue
    const srcT = clip.inS + (tS - clip.startS) * Math.abs(clip.speed || 1)
    const pooled = warmVideo(asset)
    activeVideoAssets.add(asset.id)

    if (!playing) {
      // Frame-accurate scrub (Phase 3): exact WebCodecs frame when cached;
      // a miss kicks the decode and the next rAF picks it up.
      if (!pooled.el.paused) pooled.el.pause()
      const exact = getFrameAt(asset, srcT)
      prefetchAround(asset, srcT)
      if (exact) {
        // The cache yields canvases/bitmaps — both carry numeric width/height.
        const size = exact as unknown as { width: number; height: number }
        drawContain(c2d, exact, size.width, size.height, W, H, clip.opacity)
        continue
      }
    }
    if (!pooled.ready) continue

    const el = pooled.el
    if (playing) {
      if (el.paused) {
        el.currentTime = srcT
        void el.play().catch(() => {
          // Autoplay rejection: the drift-correct path below still seeks.
        })
      } else if (Math.abs(el.currentTime - srcT) > 0.15) {
        el.currentTime = srcT
      }
    } else if (Math.abs(el.currentTime - srcT) > 1 / (2 * seq.fps)) {
      // Fallback while the exact frame decodes: nearest <video> seek.
      el.currentTime = srcT
    }
    drawContain(c2d, el, el.videoWidth, el.videoHeight, W, H, clip.opacity)
  }

  if (playing) {
    for (const [id, { el }] of videoPool) {
      if (!activeVideoAssets.has(id) && !el.paused) el.pause()
    }
  }
}
