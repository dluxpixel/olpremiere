// Session-lifetime object-URL cache over the IndexedDB blob store. URLs are
// deliberately never revoked while the app is alive: assets are few, and a
// stable URL keeps <img>/<video> elements from re-fetching on every render.

import { useEffect, useState } from 'react'
import { getBlob } from './persistence'

const urls = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

export async function getBlobUrl(key: string): Promise<string | null> {
  const cached = urls.get(key)
  if (cached) return cached
  const pending = inflight.get(key)
  if (pending) return pending
  const p = (async () => {
    try {
      const blob = await getBlob(key)
      if (!blob) return null
      const url = URL.createObjectURL(blob)
      urls.set(key, url)
      return url
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** Sync peek for render paths (compositor draw loops must not await). */
export function getCachedBlobUrl(key: string): string | null {
  return urls.get(key) ?? null
}

// A blob that was MISSING can arrive later (collab media sync, "Locate file").
// Mounted components that already resolved null re-fetch on this signal.
const arrivalListeners = new Set<(key: string) => void>()

/** Announce that `key` now has a blob in IndexedDB (heals missing-media UI). */
export function notifyBlobArrived(key: string): void {
  for (const cb of arrivalListeners) cb(key)
}

/** React hook: resolve a blob key to a stable object URL (null while loading or missing). */
export function useBlobUrl(key: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(key ? getCachedBlobUrl(key) : null)
  useEffect(() => {
    if (!key) {
      setUrl(null)
      return
    }
    const cached = getCachedBlobUrl(key)
    setUrl(cached)
    let alive = true
    const fetch = (): void => {
      void getBlobUrl(key).then((u) => {
        if (alive && u) setUrl(u)
      })
    }
    if (!cached) fetch()
    const onArrival = (k: string): void => {
      if (k === key) fetch()
    }
    arrivalListeners.add(onArrival)
    return () => {
      alive = false
      arrivalListeners.delete(onArrival)
    }
  }, [key])
  return url
}
