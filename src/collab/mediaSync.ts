// Room media sync (relay rooms only). The CRDT syncs the project DOCUMENT;
// this moves the media BYTES so collaborators actually see the footage:
//   - every local blob a project asset references uploads to the room's media
//     store (direct-to-Blob client upload: bypasses the 4.5MB function cap,
//     works to 512MB/file)
//   - every asset whose blob is missing locally downloads from the room
//   - anything missing on BOTH sides surfaces as "missing" for the Locate flow
// Tabs-mode rooms share IndexedDB and skip all of this.

import { upload } from '@vercel/blob/client'
import { create } from 'zustand'
import { evictAsset } from '../engine/frameCache'
import { invalidatePreview } from '../engine/preview'
import { notifyBlobArrived } from '../state/blobUrls'
import { getBlob, putBlob } from '../state/persistence'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'

const SCAN_MS = 4_000
/** Above this we don't auto-upload, but the Locate/manual path still works. */
export const MAX_SYNC_BYTES = 512 * 1024 * 1024
/** Uploads above this get a progress toast (small ones are instant). */
const PROGRESS_TOAST_BYTES = 10 * 1024 * 1024

export interface MissingMedia {
  assetId: string
  name: string
  blobKey: string
}

interface MediaSyncState {
  /** Human-readable transfers in flight, e.g. "clip.mp4 ⇡ 40%". */
  transfers: string[]
  /** Assets with no local bytes and no room copy, which need a human (Locate). */
  missing: MissingMedia[]
}

export const useMediaSync = create<MediaSyncState>(() => ({ transfers: [], missing: [] }))

const setTransfer = (id: string, label: string | null): void => {
  useMediaSync.setState((s) => {
    const rest = s.transfers.filter((t) => !t.startsWith(`${id}|`))
    return { transfers: label ? [...rest, `${id}|${label}`] : rest }
  })
}

interface ManifestEntry {
  key: string
  url: string
  size: number
}

/**
 * Auto-download ceiling by device memory: a 500MB fetch().blob() buffers the
 * whole file. Fine on a 16GB desktop, an OOM tab-kill on a 4GB phone. Larger
 * files still reach peers via Locate (a lazy File handle, no buffering).
 */
export function autoDownloadCap(deviceMemoryGb: number | undefined): number {
  if (deviceMemoryGb !== undefined && deviceMemoryGb <= 4) return 100 * 1024 * 1024
  return MAX_SYNC_BYTES
}

