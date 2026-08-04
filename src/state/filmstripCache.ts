// The filmstrip object-URL cache, split out from filmstrips.ts so it can be
// tested at all. filmstrips.ts touches document and URL.createObjectURL, and
// vitest runs in the node environment, so the policy that actually had the bug
// was unreachable from a test while it lived in there.
//
// THE BUG THIS EXISTS TO PREVENT. The old cache was a Map called an LRU that
// was really a FIFO: nothing re-inserted on a hit, so eviction took the oldest
// GENERATED strip rather than the least recently USED one. Worse, it revoked
// that object URL unconditionally, including when the URL was still the `src`
// of a mounted <img>. The browser drops a revoked blob immediately, so the
// thumbnail went blank, and nothing brought it back: the hook's effect is keyed
// on the plan key, which had not changed, so it never re-ran. Every cut of one
// take is a distinct key, so a cut-heavy timeline passed 60 keys quickly and
// then started blanking the strips the user was looking at.
//
// So: a strip that something is currently showing is NEVER revoked, and a hit
// moves the key to the most-recent end.

export interface StripCache {
  get(key: string): string | undefined
  has(key: string): boolean
  set(key: string, url: string): void
  /** Mark a key as on screen. Pairs with release, and refcounts. */
  retain(key: string): void
  release(key: string): void
  isLive(key: string): boolean
  readonly size: number
  /** Test seam: the keys in eviction order, least recent first. */
  keys(): string[]
}

export function createStripCache(max: number, revoke: (url: string) => void): StripCache {
  // Insertion order IS the recency order: the least recently used key is first.
  const cache = new Map<string, string>()
  // key to how many mounted clips are currently showing it.
  const live = new Map<string, number>()

  /** Move a key to the most-recent end. A Map re-insert is the whole trick. */
  function touch(key: string): void {
    const url = cache.get(key)
    if (url === undefined) return
    cache.delete(key)
    cache.set(key, url)
  }

  function evict(): void {
    if (cache.size <= max) return
    for (const [key, url] of [...cache]) {
      if (cache.size <= max) break
      // Never revoke what something is still showing. If every cached strip is
      // on screen at once, the cache is allowed to run over its cap instead:
      // the ceiling is then whatever is actually visible, which is bounded by
      // the timeline, and an oversized cache is much cheaper than a wall of
      // dead thumbnails.
      if (live.has(key)) continue
      cache.delete(key)
      revoke(url)
    }
  }

  return {
    get(key) {
      return cache.get(key)
    },
    has(key) {
      return cache.has(key)
    },
    set(key, url) {
      cache.set(key, url)
      evict()
    },
    retain(key) {
      live.set(key, (live.get(key) ?? 0) + 1)
      touch(key)
    },
    release(key) {
      const n = (live.get(key) ?? 0) - 1
      if (n > 0) live.set(key, n)
      else live.delete(key)
      // Releasing can make an over-cap cache evictable again.
      evict()
    },
    isLive(key) {
      return live.has(key)
    },
    get size() {
      return cache.size
    },
    keys() {
      return [...cache.keys()]
    },
  }
}
