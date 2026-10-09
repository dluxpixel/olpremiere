// A file that arrives from the room brings its sound back, not only its picture.

import { describe, expect, it, vi } from 'vitest'

const { forgetAssetSound, evictAsset, disposePreviewAsset, invalidatePreview } = vi.hoisted(() => ({
  forgetAssetSound: vi.fn(),
  evictAsset: vi.fn(),
  disposePreviewAsset: vi.fn(),
  invalidatePreview: vi.fn(),
}))
vi.mock('../engine/assetSound', () => ({ forgetAssetSound }))
vi.mock('../engine/frameCache', () => ({ evictAsset }))
vi.mock('../engine/preview', () => ({ disposePreviewAsset, invalidatePreview }))
vi.mock('../state/blobUrls', () => ({ notifyBlobArrived: vi.fn() }))
vi.mock('@vercel/blob/client', () => ({ upload: vi.fn() }))

describe('healArrivedBlob', () => {
  // ⛔ AU-10. The picture was re-read and the sound, read as nothing while the
  // bytes were missing, stayed silent until a restart.
  it('forgets the sound read while the bytes were missing', async () => {
    const { healArrivedBlob } = await import('./mediaSync')
    healArrivedBlob('asset/a1', 'a1')
    expect(evictAsset).toHaveBeenCalledWith('a1')
    expect(forgetAssetSound).toHaveBeenCalledWith('a1')
    // Through the one put back road, so the preview's <video> elements are told too.
    expect(disposePreviewAsset).toHaveBeenCalledWith('a1')
    expect(invalidatePreview).toHaveBeenCalled()
  })
})
