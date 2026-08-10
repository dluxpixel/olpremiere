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
  hasFrameIdentity,
  recordServedFrame,
  resetPreviewHealth,
  resetPreviewPacing,
  type FrameProbe,
} from './previewTruth'
import { setProxyBuildingPaused } from './proxyMedia'
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
  /** performance.now() of the last hard seek asked of this element. See the seek branch. */
  lastSeekAt?: number
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
/**
 * Shortest interval between two hard seeks of the SAME element. A seek that has
 * landed still needs a frame decoded and composited before the probe can report
 * it, and re-seeking inside that window throws away the work. 120 ms is about
 * four frames at 30: long enough for a 4K seek to present something, short
 * enough that a genuine run of cuts still re-anchors on the next one.
 */
const SEEK_COOLDOWN_MS = 120
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

/**
 * Consecutive frames, per asset, where the exact-frame fallback was asked for a
 * frame and the cache did not have it. Past LIVE_MISS_LIMIT the fallback is
 * switched off for that asset until the picture is back inside tolerance: see
 * the long note at the call site.
 */
const liveMisses = new Map<Id, number>()
/**
 * Eight frames is an eighth of a second at 60. Long enough that a cut, whose
 * head is already pre-rolled, never trips it; short enough that a decoder which
 * cannot keep up stops being asked before the picture drifts anywhere visible.
 */
