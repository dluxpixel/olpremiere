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
    if (cached) return
    let alive = true
    void getBlobUrl(key).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [key])
  return url
}
