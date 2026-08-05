// Live preview compositor. Builds a RenderFrame (pure resolve.ts) and draws it
// with the SHARED WebGL2 renderer, the same renderer the export worker uses,
// so preview and export are pixel-identical. Textures come from pooled <video>
// elements (playing), the WebCodecs frame cache (scrubbing), or <img> (stills).

import { getBlobUrl } from '../state/blobUrls'
import {
  getFrameAt,
  prefetchAround,
  prefetchRange,
  previewCapHeight,
  setPreviewSequenceHeight,
} from './frameCache'
import {
  attachFrameProbe,
  recordServedFrame,
  resetPreviewHealth,
  type FrameProbe,
} from './previewTruth'
import { createRenderer, type Renderer } from './render/glRenderer'
import { resolveFrame } from './render/resolve'
import { rasterizeTitle } from './render/titleRaster'
import type { RenderLayer, TextureSource } from './render/types'
import { clipDurationS, clipEndS } from './timeline'
import type { Clip, Id, MediaAsset, Sequence } from './types'

interface PooledVideo {
  el: HTMLVideoElement
  ready: boolean
  /**
   * Which frame this element is ACTUALLY showing. `el.currentTime` is the
   * element's playback position, not the picture; see previewTruth.ts.
   */
  probe: FrameProbe
  /**
   * The clip this element was last serving. A change means the element has been
   * handed to a different piece of the timeline (a cut), which is a re-anchor,
   * not drift: seeking is correct and steering is not.
   */
  servingClipId: Id | null
}
interface PooledImage {
  el: HTMLImageElement
  ready: boolean
}

// Both pools are LRU-bounded: every acquire re-inserts (touch), so anything on
// screen can never be the eviction victim. A 100-asset library previously meant
// 100 buffering <video> decoders alive at once. Decoders are a scarce hardware
// resource and each element buffers media.
/**
 * Picture-vs-playhead drift past this is a real jump (a cut, a scrub, a loop
 * wrap) and gets a seek. Anything smaller is steered out by trimming the
 * element's rate, which the viewer cannot see. A seek, they can.
 */
const HARD_SEEK_S = 0.35
/** Ceiling on that trim. ±2% is inaudible and invisible. */
const RATE_TRIM = 0.02
/** Roughly how long the servo takes to absorb an error, in seconds. */
const SERVO_TAU_S = 2
/**
 * How far the element's real presented frame may sit from the wanted frame
 * before the exact decode is served instead. Under two frame periods is the
 * most a viewer cannot see, and it keeps a healthy long clip on the cheap
 * element path where it belongs.
 */
const ELEMENT_TOL_FRAMES = 1.5
/**
 * A probe that has not reported for this long means the element is not
 * presenting frames (stalled, seeking, or throttled), so its last reported
 * timestamp is stale and the element's own clock is the better guess.
 */
const PROBE_STALE_MS = 250

const VIDEO_POOL_CAP = 12
/**
 * How many upcoming plain cuts to warm per frame. Comfortably under
 * VIDEO_POOL_CAP so pre-rolling can never evict what it just warmed, and the
 * playing element is never a candidate anyway.
 */
const PREROLL_CUT_LIMIT = 4
/**
 * How much of an upcoming cut's head to decode ahead of it. Long enough to
 * cover a <video> seek (which is where the picture used to be lost), short
 * enough that four pre-rolled heads cannot evict the frames being played.
 */
const CUT_HEAD_PREFETCH_S = 0.75
const IMAGE_POOL_CAP = 48

const videoPool = new Map<Id, PooledVideo>()
const imagePool = new Map<Id, PooledImage>()

/** Last play/pause state renderPreview saw, so a transition can reset the health window. */
let wasPlaying = false
/** The cut whose head has already been queued for decode, so it is asked for once, not per rAF. */
let prefetchedCutId: Id | null = null

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
  const pooled: PooledVideo = { el, ready: false, probe: attachFrameProbe(el), servingClipId: null }
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
  // evict: a >cap sweep here would churn the whole pool (and the on-screen
  // element) on every edit.
  for (const a of assets) {
    if (a.kind === 'video') {
      if (videoPool.has(a.id) || videoPool.size < VIDEO_POOL_CAP) warmVideo(a)
    } else if (a.kind === 'image') {
      if (imagePool.has(a.id) || imagePool.size < IMAGE_POOL_CAP) warmImage(a)
    }
  }
}

