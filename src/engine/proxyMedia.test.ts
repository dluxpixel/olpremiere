// The proxy is what he LOOKS at, never what he SHIPS. These are the two things
// that must stay true: the policy only spends a transcode where it buys
// something, and no export path can ever resolve a preview copy.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { proxyKeyFor, wantsProxy } from './proxyMedia'
import type { MediaAsset } from './types'

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a1',
  name: 'clip.mp4',
  kind: 'video',
  blobKey: 'asset/a1',
  durationS: 12,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
  ...over,
})

describe('proxy policy', () => {
  it('proxies a tall video in the desktop shell', () => {
    expect(wantsProxy(asset(), true)).toBe(true)
  })

  it('never proxies in the browser build, which has no transcoder', () => {
    expect(wantsProxy(asset(), false)).toBe(false)
  })

  it('leaves a small source alone: it already seeks fast enough to not be worth an import wait', () => {
    expect(wantsProxy(asset({ height: 480 }), true)).toBe(false)
  })

  it('ignores audio and stills, which have no frames to seek through', () => {
    expect(wantsProxy(asset({ kind: 'audio', hasVideo: false }), true)).toBe(false)
    expect(wantsProxy(asset({ kind: 'image', hasVideo: false, height: 2160 }), true)).toBe(false)
  })

  it('keys the preview copy off the asset id, so it survives a reload with no extra state', () => {
    expect(proxyKeyFor('abc')).toBe('proxy:abc')
    expect(proxyKeyFor('abc')).not.toBe(asset().blobKey)
  })
})

describe('export never sees a preview copy', () => {
  // Read rather than run: the guarantee is about which key the export code
  // RESOLVES, and a source-level assertion cannot be satisfied by a mock that
  // happens to return the right bytes. If someone wires proxyKeyFor into an
  // export path to "make preview and export match", this fails loudly, which is
  // the point: they would match at 720p and every published video would be soft.
  const sources = ['src/engine/export/index.ts', 'src/engine/export/nativeExport.ts']

  for (const path of sources) {
    it(`${path} resolves the original blob only`, () => {
      const src = readFileSync(path, 'utf8')
      expect(src).toContain('asset.blobKey')
      expect(src).not.toContain('proxyKeyFor')
      expect(src).not.toContain('proxyMedia')
      expect(src).not.toMatch(/proxy:/)
    })
  }
})
