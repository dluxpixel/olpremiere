// What an edit holds while it is the one on screen, and letting go of it when it
// is not.
//
// His words, 2026-10-03, asking for edit tabs: *"make it so it has to load when I
// click each one, or maybe make only some load. I don't know, because we have to
// figure out how to make it not lag so much."* Before tabs, opening another
// project left everything the last one had warmed sitting in memory until the
// caches happened to push it out: up to twelve <video> elements with a decoder
// each, half a gigabyte of decoded frames, its decoded and denoised sound, its
// title canvases, and a queue of preview copies still waiting for ffmpeg. With
// several edits open that is several edits' worth, all paid for by the one he is
// looking at.
//
// So there are two kinds of thing here, and they are let go at different times.
//
// HEAVY, released as soon as an edit is left: decoders, decoded frames, the
// preview's <video> and <img> elements, denoised sound, the strip <video>, the
// queued preview copies, the title rasters and the renderer's textures. These
// are the gigabytes and the CPU.
//
// KEPT ONE SWITCH LONGER for the edit he just left: its decoded sound (inside
// the audio budget), the waveform peaks, the filmstrip thumbnails and the media
// URLs. They are what makes a clip come back with its picture, its waveform and
// its sound ready when he clicks straight back, which is the switch he makes
// most (copying between two edits).
//
// ⛔ AND THE HEAVY HALF RUNS AFTER THE SWITCH, NOT IN IT. Measured 2026-10-03 in
// the real app on copies of Green and mc night: unloading the left edit's video
// elements is a synchronous media load() each, about 100 ms for a full pool, and
// done inside the switch it held the woken edit off the screen for all of it. So
// a switch only stops what must stop at once (decoding ahead, waiting preview
// copies) and queues the rest into idle slices once the edit he clicked is up.
// Each slice asks again what the edit ON SCREEN uses, so a quick click straight
// back finds its media still warm instead of torn down under it.
//
// ⛔ MEDIA THE EDIT ON SCREEN USES IS NEVER RELEASED. A clip pasted from one edit
// into another brings its media record with it (clipboard.ts), and recovered
// copies of an edit share media too, so the edit he is switching TO may be using
// exactly what the one he left was. An asset counts as the same media only when
// its id AND its bytes key match.

import { forgetAssetAudio, cancelAudioWarm } from '../engine/audio'
import { invalidateDenoise } from '../engine/denoise'
import { evictAsset } from '../engine/frameCache'
import { disposePreviewAsset, releasePreviewScratch } from '../engine/preview'
import { forgetProxy } from '../engine/proxyMedia'
import { clearTitleCache } from '../engine/render/titleRaster'
import { forgetAssetPeaks } from '../engine/waveform'
import type { Id, MediaAsset, Project } from '../engine/types'
import { revokeBlobUrl } from './blobUrls'
import { forgetAssetStrips, releaseStripVideo } from './filmstrips'
import { useStore } from './store'

/** The media of one edit, as asset id to the record. */
type Media = ReadonlyMap<Id, MediaAsset>

const mediaOf = (p: Project): Media => new Map(Object.values(p.assets ?? {}).map((a) => [a.id, a]))

/** True when `a` is media `other` also has: same id and the same bytes. */
const sharedWith = (a: MediaAsset, other: Media): boolean => other.get(a.id)?.blobKey === a.blobKey

/** Byte keys an edit's media is read through, so a URL another edit still shows is never revoked. */
function keysOf(media: Media): Set<string> {
  const keys = new Set<string>()
  for (const a of media.values()) {
    keys.add(a.blobKey)
    if (a.thumbnailKey) keys.add(a.thumbnailKey)
  }
  return keys
}

/** What the edit on screen uses right now, asked when a queued release finally runs. */
const onScreen = (): Media => mediaOf(useStore.getState().project)

/** Decoders, frames, elements and denoised sound for one asset. Its proxy state went at the switch. */
function releaseHeavy(a: MediaAsset): void {
  evictAsset(a.id)
  disposePreviewAsset(a.id)
  invalidateDenoise(a.id)
  releaseStripVideo(a.id)
}