/**
 * The same prewarm, AWAITABLE, so the boot card can report it honestly rather
 * than ticking a row the instant it fired the work off.
 *
 * Resolves once every warmed element has actually decoded its first frame (or
 * given up), which is the moment that matters: an element with `ready:false`
 * draws NOTHING, and a layer with no texture is the black frame this project has
 * already shipped two fixes for. Warming at boot means the first play is not the
 * one paying for it.
 *
 * Never rejects, and never waits forever: a file that will not decode gets a
 * few seconds and is then left behind, because the app must open.
 */
export async function warmPreview(assets: MediaAsset[], timeoutMs = 6000): Promise<number> {
  prewarmPreview(assets)
  const pooled: { ready: boolean }[] = assets
    .map((a) => (a.kind === 'video' ? videoPool.get(a.id) : a.kind === 'image' ? imagePool.get(a.id) : undefined))
    .filter((p): p is PooledVideo | PooledImage => p !== undefined)
  if (pooled.length === 0) return 0

  const deadline = Date.now() + timeoutMs
  // Poll rather than race a listener per element: the `ready` flag is set by the
  // existing one-shot listeners, so this reads the same truth the renderer does
  // and cannot double-register on an element that is already pooled and warm.
  while (Date.now() < deadline && pooled.some((p) => !p.ready)) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return pooled.filter((p) => p.ready).length
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
  v.probe.stop()
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
 * unchanged. Used when an out-of-band input lands, e.g. a bundled title font
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
 * The TRANSPORT's rate: 1 for normal play, ±2/±4 while shuttling on J/L.
 *
 * Pushed in by playbackControl (which already publishes only on change) rather
 * than pulled, because playbackControl imports this module and the reverse would
 * be a cycle.
 */
let transportRate = 1

export function setPreviewTransportRate(rate: number): void {
  transportRate = rate === 0 ? 1 : rate
}

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
  // every pixel, only when it crosses a step.
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
      // mipmapPreview: the panel raster is 3-6x below source res, so mipmapped
      // minification kills the aliasing/shimmer. PREVIEW ONLY: the export
      // renderer must stay flagless (golden byte-tests pin its LINEAR path).
      renderer = createRenderer(gl, { mipmapSources: true })
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
// OUTGOING clip past its cut while the INCOMING clip needs the pooled <video>.
// When both clips come from the SAME asset (one take split into segments, the
// standard short-form edit) they need the ONE pooled element at two
// source times at once: each rAF re-seeks it twice, the element never
// accumulates playback, and the window degenerates into a seek-decode
// slideshow. The cure: within TRANSITION_PRE_ROLL_S of a window the outgoing
// side's window frames are decoded into the frame cache, and during the window
// the from-layer reads the cache, because the element belongs to the incoming side.

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
 * because resolve.ts keeps them private. Keep in sync with resolveTrack.
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
 * Heads of clips about to START within the pre-roll horizon. Pure, and the same
 * binary search and bound as transitionWindowsNear.
 *
 * Why this exists: pairTransitionWindow returns null when no transition joins
 * two clips, so transitionWindowsNear sees nothing at an ORDINARY cut and the
 * pre-roll never fired for one. The incoming element was therefore created cold
 * at the cut, warmVideo hands back ready:false, the texture source returns null,
 * and a layer with no texture is simply not drawn: a black frame exactly on the
 * cut. Prewarm could not cover it either, because it only creates elements
 * while the pool is UNDER its cap of 12, so past a dozen distinct clips the
 * newest cut always started cold. That is the "black frames when there are a
 * lot of clips and cuts" case.
 */
export function upcomingCutHeads(seq: Sequence, tS: number, preRollS = TRANSITION_PRE_ROLL_S): Clip[] {
  const out: Clip[] = []
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    const clips = track.clips
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
    for (let j = Math.max(0, i + 1); j < clips.length && clips[j].startS <= tS + preRollS; j++) {
      const c = clips[j]
      if (c.startS > tS && c.enabled && !c.adjustment) out.push(c)
    }
  }
  return out
}

/**
 * Warm (and pre-seek) the element an upcoming PLAIN cut is about to need, the
 * way prerollTransitions already does for the incoming side of a transition.
 * Idempotent: warmVideo returns the pooled element when it already exists, and
 * its eviction never touches a element that is still playing, so the on-screen
 * one cannot be churned out from under the cut.
 */
