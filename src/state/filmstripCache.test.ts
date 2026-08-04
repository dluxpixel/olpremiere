// The filmstrip cache had two defects that together blanked thumbnails on a
// cut-heavy timeline and never recovered. Both are pinned here.
//
// Usage mirrors the hook exactly: retain when a clip mounts (before the strip
// exists), set when generation finishes, release when the clip unmounts.

import { describe, it, expect } from 'vitest'
import { createStripCache } from './filmstripCache'

/** A cache plus the list of URLs it actually revoked. */
function harness(max: number) {
  const revoked: string[] = []
  return { cache: createStripCache(max, (u) => revoked.push(u)), revoked }
}

describe('filmstrip cache', () => {
  it('NEVER revokes a strip that is still on screen, even over its cap', () => {
    // The blank-thumbnail bug. The old cache revoked by insertion order with no
    // regard for what was mounted, and a revoked blob URL leaves the <img> dead
    // with nothing to trigger a re-render, because the plan key never changed.
    const { cache, revoked } = harness(1)
    cache.retain('a')
    cache.set('a', 'url-a')
    cache.retain('b')
    cache.set('b', 'url-b')

    expect(revoked).toEqual([])
    expect(cache.get('a')).toBe('url-a')
    expect(cache.get('b')).toBe('url-b')
    // Running over the cap is the deliberate trade: the ceiling becomes what is
    // actually visible, which beats a wall of dead thumbnails.
    expect(cache.size).toBe(2)
  })

  it('drains back to the cap as soon as a strip leaves the screen', () => {
    const { cache, revoked } = harness(1)
    cache.retain('a')
    cache.set('a', 'url-a')
    cache.retain('b')
    cache.set('b', 'url-b')

    cache.release('a')

    expect(revoked).toEqual(['url-a'])
    expect(cache.has('a')).toBe(false)
    expect(cache.get('b')).toBe('url-b')
    expect(cache.size).toBe(1)
  })

  it('evicts the least recently USED, not the oldest generated', () => {
    // The old Map was called an LRU but nothing re-inserted on a hit, so it was
    // a FIFO: the strip you kept looking at was evicted before one you scrolled
    // past long ago.
    const { cache, revoked } = harness(2)
    cache.retain('a')
    cache.set('a', 'url-a')
    cache.release('a')
    cache.retain('b')
    cache.set('b', 'url-b')
    cache.release('b')

    // 'a' is used again, which must make it the most recent.
    cache.retain('a')
    cache.release('a')

    cache.retain('c')
    cache.set('c', 'url-c')

    expect(revoked).toEqual(['url-b'])
    expect(cache.get('a')).toBe('url-a')
    expect(cache.get('c')).toBe('url-c')
  })

  it('refcounts, so one clip leaving does not free a strip another still shows', () => {
    // Two cuts of the same take at the same zoom share one plan key.
    const { cache, revoked } = harness(1)
    cache.retain('shared')
    cache.retain('shared')
    cache.set('shared', 'url-shared')
    cache.retain('other')
    cache.set('other', 'url-other')

    cache.release('shared')
    expect(revoked).toEqual([])
    expect(cache.isLive('shared')).toBe(true)

    cache.release('shared')
    expect(cache.isLive('shared')).toBe(false)
    expect(revoked).toEqual(['url-shared'])
  })

  it('reports liveness, which is how a queued job for a scrolled-away clip drops itself', () => {
    const { cache } = harness(10)
    expect(cache.isLive('k')).toBe(false)
    cache.retain('k')
    expect(cache.isLive('k')).toBe(true)
    cache.release('k')
    expect(cache.isLive('k')).toBe(false)
  })

  it('keeps a strip whose clip is still mounted across many unrelated strips', () => {
    // The reported shape: past 60 distinct strips the visible ones went blank.
    const { cache, revoked } = harness(60)
    cache.retain('onscreen')
    cache.set('onscreen', 'url-onscreen')

    for (let i = 0; i < 200; i++) {
      cache.retain(`k${i}`)
      cache.set(`k${i}`, `url-${i}`)
      cache.release(`k${i}`)
    }

    expect(cache.get('onscreen')).toBe('url-onscreen')
    expect(revoked).not.toContain('url-onscreen')
    expect(cache.size).toBeLessThanOrEqual(60)
  })
})