/** Decoded sound, thumbnails, waveform and URLs for one asset. */
function releaseCheap(a: MediaAsset, keepKeys: ReadonlySet<string>): void {
  // The decoded sound is kept with the thumbnails, for the same quick way back:
  // re-decoding it was the biggest single cost of waking an edit (50 to 75 ms of
  // main thread on Green, measured 2026-10-04). It cannot grow past its own
  // budget (engine/audio.ts), which evicts the least recently used first, so the
  // edit on screen always wins the room.
  forgetAssetAudio(a.id)
  forgetAssetPeaks(a.id)
  forgetAssetStrips(a.id)
  if (!keepKeys.has(a.blobKey)) revokeBlobUrl(a.blobKey)
  if (a.thumbnailKey && !keepKeys.has(a.thumbnailKey)) revokeBlobUrl(a.thumbnailKey)
}

// ---------------------------------------------------------------------------
// The idle queue

const jobs: (() => void)[] = []
let pending = false
/** Longest a slice keeps going when the browser gives no idle estimate. */
const SLICE_MS = 12

function runSlice(deadline?: IdleDeadline): void {
  pending = false
  const until = Date.now() + SLICE_MS
  // At least one job a slice, so a busy machine still gets there in the end.
  do {
    jobs.shift()?.()
  } while (
    jobs.length > 0 &&
    (deadline && !deadline.didTimeout ? deadline.timeRemaining() > 2 : Date.now() < until)
  )
  if (jobs.length > 0) schedule()
}

function schedule(): void {
  if (pending) return
  pending = true
  if (typeof requestIdleCallback === 'function') requestIdleCallback(runSlice, { timeout: 1500 })
  else setTimeout(() => runSlice(), 50)
}

function later(job: () => void): void {
  jobs.push(job)
  schedule()
}

/** Run every queued release now: for tests, and nothing else needs it. */
export function drainReleases(): void {
  while (jobs.length > 0) jobs.shift()?.()
}

// ---------------------------------------------------------------------------

/** The edit he left last: its cheap caches are still kept, for a quick way back. */
let warm: { id: Id; media: Media } | null = null

/** What one switch let go of, for the tests and the switch log. */
export interface Released {
  heavy: Id[]
  cheap: Id[]
}

/**
 * `prev` has just gone to sleep and `next` is on screen. Stop what must stop now,
 * and queue the release of everything heavy `prev` held that `next` does not
 * use, and the cheap caches of whichever edit was kept warm before it.
 */
export function releaseSleepingEdit(prev: Project, next: Project): Released {
  const out: Released = { heavy: [], cheap: [] }
  if (prev.id === next.id) return out
  const keep = mediaOf(next)
  const left = mediaOf(prev)
  // AT ONCE: nothing new starts decoding ahead for the edit he left, its preview
  // copies still waiting for ffmpeg leave the queue, and the title rasters go.
  // The titles are keyed by their content, so there is no telling one edit's from
  // another's; the edit on screen re-rasters the few it shows on its next frame.
  cancelAudioWarm()
  clearTitleCache()
  for (const a of left.values()) {
    if (sharedWith(a, keep)) continue
    forgetProxy(a.id)
    out.heavy.push(a.id)
    later(() => {
      if (!sharedWith(a, onScreen())) releaseHeavy(a)
    })
  }
  later(releasePreviewScratch)

  // The edit kept warm before this one is now two switches back.
  if (warm && warm.id !== next.id && warm.id !== prev.id) {
    for (const a of warm.media.values()) {
      if (sharedWith(a, keep) || sharedWith(a, left)) continue
      out.cheap.push(a.id)
      later(() => {
        const now = onScreen()
        if (sharedWith(a, now) || sharedWith(a, left)) return
        releaseCheap(a, new Set([...keysOf(now), ...keysOf(left)]))
      })
    }
  }
  warm = { id: prev.id, media: left }
  return out
}

/**
 * A closed tab keeps nothing, even as the warm one. Its media goes unless the
 * edit on screen uses it.
 */
export function releaseClosedEdit(closed: Project | { id: Id }, active: Project): Id[] {
  if (!warm || warm.id !== closed.id) return []
  const keep = mediaOf(active)
  const keepKeys = keysOf(keep)
  const out: Id[] = []
  for (const a of warm.media.values()) {
    if (sharedWith(a, keep)) continue
    releaseCheap(a, keepKeys)
    out.push(a.id)
  }
  warm = null
  return out
}

/** Test seam: forget which edit is warm, and anything still queued. */
export function resetWarmEditForTests(): void {
  warm = null
  jobs.length = 0
}
