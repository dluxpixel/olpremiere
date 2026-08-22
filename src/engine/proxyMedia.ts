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
  proxyFinish(id: string): Promise<{ size: number } | null>
  proxyRead(id: string, offset: number, length: number): Promise<ArrayBuffer>
  proxyRelease(id: string): Promise<void>
}
const desktop = (): ProxyApi | null => {
  const api = (globalThis as { api?: Partial<ProxyApi> & { isElectron?: boolean } }).api
  return api?.isElectron && typeof api.proxyBegin === 'function' ? (api as ProxyApi) : null
}

/**
 * Stream one source across and get its preview copy back, a chunk each way.
 *
 * Slices the Blob rather than reading it: `blob.slice()` is a view, so only the
 * chunk being sent is ever real bytes in the renderer. Reading a multi-gigabyte
 * capture into one ArrayBuffer first would defeat the whole arrangement.
 *
 * ⛔ AND THE COPY COMES BACK THE SAME WAY, WHICH IT DID NOT USED TO. This asked
 * for the finished proxy as ONE ArrayBuffer on the belief that a proxy is small.
 * Measured on his own capture, 2026-08-22: 1.37 GB in, **423 MB out**, so that
 * one call needed the copy alive four times over, in main's read buffer, in the
 * copy out of the pool, in the message, and here. His store has held zero
 * preview copies since July.
 *
 * ⛔ EACH CHUNK BECOMES A Blob IMMEDIATELY, exactly as `remuxIfNeeded` does, and
 * that is the whole point. Collecting the ArrayBuffers and wrapping them at the
 * end reads like chunking but keeps every byte on the JS heap; wrapping each one
 * as it lands puts the bytes in the browser's disk backed blob store and lets
 * the buffer be collected.
 */
async function transcode(api: ProxyApi, source: Blob): Promise<Blob | null> {
  const id = await api.proxyBegin()
  try {
    for (let off = 0; off < source.size; off += CHUNK_BYTES) {
      await api.proxyChunk(id, await source.slice(off, off + CHUNK_BYTES).arrayBuffer())
    }
    const done = await api.proxyFinish(id)
    if (!done || done.size <= 0) return null
    const parts: Blob[] = []
    for (let off = 0; off < done.size; off += CHUNK_BYTES) {
      parts.push(new Blob([await api.proxyRead(id, off, Math.min(CHUNK_BYTES, done.size - off))]))
    }
    return new Blob(parts, { type: 'video/mp4' })
  } finally {
    // Both temps go whether this worked or not. The source copy alone is full
    // size, and this folder has already left 427 MB of his footage behind once.
    await api.proxyRelease(id).catch(() => undefined)
  }
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
/** True once this asset has a preview copy ready to decode from. */
export const hasProxy = (assetId: Id): boolean => ready.has(assetId)

// ⛔ THERE IS NO onProxyReady SUBSCRIPTION AND THERE MUST NOT BE ONE.
// It existed here for a year with no subscriber, and its docstring promised the
// preview would "drop its stale decode state" when a copy landed. That promise
// is already kept, and better, in `frameCache.request`: it notices on the next
// frame that the entry is not on the proxy and one now exists, and reopens
// against it. Asking at request time is right after a reload and across a module
// boundary, which a subscription is not.
//
// It is written down because the dead API cost a reader fifteen minutes on
// 2026-08-16 looking for the bug it implied.

/**
 * How the preview-copy work is going, for the boot card's row.
 *
 * Honest about the three states that look identical from outside: nothing to do,
 * still working, and finished. Without this the first minutes after a big import
 * are quietly slower for a reason nothing on screen explains.
 */
export function proxyProgress(): { queued: number; done: number; working: boolean } {
  return { queued: queue.length, done: ready.size, working: running }
}

/** Resolves when the queue has drained. Never rejects; a failed copy is not fatal. */
export function whenProxiesSettled(): Promise<void> {
  if (!running && queue.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!running && queue.length === 0) resolve()
      else setTimeout(tick, 400)
    }
    tick()
  })
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
/**
 * Set by the parked drain loop, called by the stop. Only one drain runs at a
 * time (guarded by `running`), so one slot is all there can ever be.
 */
let wakeOnStop: (() => void) | null = null

export function setProxyBuildingPaused(isPlaying: boolean): void {
  playing = isPlaying
  if (isPlaying) return
  // ⛔ THE OLD RESUME COULD NEVER FIRE, and its docblock above promised it did.
  // It asked for `!running`, but a parked drain holds `running` true for its
  // whole loop, the sleep included, so the stop event was received and thrown
  // away every time. The only thing that ever restarted the work was the timer,
  // which is why a preview copy could sit idle for a second and a half after he
  // stopped playing. Waking the loop directly is what the comment always claimed.
  const wake = wakeOnStop
  wakeOnStop = null
  if (wake) wake()
  else if (!running && queue.length > 0) void drain()
}

/** How long to wait before re-checking whether playback has stopped. */
const PLAYBACK_RECHECK_MS = 1500

/**
 * Build this asset's preview copy NEXT, ahead of everything else waiting.
 *
 * ⛔ THE ORDER OF THE QUEUE IS THE ORDER HE IMPORTED IN, which has nothing to do
 * with what he is looking at. Import forty recordings and start editing the
 * fifteenth, and its copy is thirty-nine transcodes away: he edits the one clip
 * that is still slow while the app carefully speeds up thirty-nine he is not
 * touching. The frame cache calls this whenever it is asked for a frame of an
 * asset that has no copy yet, so "what he is looking at" needs no new plumbing.
 *
 * Cheap and idempotent: an asset not in the queue (already built, already
 * building, never wanted one) is left exactly as it is.
 */
export function bumpProxyPriority(assetId: Id): void {
  if (queue.length < 2) return
  const at = queue.findIndex((a) => a.id === assetId)
  if (at <= 0) return
  queue.unshift(queue.splice(at, 1)[0])
}

async function drain(): Promise<void> {
  running = true
  try {
    while (queue.length > 0) {
      if (playing) {
        // Hand the machine back to the preview and look again on the stop, or
        // shortly, whichever comes first.
        await new Promise<void>((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            wakeOnStop = null
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(finish, PLAYBACK_RECHECK_MS)
          wakeOnStop = finish
        })
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
        if (!out || out.size === 0) continue
        await putBlob(proxyKeyFor(asset.id), out)
        markReady(asset.id)
      } catch (err) {
        // Never fatal. No proxy just means the preview reads the original, which
        // is what it did before this file existed.
        //
        // But DO let it be tried again. `seen` is claimed before the transcode
        // starts, so leaving a failed asset in it meant one ffmpeg hiccup
        // disabled that clip's fast preview for the rest of the session with no
        // way back short of restarting. Releasing the claim costs nothing: the
        // next ensureProxies re-queues it, and a proxy that already exists is
        // found in storage and skipped anyway.
        seen.delete(asset.id)
        console.warn(`OL Premiere: no preview copy for ${asset.name}`, err)
      }
    }
  } finally {
    running = false
  }
}

function markReady(assetId: Id): void {
  ready.add(assetId)
}

/** Drop a removed asset's proxy state (pair with evictAsset). */
export function forgetProxy(assetId: Id): void {
  ready.delete(assetId)
  seen.delete(assetId)
}