function prerollCuts(seq: Sequence, assets: Record<Id, MediaAsset>, tS: number): void {
  // Nearest cuts first, and only a few. On a very cut-dense timeline the horizon
  // can name more distinct assets than the 12-slot pool holds, and warming all
  // of them every frame would evict the ones just warmed: a thrash that costs
  // more than the cold start it replaces. The imminent cut is the one that
  // matters, so bound the work and let later heads be warmed by later frames.
  const heads = upcomingCutHeads(seq, tS)
    .sort((c1, c2) => c1.startS - c2.startS)
    .slice(0, PREROLL_CUT_LIMIT)
  // Decode-ahead goes to the NEXT cut only, and only once per clip. All the
  // pieces of one recording share a single serialized decode chain, so asking
  // for four scattered heads on every rAF re-ordered that chain sixty times a
  // second and it finished none of them: the queue is bounded, so each new
  // request pushed out the frames the imminent cut was about to need. One small
  // target, issued once, is a target it can actually complete.
  const next = heads[0]
  if (next && next.id !== prefetchedCutId) {
    prefetchedCutId = next.id
    const asset = assets[next.assetId]
    if (asset?.kind === 'video') {
      prefetchRange(asset, next.inS, next.inS + Math.min(CUT_HEAD_PREFETCH_S, clipDurationS(next)))
    }
  }
  for (const clip of heads) {
    const asset = assets[clip.assetId]
    if (asset?.kind !== 'video') continue
    const pooled = warmVideo(asset)
    // Same guard as the transition path: only pre-seek a PAUSED element, never
    // one that is on screen, and only when it is meaningfully off target.
    if (pooled.ready && pooled.el.paused && Math.abs(pooled.el.currentTime - clip.inS) > 0.15) {
      pooled.el.currentTime = clip.inS
    }
  }
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
      // Pre-seek only BEFORE the window and only a PAUSED element. A playing
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
 * transition, served from the frame cache, never from an element seek.
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
    // mipmap rebuild. On a two-word caption cadence a NEW one lands roughly
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
      markPending() // still loading, keep polling
      return null
    }
    if (asset.kind !== 'video') return null

    const srcT = layer.sourceTimeS
    if (playing && transitionFrom?.has(layer)) {
      // Outgoing side of a live pair transition, sampled past its cut. The
      // incoming side owns the pooled element (the SAME element when both clips
      // come from one asset, and seeking it from here too would fight it twice
      // per rAF, the transition stutter). Serve the pre-rolled exact frame; on a
      // miss show the element AS-IS (never seek it) until the decode lands.
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
      // The cache only ever yields OffscreenCanvas/ImageBitmap (valid texture
      // sources), but its return type is the wider CanvasImageSource.
      if (exact) return exact as TexImageSource
      // No exact frame yet. Fall back to a nearest <video> seek, but the seek
      // is ASYNC, so this frame is NOT final: mark it pending so the draw loop
      // keeps polling until the exact decode lands (else it freezes mid-seek).
      markPending()
      if (!pooled.ready) return null
      if (Math.abs(pooled.el.currentTime - srcT) > 1 / (2 * fps)) pooled.el.currentTime = srcT
      return pooled.el
    }

    const pooled = warmVideo(asset)
    if (!pooled.ready) {
      markPending() // element still warming up, keep polling
      return null
    }
    const el = pooled.el
    // Match the element's rate to the clip's speed so a slowed/sped clip's
    // picture advances exactly as fast as the compositor samples it. Otherwise
    // the source drifts and the tolerance re-seek below fires every few frames,
    // which is the stutter on slow-motion. Native <video> can't play backward,
    // so a reversed clip keeps rate 1 and rides the seek path. Browsers clamp
    // playbackRate to about [0.0625, 16].
    // The element has to advance as fast as the COMPOSITOR samples it, which is
    // the clip's own speed TIMES the transport rate. Leaving the transport out
    // is what made J/L a slideshow: at 2x the playhead ran twice as fast as the
    // picture, drift crossed the tolerance every ~150ms, and every crossing was a
    // hard seek. Native <video> can't play backward, so a reversed clip (or a
    // reversed shuttle) keeps rate 1 and rides the seek path.
    const speed = layer.speed * Math.abs(transportRate)
    const wantRate = layer.speed > 0 && transportRate > 0 ? Math.min(16, Math.max(0.0625, speed)) : 1

    // A CUT is a re-anchor, not drift. When this element was last serving a
    // different clip the picture it holds belongs to somewhere else entirely,
    // and steering toward the new time is meaningless: it has to jump.
    const cut = pooled.servingClipId !== null && pooled.servingClipId !== layer.clipId
    pooled.servingClipId = layer.clipId

    // WHAT IS ACTUALLY ON SCREEN. `el.currentTime` is the element's playback
    // position; the frame the compositor sampled can be well behind it and
    // nothing here controls by how much. The probe reports the real presentation
    // timestamp. Where rVFC is unavailable (Firefox) this falls back to the old
    // number and the whole path behaves exactly as it did before.
    const fresh = pooled.probe.live && performance.now() - pooled.probe.at < PROBE_STALE_MS
    const shownS = fresh ? pooled.probe.mediaTime : el.currentTime
    const trueErr = shownS - srcT // > 0 = picture ahead of the playhead

    if (el.paused) {
      el.currentTime = srcT
      el.playbackRate = wantRate
      void el.play().catch(() => {})
    } else if (cut || Math.abs(trueErr) > HARD_SEEK_S) {
      // A real jump. Seeking is correct, but a <video> seek takes long enough
      // that on a run of short pieces the next cut lands before this one has
      // finished: that is how the picture ended up seconds behind the playhead
      // and never recovered. So we ask for the seek AND stop waiting for it.
      el.currentTime = srcT
      el.playbackRate = wantRate
    } else {
      // Small drift: STEER instead of seeking, on the TRUE error now. The servo
      // used to correct against the element's own clock, so it was steering by a
      // number that was not the picture; converging on that is why the drift felt
      // random rather than settling.
      const corr = Math.max(1 - RATE_TRIM, Math.min(1 + RATE_TRIM, 1 - trueErr / SERVO_TAU_S))
      const rate = wantRate * corr
      if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate
    }

    // THE LADDER. The element is the cheap path and stays the default whenever
    // the frame it is really showing is the frame we asked for. When it is not
    // (mid-seek after a cut, or fallen behind), the exact decoded frame is
    // served instead, the same frames the export uses and the same ones the
    // transition path has always been served. Last resort is the element anyway:
    // never null, never a black frame.
    const tol = ELEMENT_TOL_FRAMES / (asset.fps && asset.fps > 0 ? asset.fps : fps)
    if (Math.abs(trueErr) <= tol) {
      recordServedFrame(trueErr, true)
      return livePreviewSource(el, asset.id, layer.transform.scale)
    }
    const exact = getFrameAt(asset, srcT)
    if (exact) {
      recordServedFrame(0, true)
      return exact as TexImageSource
    }
    recordServedFrame(trueErr, false)
    markPending() // the decode is queued; keep polling so it lands
    return livePreviewSource(el, asset.id, layer.transform.scale)
  }
}

