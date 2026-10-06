import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset, Project } from '../engine/types'

// Every put back road (boot repair, the panel's repair, Find my media, a room
// sync) goes through one helper, and the helper reaches every cache that
// remembered "no media" for the asset. PB-3: the preview's element pool was the
// one nobody told, so the clip played black until a restart.
const log = vi.hoisted(() => [] as string[])
vi.mock('./blobUrls', () => ({ notifyBlobArrived: (k: string) => log.push(`arrived ${k}`) }))
vi.mock('../engine/frameCache', () => ({ evictAsset: (id: string) => log.push(`frames ${id}`) }))
vi.mock('../engine/preview', () => ({
  disposePreviewAsset: (id: string) => log.push(`elements ${id}`),
  invalidatePreview: () => log.push('redraw'),
}))

const { assetsPutBack, mediaPutBack, putBackHealed } = await import('./mediaPutBack')

const asset = (id: string, name: string): MediaAsset => ({
  id,
  name,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 1,
  hasAudio: false,
  hasVideo: true,
})
const project = (assets: MediaAsset[]): Project => ({ assets: Object.fromEntries(assets.map((a) => [a.id, a])) }) as unknown as Project

beforeEach(() => {
  log.length = 0
})

describe('mediaPutBack', () => {
  it('tells the pictures, the frame cache and the preview elements, then redraws once', () => {
    mediaPutBack([{ id: 'a', blobKey: 'asset/a' }, { id: 'b', blobKey: 'asset/b' }])
    expect(log).toEqual([
      'arrived asset/a',
      'frames a',
      'elements a',
      'arrived asset/b',
      'frames b',
      'elements b',
      'redraw',
    ])
  })
})

describe('putBackHealed', () => {
  const p = project([asset('a', 'gym.mp4'), asset('b', 'intro.mp4'), asset('c', 'outro.mp4')])

  it('finds the assets a repair named', () => {
    expect(assetsPutBack(p, ['intro.mp4']).map((a) => a.id)).toEqual(['b'])
  })

  it('reaches only the healed assets', () => {
    putBackHealed(p, ['gym.mp4'])
    expect(log.filter((l) => l.startsWith('elements'))).toEqual(['elements a'])
  })

  it('a name that matches nothing refreshes every asset rather than miss one', () => {
    putBackHealed(p, ['renamed.mp4'])
    expect(log.filter((l) => l.startsWith('elements'))).toEqual(['elements a', 'elements b', 'elements c'])
  })

  it('a repair that put nothing back does nothing', () => {
    putBackHealed(p, [])
    expect(log).toEqual([])
  })
})