/** Start the sync loop for a relay room. Returns a stop function. */
export function startMediaSync(room: string): () => void {
  let stopped = false
  let scanning = false // scans self-overlap when IDB/network is slow, hence the reenter guard
  const knownLocal = new Set<string>() // keys confirmed in IndexedDB
  const inFlight = new Set<string>() // keys currently uploading/downloading
  const missStreak = new Map<string, number>() // consecutive scans a key was on neither side
  const abort = new AbortController() // leaving the room cancels every transfer
  const downloadCap = autoDownloadCap((navigator as { deviceMemory?: number }).deviceMemory)

  const scan = async (): Promise<void> => {
    if (stopped || scanning) return
    scanning = true
    try {
      const r = await fetch(`/api/room?room=${encodeURIComponent(room)}&mediaOnly=1`, { signal: abort.signal })
      if (!r.ok) return
      const media = ((await r.json()) as { media: ManifestEntry[] }).media
      const manifest = new Map(media.map((m) => [m.key, m]))
      // At the list cap the manifest may be TRUNCATED: an absent key no longer
      // means "not uploaded", so skip uploads this scan (else a 4s-cadence
      // re-upload loop) and keep downloads/missing decisions for listed keys.
      const maybeTruncated = media.length >= 500
      const project = useStore.getState().project
      const missing: MissingMedia[] = []

      for (const asset of Object.values(project.assets)) {
        if (stopped) return
        const keys = [asset.blobKey, asset.thumbnailKey].filter((k): k is string => !!k)
        for (const key of keys) {
          if (inFlight.has(key)) continue
          const isMain = key === asset.blobKey

          const local = await getBlob(key)
          if (local) knownLocal.add(key)
          else knownLocal.delete(key)

          if (local && !manifest.has(key)) {
            if (maybeTruncated) continue
            if (local.size > MAX_SYNC_BYTES) continue // honest cap; Locate covers receivers
            inFlight.add(key)
            void uploadBlob(room, key, local, isMain ? asset.name : null, abort.signal).finally(() =>
              inFlight.delete(key),
            )
          } else if (!local && manifest.has(key)) {
            missStreak.delete(key)
            const entry = manifest.get(key)!
            if (entry.size > downloadCap) {
              if (isMain) missing.push({ assetId: asset.id, name: asset.name, blobKey: key })
              continue
            }
            inFlight.add(key)
            void downloadBlob(entry, asset.id, isMain ? asset.name : null, abort.signal)
              .then(() => knownLocal.add(key), () => undefined)
              .finally(() => inFlight.delete(key))
          } else if (!local && !manifest.has(key)) {
            // Debounced: the owner may still be UPLOADING it, so only call a file
            // missing after it stayed absent across consecutive scans.
            const streak = (missStreak.get(key) ?? 0) + 1
            missStreak.set(key, streak)
            if (isMain && streak >= 2) missing.push({ assetId: asset.id, name: asset.name, blobKey: key })
          }
        }
      }
      if (!stopped) useMediaSync.setState({ missing })
    } catch {
      // transient, next scan retries
    } finally {
      scanning = false
    }
  }

  void scan()
  const timer = setInterval(() => void scan(), SCAN_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    abort.abort() // kill in-flight transfers so they can't ghost the next room
    useMediaSync.setState({ transfers: [], missing: [] })
  }
}

async function uploadBlob(
  room: string,
  key: string,
  blob: Blob,
  displayName: string | null,
  signal: AbortSignal,
): Promise<void> {
  const showProgress = displayName !== null && blob.size > PROGRESS_TOAST_BYTES
  try {
    if (showProgress) setTransfer(key, `${displayName} ⇡ 0%`)
    await upload(`olpremiere-rooms/${room}/media/${encodeURIComponent(key)}`, blob, {
      access: 'public',
      handleUploadUrl: `/api/media?room=${encodeURIComponent(room)}`,
      contentType: blob.type || 'application/octet-stream',
      abortSignal: signal,
      onUploadProgress: showProgress
        ? ({ percentage }) => setTransfer(key, `${displayName} ⇡ ${Math.round(percentage)}%`)
        : undefined,
    })
  } catch (err) {
    if (!signal.aborted) {
      console.warn('media sync: upload failed', key, err)
      if (displayName) useToasts.getState().show(`Couldn't share ${displayName} with the room`, 'danger')
    }
  } finally {
    setTransfer(key, null)
  }
}

async function downloadBlob(
  entry: ManifestEntry,
  assetId: string,
  displayName: string | null,
  signal: AbortSignal,
): Promise<void> {
  const showProgress = displayName !== null && entry.size > PROGRESS_TOAST_BYTES
  try {
    if (showProgress) setTransfer(entry.key, `${displayName} ⇣…`)
    const r = await fetch(entry.url, { signal })
    if (!r.ok) throw new Error(`fetch ${r.status}`)
    const blob = await r.blob()
    if (signal.aborted) return
    await putBlob(entry.key, blob)
    healArrivedBlob(entry.key, assetId)
    if (displayName) useToasts.getState().show(`${displayName} synced from the room`, 'success')
  } finally {
    setTransfer(entry.key, null)
  }
}

/** Make an arrived blob visible everywhere it was showing a placeholder. */
export function healArrivedBlob(key: string, assetId: string): void {
  notifyBlobArrived(key)
  evictAsset(assetId) // frameCache retries decode with the real bytes
  invalidatePreview()
}
