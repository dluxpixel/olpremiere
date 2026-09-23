// The offline copy of OL Premiere for the phone (2026-09-23). vite.config.ts
// fills in the two placeholders at build time and ships this as /sw.js on the
// web build only. See offlineCopy() there for why it exists.
//
// The rules, in order of what matters on a bus:
// 1. The PAGE is asked of the network first, so a new version arrives whenever
//    there is signal, and the kept copy answers when there is none.
// 2. Every other file is named by its content (Vite hashes them), so a kept
//    copy can never be stale: it answers first and the network is not asked.
// 3. A new build is a new list and a new cache name. The old cache is deleted
//    only once the new one is complete, so an update that dies halfway on a
//    tunnel leaves the working copy alone.

const VERSION = __OLP_VERSION__
const FILES = __OLP_FILES__
const CACHE = `olp-app-${VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // One by one, not addAll: a single file that fails must not throw away
      // the thirty that arrived. A missing one is fetched again on first use.
      await Promise.all(
        FILES.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n.startsWith('olp-app-') && n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Only the app's own files. The speech model and anything else from another
  // host keep their own caching (transformers.js keeps the model itself).
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          const fresh = await fetch(req)
          if (fresh.ok) void cache.put('/', fresh.clone())
          return fresh
        } catch {
          return (await cache.match('/')) ?? (await cache.match('/index.html')) ?? Response.error()
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const kept = await cache.match(req, { ignoreSearch: true })
      if (kept) return kept
      const fresh = await fetch(req)
      if (fresh.ok && fresh.type === 'basic') void cache.put(req, fresh.clone())
      return fresh
    })(),
  )
})
