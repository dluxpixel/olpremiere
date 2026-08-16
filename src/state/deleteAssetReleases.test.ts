// Deleting an asset has to release EVERY resource keyed by that asset, and the
// list had a hole in it.
//
// ⛔ `invalidateDenoise` existed for exactly this moment and nothing had ever
// called it. Found 2026-08-16 by sweeping the tree for exports with no caller,
// which is a different question from "is this code unused": it was not unused
// code, it was uncalled cleanup, and the two look identical from a distance.
//
// The size of the hole is why this test exists rather than a comment. The two
// denoise caches hold FULL decoded channel data as Float32, so one ten minute
// stereo clip is roughly 230 MB that survived the delete which released the
// decoder, the pooled preview element and the proxy.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { newProject } from '../engine/types'

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const released = vi.hoisted(() => ({ frameCache: [] as string[], preview: [] as string[], proxy: [] as string[], denoise: [] as string[], audio: [] as string[] }))

vi.mock('../engine/audio', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  forgetAssetAudio: (id: string) => released.audio.push(id),
}))

vi.mock('../engine/frameCache', () => ({ evictAsset: (id: string) => released.frameCache.push(id) }))
vi.mock('../engine/preview', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  disposePreviewAsset: (id: string) => released.preview.push(id),
}))
vi.mock('../engine/proxyMedia', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  forgetProxy: (id: string) => released.proxy.push(id),
}))
vi.mock('../engine/denoise', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invalidateDenoise: (id: string) => released.denoise.push(id),
}))

import { deleteAsset } from './mediaActions'
import { useStore } from './store'

const ASSET = 'asset-under-test'

beforeEach(() => {
  for (const key of Object.keys(released) as (keyof typeof released)[]) released[key].length = 0
  const project = newProject()
  useStore.setState({
    project: {
      ...project,
      assets: {
        ...project.assets,
        [ASSET]: {
          id: ASSET,
          name: 'big.mp4',
          kind: 'video',
          durationS: 600,
          width: 1920,
          height: 1080,
        },
      },
    },
  } as never)
})

describe('deleteAsset', () => {
  it('releases every resource keyed by the asset, denoise included', () => {
    deleteAsset(ASSET)
    expect(released.frameCache, 'the decoder').toContain(ASSET)
    expect(released.preview, 'the pooled preview element').toContain(ASSET)
    expect(released.proxy, 'the preview proxy').toContain(ASSET)
    // ⛔ THE ONE THAT WAS MISSING. Take the call back out of mediaActions and
    // this is the only assertion that fails, which is the whole point of it.
    expect(released.denoise, 'the denoised audio, the biggest of the four').toContain(ASSET)
    // The decoded audio, forward and reversed. Bounded by its own budget, so
    // this one is about not holding a share of it for media that is gone.
    expect(released.audio, 'the decoded audio').toContain(ASSET)
  })

  it('does nothing at all for an asset that is not there', () => {
    deleteAsset('no-such-asset')
    expect(released.denoise).toEqual([])
    expect(released.frameCache).toEqual([])
  })
})
