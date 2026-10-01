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

const mirror = vi.hoisted(() => ({ deleted: [] as string[] }))
vi.mock('./mediaMirror', () => ({
  backfillMirror: () => Promise.resolve(0),
  mirrorAsset: () => Promise.resolve(true),
  mirrorApi: () => ({ mediaDelete: (id: string) => { mirror.deleted.push(id); return Promise.resolve() } }),
}))

import { deleteAsset, removeUnusedAssets } from './mediaActions'
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

// ⛔ DELETING A BIN ITEM MUST NOT TAKE THE SPARE COPY.
//
// The same function deliberately keeps the IndexedDB blob so Undo can bring the
// clip back, and the toast offers Undo. Deleting the disk copy meant Delete then
// Ctrl+Z handed it back on exactly ONE copy, silently, which is the shape that
// lost him eight voice recordings. Recovered rows also share asset ids, so a
// delete on one row could take the bytes another row still needs.
describe('deleting an asset leaves the disk copy alone', () => {
  it('never asks the shell to delete the mirrored file', () => {
    mirror.deleted.length = 0
    const project = newProject()
    const id = 'a1'
    project.assets[id] = { id, name: 'clip.mp4', kind: 'video', blobKey: 'asset/' + id, durationS: 1 } as never
    useStore.setState({ project })
    deleteAsset(id)
    expect(mirror.deleted).toEqual([])
  })
})

// His ask, 2026-10-01: "delete clips that are not being used... when I use a
// template for an old video and then I make new stuff in the video, of course,
// I don't need the old stuff". Only bin files no clip uses go, the timeline is
// untouched, everything is released, and ONE undo brings the whole bin back.
describe('removing the files nothing on the timeline uses', () => {
  it('removes only unused files, releases them, keeps every clip, one undo', () => {
    // The bin from beforeEach holds ASSET, which nothing uses.
    const project = structuredClone(useStore.getState().project)
    const seqId = project.activeSequenceId
    const used = 'used-asset'
    project.assets[used] = { id: used, name: 'new.mp4', kind: 'video', durationS: 5 } as never
    const clip = { id: 'c1', assetId: used, startS: 0, inS: 0, outS: 5, speed: 1, enabled: true, transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5, crop: { t: 0, r: 0, b: 0, l: 0 } }, opacity: 1, blendMode: 'normal', audioGainDb: 0, fadeInS: 0, fadeOutS: 0, effects: [] }
    const seq = project.sequences[seqId]!
    project.sequences[seqId] = { ...seq, tracks: seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip as never] } : t)) }
    useStore.setState({ project })
    expect(removeUnusedAssets()).toBe(1)
    const after = useStore.getState().project
    expect(Object.keys(after.assets)).toEqual([used])
    expect(after.sequences[seqId]!.tracks[0]!.clips.map((c) => c.id)).toEqual(['c1'])
    expect(released.frameCache).toEqual([ASSET])
    expect(released.denoise).toEqual([ASSET])
    expect(useStore.getState().undo()).toMatch(/Remove 1 unused file/)
    expect(Object.keys(useStore.getState().project.assets).sort()).toEqual([ASSET, used].sort())
  })

  it('does nothing when every file is used', () => {
    useStore.setState({ project: newProject() })
    expect(removeUnusedAssets()).toBe(0)
  })
})
