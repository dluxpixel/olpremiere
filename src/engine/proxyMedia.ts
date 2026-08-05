// Preview proxies, renderer side: decide which imported videos get one, build
// them one at a time in the background, and hand the frame cache the small copy.
//
// The rule that must never break: a proxy is what he LOOKS at, never what he
// SHIPS. Export resolves `blobKey` and nothing here touches that. If this file
// were ever wired into the export path, every video he published would come out
// at 720p, so the separation is guarded by a test as well as by comment.

import { getBlob, putBlob } from '../state/persistence'
import type { Id, MediaAsset } from './types'

/**
 * Below this height a source already decodes fast enough that a proxy would
 * only cost him an import wait. Matches PROXY_MIN_HEIGHT in electron/proxy.ts.
 */
const MIN_HEIGHT_FOR_PROXY = 540

/** IndexedDB key for an asset's preview copy. Derived, so it survives a reload without extra state. */
export const proxyKeyFor = (assetId: Id): string => `proxy:${assetId}`

/**
 * How much of the source to hand over per call. Big enough that a gigabyte does
 * not become ten thousand round trips, small enough that neither side ever
 * holds a meaningful fraction of a capture in memory.
 */
const CHUNK_BYTES = 8 * 1024 * 1024

interface ProxyApi {
  proxyBegin(): Promise<string>
  proxyChunk(id: string, bytes: ArrayBuffer): Promise<void>
  proxyFinish(id: string): Promise<ArrayBuffer | null>
  proxyCancel(id: string): Promise<void>
}
const desktop = (): ProxyApi | null => {
  const api = (globalThis as { api?: Partial<ProxyApi> & { isElectron?: boolean } }).api
  return api?.isElectron && typeof api.proxyBegin === 'function' ? (api as ProxyApi) : null
}

/**
 * Stream one source across and get its preview copy back.
 *
 * Slices the Blob rather than reading it: `blob.slice()` is a view, so only the
 * chunk being sent is ever real bytes in the renderer. Reading a multi-gigabyte
 * capture into one ArrayBuffer first would defeat the whole arrangement.
 */
async function transcode(api: ProxyApi, source: Blob): Promise<ArrayBuffer | null> {
  const id = await api.proxyBegin()
  try {
    for (let off = 0; off < source.size; off += CHUNK_BYTES) {
      await api.proxyChunk(id, await source.slice(off, off + CHUNK_BYTES).arrayBuffer())
    }
  } catch (err) {
    await api.proxyCancel(id).catch(() => undefined)
    throw err
  }
  return api.proxyFinish(id)
}

/**
 * Is a proxy worth building for this asset?
 *
 * Pure, so the policy can be read and tested without a transcoder. Only video,
 * only in the desktop shell (the browser build has no ffmpeg), and only for
 * sources tall enough that random seeks in them actually hurt.
 */
export function wantsProxy(asset: MediaAsset, hasDesktop: boolean): boolean {
  if (!hasDesktop) return false
  if (asset.kind !== 'video' || !asset.hasVideo) return false
  return (asset.height ?? 0) >= MIN_HEIGHT_FOR_PROXY
}

/** Assets whose proxy is ready, so the frame cache knows to prefer it. */
const ready = new Set<Id>()
/** Assets already queued or built, so a re-render cannot queue the same transcode twice. */
const seen = new Set<Id>()
const queue: MediaAsset[] = []
let running = false
const listeners = new Set<() => void>()

/** True once this asset has a preview copy ready to decode from. */
export const hasProxy = (assetId: Id): boolean => ready.has(assetId)

/** Notified when a proxy lands, so the preview can drop its stale decode state and use it. */
export function onProxyReady(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * Queue preview copies for any of `assets` that want one.
 *
 * Cheap to call repeatedly (on import, on project load): anything already seen
 * is skipped. Transcodes run ONE at a time on purpose. ffmpeg will happily eat
 * every core, and an import that makes the app stutter while it speeds up the
 * preview has taken with one hand what it gave with the other.
 */
export function ensureProxies(assets: readonly MediaAsset[]): void {
  const api = desktop()
  for (const a of assets) {
    if (seen.has(a.id) || !wantsProxy(a, api !== null)) continue
    seen.add(a.id)
    queue.push(a)
  }
  if (!running) void drain()
}

/**
 * True while the timeline is playing. A transcode is ffmpeg at full tilt on
 * every core it can get, and starting one while he is WATCHING the preview
 * takes the CPU the preview needs: he reported the stutter within minutes of
 * the first build that did this. Building a faster preview by making the
 * current one stutter is not a trade worth making, so the queue waits for a
 * pause. Nothing is lost: it resumes the moment he stops.
 */
let playing = false
export function setProxyBuildingPaused(isPlaying: boolean): void {
  const wasPaused = playing
  playing = isPlaying
  if (wasPaused && !isPlaying && !running && queue.length > 0) void drain()
}

/** How long to wait before re-checking whether playback has stopped. */
const PLAYBACK_RECHECK_MS = 1500

async function drain(): Promise<void> {
  running = true
  try {
    while (queue.length > 0) {
      if (playing) {
        // Hand the machine back to the preview and look again shortly.
        await new Promise((r) => setTimeout(r, PLAYBACK_RECHECK_MS))
        continue
      }
      const asset = queue.shift()
      if (!asset) break
      try {
        // A proxy from a previous session is still good: the source bytes for an
        // asset never change, so re-transcoding one would be pure waste.
        const existing = await getBlob(proxyKeyFor(asset.id))
        if (existing && existing.size > 0) {
          markReady(asset.id)
          continue
        }
        const api = desktop()
        const source = api ? await getBlob(asset.blobKey) : null
        if (!api || !source) continue
        const out = await transcode(api, source)
        if (!out || out.byteLength === 0) continue
        await putBlob(proxyKeyFor(asset.id), new Blob([out], { type: 'video/mp4' }))
        markReady(asset.id)
      } catch (err) {
        // Never fatal. No proxy just means the preview reads the original, which
        // is what it did before this file existed.
        console.warn(`OL Premiere: no preview copy for ${asset.name}`, err)
      }
    }
  } finally {
    running = false
  }
}

function markReady(assetId: Id): void {
  ready.add(assetId)
  for (const cb of listeners) cb()
}

/** Drop a removed asset's proxy state (pair with evictAsset). */
export function forgetProxy(assetId: Id): void {
  ready.delete(assetId)
  seen.delete(assetId)
}

/** Test seam: forget everything, as if the app had just started. */
export function resetProxyState(): void {
  ready.clear()
  seen.clear()
  queue.length = 0
}