// --- Live-playback texture sizing -------------------------------------------
//
// The PLAYING path handed the pooled <video> straight to the renderer, so every
// frame uploaded a texture at the SOURCE's native size and rebuilt its whole mip
// chain from it. On 4K gameplay that is a 3840×2160 upload per layer per frame
// (33 MB of pixels and twelve mip levels, sixty times a second), and the
// Preview-Quality picker did not touch that path at all: only the PAUSED path
// ever decoded at preview resolution. That asymmetry is why quality tiers helped
// scrubbing and did nothing for playback.
//
// Drawing the element down to the cap the frame cache ALREADY uses costs one GPU
// blit and makes the upload and the mip chain preview-sized. Sources at or under
// the cap (anything 1080p or smaller at Full) take the untouched path.

/** Scratch canvases, one per asset, reused across frames. */
const liveScale = new Map<Id, OffscreenCanvas>()
/** Two or three video layers can be live at once; more than this is a leak. */
const LIVE_SCALE_CAP = 4

/**
 * How tall the live upload actually needs to be.
 *
 * PROFILED, 2026-07-29: during playback `texSubImage2D` is 37% of every sample
 * taken, and our own JavaScript is 1.3%. The preview is not slow because of
 * resolve, keyframes or effects; it is slow because it hands the renderer a
 * full-size video frame to upload, sixty times a second.
 *
 * The quality tier alone could not fix that. At Full quality a 1080p source sits
 * exactly ON the 1080 cap, so nothing was scaled, and the frame was uploaded at
 * 1920x1080 to be drawn into a program monitor about 700 pixels tall: over twice
 * the pixels that can possibly be shown. The monitor's own raster is the honest
 * ceiling, so it is now part of the cap.
 *
 * `LIVE_UPLOAD_HEADROOM` keeps a margin above it, because a clip can be scaled UP
 * by its own transform and sampling a texture cut exactly to the monitor would
 * soften a punch-in.
 */
