// Filmstrip generation + cache: capture N small frames from a video asset
// into one horizontal strip and hand back an object URL. Strips generate
// lazily off a single queue (one <video> seek chain at a time, since seeks are
// serialized per element anyway), land in an LRU, and notify the hook when
// ready. Until then the clip shows its poster frame exactly as before.

import { useEffect, useState } from 'react'
import { filmstripPlan, TILE_W } from '../engine/filmstrip'
import type { MediaAsset } from '../engine/types'
import { getBlobUrl } from './blobUrls'
import { createStripCache } from './filmstripCache'

const TILE_H = 56 // matches the video lane's usable height
/**
 * ⛔ 400, WAS 60, 2026-09-28. A strip is a few tens of KB of JPEG and every miss
 * is a video load plus up to 32 seeks. At 60, zooming in and out across his
 * biggest project threw strips away and rebuilt them over and over; memory was
 * never the constraint, the rebuilds were.
 */
const MAX_STRIPS = 400

// A real LRU that refuses to revoke a strip something is still showing. See
// filmstripCache.ts for the blank-thumbnail bug this replaced.
const cache = createStripCache(MAX_STRIPS, (url) => URL.revokeObjectURL(url))
const pending = new Set<string>()
const waiters = new Map<string, Set<() => void>>()
let queue: Promise<void> = Promise.resolve()

function notify(key: string): void {
  for (const w of waiters.get(key) ?? []) w()
  waiters.delete(key)
}

/**
 * ⛔ THE JPEG ENCODE RUNS IN A WORKER, 2026-09-28. `canvas.toBlob` encoded on the
 * main thread: 536 ms of it in the first seconds after opening his biggest
 * project, measured, right when he starts to scroll and click.
 */
let encoder: Worker | null | undefined
let encodeId = 1
const encodes = new Map<number, (b: Blob | null) => void>()

function encodeOffThread(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const onMain = (): Promise<Blob | null> => new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.72))
  if (encoder === undefined) {
    try {
      encoder = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ? null : new Worker(new URL('./stripEncodeWorker.ts', import.meta.url), { type: 'module' })
      if (encoder) {
        encoder.onmessage = (e: MessageEvent<{ id: number; blob?: Blob }>) => {
          encodes.get(e.data.id)?.(e.data.blob ?? null)
          encodes.delete(e.data.id)
        }
        encoder.onerror = () => {
          encoder = null
          for (const done of encodes.values()) done(null)
          encodes.clear()
        }
      }
    } catch {
      encoder = null
    }
  }
  const worker = encoder
  if (!worker) return onMain()
  return createImageBitmap(canvas).then(
    (bitmap) =>
      new Promise<Blob | null>((res) => {
        const id = encodeId++
        encodes.set(id, res)
        worker.postMessage({ id, bitmap }, [bitmap])
      }).then((b) => b ?? onMain()),
    () => onMain(),
  )
}

/**
 * One loaded <video> per asset, kept for the next strip of the same asset: a
 * fresh element per strip meant loading his hour long recordings again for
 * every zoom step. Three is enough for a serial queue.
 */
const stripVideos = new Map<string, Promise<HTMLVideoElement>>()
const STRIP_VIDEOS = 3

function stripVideo(asset: MediaAsset, src: string): Promise<HTMLVideoElement> {
  const hit = stripVideos.get(asset.id)
  if (hit) {
    stripVideos.delete(asset.id)
    stripVideos.set(asset.id, hit)
    return hit
  }
  const made = new Promise<HTMLVideoElement>((res, rej) => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.onloadeddata = () => res(video)
    video.onerror = () => rej(new Error('video load failed'))
    video.src = src
  })
  made.catch(() => stripVideos.delete(asset.id))
  stripVideos.set(asset.id, made)
  while (stripVideos.size > STRIP_VIDEOS) {
    const [oldId, old] = stripVideos.entries().next().value as [string, Promise<HTMLVideoElement>]
    stripVideos.delete(oldId)
    void old.then((v) => {
      v.removeAttribute('src')
      v.load()
    }, () => undefined)
  }
  return made
}

async function generate(asset: MediaAsset, key: string, timesS: number[]): Promise<void> {
  // The queue is serial, so a job can wait behind many others while the clip it
  // was queued for scrolls out of view. Building it then costs a video element
  // and up to 32 seeks for a strip nobody is waiting on, which is exactly the
  // work that piles up while scrolling a cut-heavy timeline.
  if (!cache.isLive(key)) return
  const src = await getBlobUrl(asset.blobKey)
  if (!src) return
  const video = await stripVideo(asset, src)
  const canvas = document.createElement('canvas')
  canvas.width = TILE_W * timesS.length
  canvas.height = TILE_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  for (let i = 0; i < timesS.length; i++) {
    await new Promise<void>((res) => {
      video.onseeked = () => res()
      video.currentTime = Math.min(timesS[i], Math.max(0, (asset.durationS || 1) - 0.05))
    })
    // Cover-fit each tile (center crop) so tiles read as frames, not smears.
    const vw = video.videoWidth || 16
    const vh = video.videoHeight || 9
    const scale = Math.max(TILE_W / vw, TILE_H / vh)
    const dw = vw * scale
    const dh = vh * scale
    ctx.drawImage(video, i * TILE_W + (TILE_W - dw) / 2, (TILE_H - dh) / 2, dw, dh)
  }
  const blob = await encodeOffThread(canvas)
  if (!blob) return
  cache.set(key, URL.createObjectURL(blob))
}

/**
 * The strip URL for a video clip, or null while it generates (or for
 * non-video assets). Regenerates only when the zoom bucket / quantized trim
 * changes; results are cached app-wide.
 */
export function useFilmstrip(
  asset: MediaAsset | undefined,
  widthPx: number,
  inS: number,
  outS: number,
  speed: number,
): string | null {
  const plan =
    asset && asset.hasVideo && asset.kind === 'video'
      ? filmstripPlan(asset.id, widthPx, inS, outS, speed)
      : null
  const key = plan?.key ?? null
  const [, bump] = useState(0)

  useEffect(() => {
    if (!key || !plan || !asset) return
    function wake(): void {
      bump((x) => x + 1)
    }
    // Retain FIRST and release in the cleanup, so a strip on screen can never be
    // revoked underneath its own <img>. It also marks the key as still wanted,
    // which is what lets a queued job for a scrolled-away clip drop itself.
    cache.retain(key)

    if (!cache.has(key)) {
      if (!pending.has(key)) {
        pending.add(key)
        queue = queue
          .then(() => generate(asset, key, plan.timesS))
          .catch(() => {}) // a failed strip just keeps the poster
          .finally(() => {
            pending.delete(key)
            notify(key)
          })
      }
      // Wake when it lands, whether this hook queued it or another one did.
      const set = waiters.get(key) ?? new Set()
      set.add(wake)
      waiters.set(key, set)
    }

    return () => {
      waiters.get(key)?.delete(wake)
      cache.release(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return key ? (cache.get(key) ?? null) : null
}
