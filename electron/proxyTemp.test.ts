// His proxies folder held ONE file on 2026-08-12: a 427 MB `in-` temp dated
// 6 August, and no proxy at all. A build streamed his whole source across, then
// died before ffmpeg produced anything, and the only cleanup is a `finally` that
// a killed process never reaches. So it sat there, on a C drive at 98 percent.
//
// This deletes files, which is why it is tested against a REAL directory rather
// than mocks: the thing worth proving is what it leaves alone.

import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProxyTemp, sweepProxyDir } from './proxyTemp'

function dirWith(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'olp-proxy-'))
  for (const n of names) writeFileSync(join(dir, n), 'x')
  return dir
}

describe('isProxyTemp', () => {
  it('knows the two names a proxy build creates', () => {
    expect(isProxyTemp('in-abc-123')).toBe(true)
    expect(isProxyTemp('out-abc-123.mp4')).toBe(true)
  })

  // ⛔ THE IMPORTANT HALF. This runs at startup inside his user data folder.
  it('leaves everything else alone', () => {
    for (const n of ['manifest.json', 'cache.db', 'notes.txt', 'proxy-index', 'IN-shouty', '.keep']) {
      expect(isProxyTemp(n), n).toBe(false)
    }
  })
})

describe('sweepProxyDir', () => {
  it('clears the leftovers and reports how many', async () => {
    const dir = dirWith('in-a', 'out-a.mp4', 'in-b')
    expect(await sweepProxyDir(dir)).toBe(3)
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps files that are not proxy temps', async () => {
    const dir = dirWith('in-a', 'manifest.json', 'out-b.mp4', 'keepme')
    expect(await sweepProxyDir(dir)).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['keepme', 'manifest.json'])
  })

  it('a folder that does not exist is nothing to do, not a crash', async () => {
    await expect(sweepProxyDir(join(tmpdir(), 'olp-proxy-does-not-exist-9f3a'))).resolves.toBe(0)
  })

  it('an empty folder is fine', async () => {
    expect(await sweepProxyDir(dirWith())).toBe(0)
  })
})