/**
 * Pure policy, so the rules can be tested without a GL context: never upscale,
 * never exceed the quality tier, and never upload more than the monitor can
 * actually show at this layer's zoom. `rasterH` of 0 means nothing has drawn
 * yet, so the tier alone decides.
 *
 * The zoom is the LAYER's own scale, not a guess. A first attempt used a fixed
 * 1.25 margin "for punch-ins" and it was worse on both counts, measured: it made
 * the picture pass through TWO resamples (1080 to 868 to 694) instead of one, so
 * edge energy fell to 0.877 where a straight 1080 to 694 gives 1.081 - sharper
 * than the uncapped original's 0.905 - and it was slower as well. Reading the
 * real scale costs nothing and is exact: a clip at 1x uploads exactly what the
 * monitor shows, and a 2x punch-in uploads twice that because it needs it.
 */
export function liveUploadCap(
  nativeH: number,
  tierCapH: number | undefined,
  rasterH: number,
  zoom = 1,
): number | undefined {
  if (!nativeH || nativeH <= 0) return undefined
  const tier = tierCapH ?? nativeH
  const display = rasterH > 0 ? rasterH * Math.max(1, zoom || 1) : nativeH
  const cap = Math.max(2, Math.round(Math.min(tier, display)))
  return cap < nativeH ? cap : undefined
}

const liveUploadCapHeight = (nativeH: number, zoom: number): number | undefined =>
  liveUploadCap(nativeH, previewCapHeight(nativeH), previewRasterH, zoom)

function livePreviewSource(el: HTMLVideoElement, assetId: Id, zoom = 1): TexImageSource {
  const nativeH = el.videoHeight
  const nativeW = el.videoWidth
  if (!nativeH || !nativeW || typeof OffscreenCanvas === 'undefined') return el
  const capH = liveUploadCapHeight(nativeH, zoom)
  if (!capH || capH >= nativeH) return el

  const w = Math.max(2, Math.round((nativeW / nativeH) * capH))
  let canvas = liveScale.get(assetId)
  // Touch on a HIT as well: eviction takes the oldest INSERTED, so without this
  // the map stays in creation order and past the cap it evicts the canvas it is
  // about to need again, reallocating every canvas every frame.
  if (canvas) {
    liveScale.delete(assetId)
    liveScale.set(assetId, canvas)
  }
  if (!canvas || canvas.width !== w || canvas.height !== capH) {
    canvas = new OffscreenCanvas(w, capH)
    liveScale.delete(assetId)
    liveScale.set(assetId, canvas)
    while (liveScale.size > LIVE_SCALE_CAP) {
      const oldest = liveScale.keys().next().value
      if (oldest === undefined) break
      liveScale.delete(oldest)
    }
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return el
  ctx.drawImage(el, 0, 0, w, capH)
  return canvas
}

/**
 * Render the sequence at time `tS` into `canvas` (already sized to the target
 * raster). Falls back to a cleared canvas when WebGL2 is unavailable.
 *
 * Returns `true` when every referenced layer resolved to a texture this frame,
 * `false` when something was still decoding/loading (a null texture source). The
 * Monitor's draw loop uses this to keep polling a paused frame until its exact
 * decode lands, then stop instead of redrawing on every rAF forever.
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
  // Health describes ONE continuous run of playback. Starting or stopping makes
  // every sample before it describe a different run, so the window starts over.
  if (playing !== wasPlaying) {
    wasPlaying = playing
    resetPreviewHealth()
  }
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
  // path: their "from" is the clip's own continuously-playing layer.
  let transitionFrom: Set<RenderLayer> | undefined
  if (playing) {
    prerollTransitions(seq, assets, tS)
    prerollCuts(seq, assets, tS)
    for (const op of frame.ops) {
      if (op.type === 'transition' && op.from.clipId !== op.to.clipId) {
        (transitionFrom ??= new Set()).add(op.from)
      }
    }
  }
  // A frame is "complete" only when every layer resolved to its FINAL texture
  // (the exact decoded frame / loaded image), not a still-seeking <video>
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