const LIVE_MISS_LIMIT = 8

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
  const pooled: PooledVideo = { el, ready: false, probe: attachFrameProbe(el) }
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
      // minification kills the aliasing/shimmer. Preview asks for it ALWAYS;
      // the export renderer asks for it at HD and up only (exportWorker.ts
      // passes mipmapSources: isHdRaster). That raster fence, not a flagless
      // export renderer, is what keeps the golden 640x360 export on the
      // untouched LINEAR path.
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
  /** The two clips, so their last good frames can be held. Per CLIP, not per asset. */
  fromClipId: Id
  toClipId: Id
  /** Outgoing clip's source time at startS/endS (start > end when reversed). */
  fromSourceStartS: number
  fromSourceEndS: number
  /** Incoming clip's source time at startS. */
  toSourceStartS: number
  /** Incoming clip's source time at endS (start > end when reversed). */
  toSourceEndS: number
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
  const rateB = Math.abs(b.speed || 1)
  const srcB = (t: number): number => (b.speed < 0 ? b.outS - (t - b.startS) * rateB : b.inS + (t - b.startS) * rateB)
  return {
    startS: b.startS,
    endS: b.startS + d,
    fromAssetId: a.assetId,
    toAssetId: b.assetId,
    fromClipId: a.id,
    toClipId: b.id,
    fromSourceStartS: srcA(b.startS),
    fromSourceEndS: srcA(b.startS + d),
    toSourceStartS: srcB(b.startS),
    toSourceEndS: srcB(b.startS + d),
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
function prerollTransitions(
  windows: readonly PairTransitionWindow[],
  assets: Record<Id, MediaAsset>,
  tS: number,
): void {
  for (const w of windows) {
    const from = assets[w.fromAssetId]
    if (from?.kind === 'video') prefetchRange(from, w.fromSourceStartS, w.fromSourceEndS)
    const to = assets[w.toAssetId]
    if (to?.kind === 'video') {
      // The incoming side gets its window decoded ahead too, not just a warm
      // element. A pre-seek is a REQUEST: it can still be in flight when the
      // window opens, and the guard then leaves the side untextured, so the
      // dissolve would start on one clip. Cached frames are the thing that
      // makes the window correct from its first frame rather than its third.
      //
      // NOT WHEN BOTH SIDES ARE ONE ASSET, and that is the razored take again.
      // An asset has ONE decode queue, bounded and ordered by nearness to the
      // latest request (frameCache request/boundPending). Two windows eight
      // seconds apart asked for on every rAF would each re-anchor that queue and
      // evict the other's frames, finishing neither: the same thrash the cut
      // pre-roll below is bounded to avoid. The OUTGOING side wins the tie,
      // because it is the one that cannot fall back to the element (the
      // incoming side owns it), so the cache is its only route to a picture.
      if (w.toAssetId !== w.fromAssetId) prefetchRange(to, w.toSourceStartS, w.toSourceEndS)
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
/**
 * MAY THIS ELEMENT'S CURRENT PICTURE STAND IN FOR THE FRAME `srcT` ASKS FOR?
 * Only on POSITIVE EVIDENCE, and only for a layer that is one side of a live
 * pair transition. This is the whole of the cross dissolve bug he reported on
 * 2026-08-10, so the reasoning is worth keeping.
 *
 * `el.currentTime` is the position the element has been ASKED to play from, not
 * the frame it is showing. The seek branch below assigns it `srcT` a few lines
 * before the error is computed from it, so a COLD element reports a perfect
 * error of zero for a picture that is still the head of the file. Absence of
 * evidence was reading as tolerance, and the ladder then handed the compositor
 * frame 0.
 *
 * At a plain cut that costs a frame or two of stale picture and nobody sees it,
 * which is the trade the ladder's last rung was built for and still keeps. In a
 * DISSOLVE the same wrong picture is held at rising opacity for the whole
 * window, so it does not read as a blip, it reads as a flash of footage the
 * editor already trimmed away. On a razored source it is worse again: both
 * sides are one asset, so they share ONE pooled element, and the side that does
 * not own it is handed whatever the other side parked it on.
 *
 * An untextured side is transparent, which is a shorter dissolve. Deleted
 * footage at 60% opacity is a defect. The first is worth the second.
 *
 * Where the engine reports no frame identity at all (Firefox has no
 * requestVideoFrameCallback) there is no evidence to be had, so the old
 * behaviour stands byte for byte rather than blanking every transition.
 */
function elementShowsNear(pooled: PooledVideo, srcT: number): boolean {
  if (!hasFrameIdentity()) return true
  if (!pooled.probe.live) return false
  // A probe that has stopped reporting is not stale for THIS question: the last
  // frame it presented is still the frame on screen. It is the right number to
  // judge, however old it is.
  return Math.abs(pooled.probe.mediaTime - srcT) <= HARD_SEEK_S
}

function makeTextureSource(
  assets: Record<Id, MediaAsset>,
  fps: number,
  playing: boolean,
  frameW: number,
  frameH: number,
  markPending: () => void,
  transitionFrom?: ReadonlySet<RenderLayer>,
  transitionSides?: ReadonlySet<RenderLayer>,
  holdClips?: ReadonlySet<Id>,
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
    // One side of a live pair transition. Its picture is composited against the
    // other clip for the whole window, so it may only ever be the RIGHT frame.
    const guarded = transitionSides?.has(layer) === true
    // Near enough a transition that this clip's last good frame is worth
    // keeping. Covers the pre-roll as well as the window itself, which is what
    // gives the OUTGOING side something to hold the moment the window opens.
    const holding = holdClips?.has(layer.clipId) === true
    /** A picture the ladder is confident is this clip's own frame. */
    const confident = (src: TexImageSource): TexImageSource => {
      if (holding) holdGoodFrame(layer.clipId, src)
      return src
    }
    /** No provable picture: the last one there was, never a wrong one. */
    const held = (): TexImageSource | null => heldFrames.get(layer.clipId) ?? null

    if (playing && transitionFrom?.has(layer)) {
      // Outgoing side of a live pair transition, sampled past its cut. The
      // incoming side owns the pooled element (the SAME element when both clips
      // come from one asset, and seeking it from here too would fight it twice
      // per rAF, the transition stutter). Serve the pre-rolled exact frame; on a
      // miss show the element AS-IS (never seek it) until the decode lands.
      // getFrameAt already queued it. Sampling past the media end freeze-frames
      // on the last real frame, which an element cannot do.
      const exact = getFrameAt(asset, srcT)
      if (exact) return confident(exact as TexImageSource)
      markPending()
      const pooled = videoPool.get(asset.id)
      if (!pooled?.ready) return held()
      // MEASURED 2026-08-10: this rung served the outgoing side a picture 0.8 s
      // from the frame asked for, four times inside one 1 s dissolve, and
      // nothing here looked. On a razored source that element belongs to the
      // INCOMING side, so "as-is" means the wrong part of the same take.
      return elementShowsNear(pooled, srcT) ? confident(pooled.el) : held()
    }
    if (!playing) {
      const pooled = warmVideo(asset)
      if (!pooled.el.paused) pooled.el.pause()
      const exact = getFrameAt(asset, srcT)
      prefetchAround(asset, srcT)
      // The cache only ever yields OffscreenCanvas/ImageBitmap (valid texture
      // sources), but its return type is the wider CanvasImageSource.
      if (exact) return confident(exact as TexImageSource)
      // No exact frame yet. Fall back to a nearest <video> seek, but the seek
      // is ASYNC, so this frame is NOT final: mark it pending so the draw loop
      // keeps polling until the exact decode lands (else it freezes mid-seek).
      markPending()
      if (!pooled.ready) return guarded ? held() : null
      // Ask for the seek either way: parking the element on the wanted frame is
      // how the NEXT draw gets it right. Only the handing over is guarded.
      if (Math.abs(pooled.el.currentTime - srcT) > 1 / (2 * fps)) pooled.el.currentTime = srcT
      // Scrubbing across a dissolve is the same defect standing still: the seek
      // has not landed, so the element is showing some other part of the take.
      if (guarded && !elementShowsNear(pooled, srcT)) return held()
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

    // NO SPECIAL CASE FOR A CLIP CHANGE, and the reason is worth keeping.
    //
    // A version of this file forced a seek whenever the element started serving
    // a different clip, on the theory that a cut is a re-anchor. He felt it as
    // stutter within minutes. Razoring ONE clip into pieces leaves those pieces
    // CONTIGUOUS in the source: the clip changes at every boundary while the
    // source time runs straight on, and the element was already showing exactly
    // the right picture. Seeking there interrupted a correct picture once per
    // cut, on precisely the cut-dense timelines this code exists to help.
    //
    // The error test below already covers the case the special case was for: a
    // cut to a DIFFERENT part of the source moves srcT by seconds, which is far
    // past the threshold, so it seeks on the very first frame regardless. The
    // clip change told us nothing the error did not.

    // WHAT IS ACTUALLY ON SCREEN. `el.currentTime` is the element's playback
    // position; the frame the compositor sampled can be well behind it and
    // nothing here controls by how much. The probe reports the real presentation
    // timestamp. Where rVFC is unavailable (Firefox) this falls back to the old
    // number and the whole path behaves exactly as it did before.
    const fresh = pooled.probe.live && performance.now() - pooled.probe.at < PROBE_STALE_MS
    const shownS = fresh ? pooled.probe.mediaTime : el.currentTime
    const trueErr = shownS - srcT // > 0 = picture ahead of the playhead

    const tol = ELEMENT_TOL_FRAMES / (asset.fps && asset.fps > 0 ? asset.fps : fps)

    if (el.paused) {
      el.currentTime = srcT
      el.playbackRate = wantRate
      void el.play().catch(() => {})
    } else if (Math.abs(trueErr) > HARD_SEEK_S) {
      // A real jump. Seeking is correct, but a <video> seek takes long enough
      // that on a run of short pieces the next cut lands before this one has
      // finished: that is how the picture ended up seconds behind the playhead
      // and never recovered. So we ask for the seek AND stop waiting for it.
      //
      // ONE SEEK AT A TIME, and the reason is measured. This branch runs on
      // EVERY rAF while the error is large, so it used to fire a fresh seek
      // sixty times a second. A 4K seek does not complete in 16 ms, so each one
      // cancelled the last, the decoder never presented a frame, the probe
      // never went fresh, the error never came down, and it seeked again: 4K60
      // sat 1.7 SECONDS behind the playhead for as long as it played. Asking
      // once and letting it finish is the whole fix. `el.seeking` covers the
      // seek itself; the cooldown covers a seek that lands but whose first
      // frame has not been composited yet.
      const now = performance.now()
      if (!el.seeking && now - (pooled.lastSeekAt ?? 0) > SEEK_COOLDOWN_MS) {
        pooled.lastSeekAt = now
        el.currentTime = srcT
      }
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
    // THE GUARD SITS ABOVE THE WHOLE LADDER, NOT JUST ITS LAST RUNG. `trueErr`
    // is computed from `shownS`, which falls back to `el.currentTime` whenever
    // the probe has never reported, and the seek branch just above assigned
    // `el.currentTime = srcT`. So a cold element inside a transition reaches the
    // "in tolerance" rung with an error of zero and a picture of frame 0. The
    // side is left untextured until the element can prove otherwise.
    if (guarded && !elementShowsNear(pooled, srcT)) {
      const exact = getFrameAt(asset, srcT)
      if (exact) {
        recordServedFrame(0, true)
        return confident(exact as TexImageSource)
      }
      // Only NOW is the frame unfinished. Marking it before asking the cache
      // made every exact hit inside a dissolve schedule a redundant redraw.
      markPending()
      return held()
    }

    if (Math.abs(trueErr) <= tol) {
      liveMisses.delete(asset.id)
      recordServedFrame(trueErr, true)
      return confident(livePreviewSource(el, asset.id, layer.transform.scale))
    }
    // NEVER ASK THE DECODER FOR WHAT IT CANNOT DELIVER IN TIME.
    //
    // MEASURED on real hardware, 2026-08-06, 4K60 on one long clip: 76% of
    // frames were the WRONG frame and the picture ran up to 1.8 SECONDS behind
    // the playhead, with the main thread 93% IDLE. The cost was never our
    // JavaScript, it was a feedback loop:
    //
    //   element falls behind -> every rAF misses the cache and queues a decode
    //   -> the decoder (sequential, one 4K frame at a time) can serve maybe 20
    //   a second against 60 asked for -> the wanted index runs away from the
    //   iterator -> past SEQ_REOPEN_GAP it REOPENS the file and seeks -> which
    //   costs more than the frames it was behind -> further behind.
    //
    // Each turn of that loop makes the next one worse, so it never recovers.
    // The fix is to stop pulling: after a short run of misses the fallback is
    // switched off for this asset and the element free-runs on its own, which
    // is the one thing a browser is genuinely good at. It switches back on the
    // moment the picture is inside tolerance again (above), and on play/pause.
    const misses = liveMisses.get(asset.id) ?? 0
    if (misses < LIVE_MISS_LIMIT) {
      const exact = getFrameAt(asset, srcT)
      if (exact) {
        liveMisses.delete(asset.id)
        recordServedFrame(0, true)
        return confident(exact as TexImageSource)
      }
      liveMisses.set(asset.id, misses + 1)
      markPending() // the decode is queued; keep polling so it lands
    }
    recordServedFrame(trueErr, false)
    return livePreviewSource(el, asset.id, layer.transform.scale)
  }
}

// --- Live-playback texture sizing -------------------------------------------
//
// RE-TESTED on real hardware 2026-08-06 (see _verify/preview-livescale-ab.mjs).
// The July decision below was taken on a SOFTWARE renderer, where a texture
// upload is the most expensive thing in the frame, so it was worth suspecting.
// On his RTX 4060 the downscale costs 0.6% of the main thread and removing it
// costs 1.0%, and both leave the machine 82% idle: the July choice holds, for a
// different reason than it was made for. Keep it, and do not re-litigate it
// without running that A/B on a GPU.
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

// --- Held frames: what a dissolve shows when a side cannot prove its picture --
//
// The guard above refuses to composite an element that cannot show it is on the
// right frame. Returning NOTHING for that side is not good enough, and the
// measurement says so: a cross dissolve weights `from*(1-p) + to*p`, so a
// transparent side does not mean "show the other clip", it means "blend the
// other clip toward black". Measured 2026-08-10 on the razored fixture, the
// second half of a one second dissolve came back rgb(0,0,0) on every sampled
// frame. Trading a flash of deleted footage for a fade to black is not a fix.
//
// So each side of a transition holds the last picture it was served that was
// PROVABLY its own frame, and falls back to that. A freeze on the outgoing
// clip's final frame for a fraction of a second is what a freeze-frame
// transition looks like on purpose, and it is invisible next to the two things
// it replaces.
//
// KEYED PER CLIP, NOT PER ASSET, and that is the whole point on his footage.
// One take razored into pieces is ONE asset, so an asset-keyed hold would give
// the outgoing side the INCOMING side's frame: the same defect with extra
// steps.
//
// Held only for clips near a transition window (see holdClips), so an ordinary
// timeline never pays the extra blit, and only ever from a picture the ladder
// was already confident in.
const heldFrames = new Map<Id, OffscreenCanvas>()
/** Both sides of at most a couple of overlapping windows. */
const HELD_FRAME_CAP = 4

const sourceSize = (src: TexImageSource): { w: number; h: number } => {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
    return { w: src.videoWidth, h: src.videoHeight }
  }
  const s = src as { width?: number; height?: number }
  return { w: s.width ?? 0, h: s.height ?? 0 }
}

/** Copy a picture the ladder was confident in, so this clip can fall back to it. */
function holdGoodFrame(clipId: Id, src: TexImageSource): void {
  if (typeof OffscreenCanvas === 'undefined') return
  const { w, h } = sourceSize(src)
  if (!w || !h) return
  let canvas = heldFrames.get(clipId)
  if (canvas) heldFrames.delete(clipId)
  if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h)
  heldFrames.set(clipId, canvas)
  while (heldFrames.size > HELD_FRAME_CAP) {
    const oldest = heldFrames.keys().next().value
    if (oldest === undefined) break
    heldFrames.delete(oldest)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  try {
    ctx.drawImage(src as CanvasImageSource, 0, 0, w, h)
  } catch {
    // A video element that has not decoded anything yet throws rather than
    // drawing. Nothing to hold, and the next good frame will fill it.
    heldFrames.delete(clipId)
  }
}

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
    resetPreviewPacing()
    liveMisses.clear()
    // Never transcode a preview copy while he is watching the preview.
    setProxyBuildingPaused(playing)
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
  // ONE walk of the transition windows near the playhead, shared by the
  // pre-roll and by the held-frame bookkeeping below.
  const windows = transitionWindowsNear(seq, tS)
  // Which clips should keep their last good frame. Taken from the windows NEAR
  // the playhead, not from the ops AT it, so the outgoing clip is already
  // holding frames when the window opens: at the window's first frame it is too
  // late to start remembering. Empty on a timeline with no transitions, which
  // is what keeps the extra blit off the ordinary path.
  let holdClips: Set<Id> | undefined
  for (const w of windows) {
    ;(holdClips ??= new Set()).add(w.fromClipId)
    holdClips.add(w.toClipId)
  }

  // The from-layers served from the frame cache this frame, and BOTH sides of
  // every live pair transition. whiteFlash and lone-edge stand-ins (from/to are
  // the same clip) are excluded from both: their "from" is a copy of the clip's
  // own continuously-playing layer, so it needs neither the cache route nor the
  // guard. `transitionSides` is built while PAUSED too, because scrubbing
  // across a dissolve composites the same two layers from the same elements.
  let transitionFrom: Set<RenderLayer> | undefined
  let transitionSides: Set<RenderLayer> | undefined
  for (const op of frame.ops) {
    if (op.type !== 'transition' || op.from.clipId === op.to.clipId) continue
    ;(transitionSides ??= new Set()).add(op.from)
    transitionSides.add(op.to)
    if (playing) (transitionFrom ??= new Set()).add(op.from)
  }
  if (playing) {
    prerollTransitions(windows, assets, tS)
    prerollCuts(seq, assets, tS)
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
    transitionSides,
    holdClips,
  )
  renderer.render(frame, source)
  return complete
}
