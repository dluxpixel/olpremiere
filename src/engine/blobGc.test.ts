import { describe, expect, it } from 'vitest'

import { blobKeysOnlyUsedBy, orphanedBlobKeys, reachableBlobKeys } from './blobGc'
import type { MediaAsset, Project } from './types'

// A minimal MediaAsset: only the fields blobGc reads (blobKey, thumbnailKey)
// carry meaning; the rest just satisfy the shape.
const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  name: `clip ${id}`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 5,
  hasAudio: true,
  hasVideo: true,
  thumbnailKey: `thumb/${id}`,
  ...over,
})

// A project whose assets are the ones passed in, keyed by id.
const project = (assets: MediaAsset[]): Project =>
  ({
    assets: Object.fromEntries(assets.map((a) => [a.id, a])),
  }) as Project

// ⛔ THE ONE THAT PROTECTS HIS FOOTAGE. Deleting a project deletes its media, and
// the automatic recovery keeps every restored project's asset ids and blobKeys
// exactly as they were. On 2026-08-22 that put six recovered projects on his
// shelf pointing at one set of bytes, so binning the junk row would have taken
// his real 44 clip edit's media with it.
describe('blobKeysOnlyUsedBy', () => {
  const withId = (id: string, assets: MediaAsset[]): Project => ({ ...project(assets), id }) as Project

  it('keeps every byte a surviving project still points at', () => {
    const junk = withId('p-junk', [asset('shared'), asset('own')])
    const his = withId('p-his', [asset('shared')])
    expect(blobKeysOnlyUsedBy(junk, [his]).sort()).toEqual(['asset/own', 'thumb/own'])
  })

  it('deletes everything when nothing else points at any of it', () => {
    const only = withId('p-only', [asset('a')])
    expect(blobKeysOnlyUsedBy(only, []).sort()).toEqual(['asset/a', 'thumb/a'])
  })

  it('keeps a thumbnail another project shares even when the video is not shared', () => {
    const going = withId('p-going', [asset('a', { thumbnailKey: 'thumb/shared' })])
    const staying = withId('p-stay', [asset('b', { thumbnailKey: 'thumb/shared' })])
    expect(blobKeysOnlyUsedBy(going, [staying])).toEqual(['asset/a'])
  })

  it('does not count the project against itself, however it is passed in', () => {
    const p = withId('p-self', [asset('a')])
    expect(blobKeysOnlyUsedBy(p, [p]).sort()).toEqual(['asset/a', 'thumb/a'])
  })

  it('survives a missing row in the list rather than throwing mid delete', () => {
    const p = withId('p', [asset('a')])
    expect(blobKeysOnlyUsedBy(p, [undefined as unknown as Project]).sort()).toEqual(['asset/a', 'thumb/a'])
  })
})

describe('reachableBlobKeys', () => {
  it('includes both the blob key and thumbnail key of every asset', () => {
    const keys = reachableBlobKeys(project([asset('a'), asset('b')]))
    expect(keys).toEqual(new Set(['asset/a', 'thumb/a', 'asset/b', 'thumb/b']))
  })

  it('contributes only the blob key for an asset with no thumbnail', () => {
    const keys = reachableBlobKeys(project([asset('a', { thumbnailKey: undefined })]))
    expect(keys).toEqual(new Set(['asset/a']))
  })

  it('is empty for a project with no assets', () => {
    expect(reachableBlobKeys(project([]))).toEqual(new Set<string>())
  })
})

describe('orphanedBlobKeys', () => {
  it('returns stored media keys not referenced by any asset', () => {
    const p = project([asset('a')])
    const stored = ['asset/a', 'thumb/a', 'asset/gone', 'thumb/gone']
    expect(orphanedBlobKeys(stored, p)).toEqual(['asset/gone', 'thumb/gone'])
  })

  it('keeps a key that a DIFFERENT asset still references reachable', () => {
    // 'asset/b' is orphaned relative to asset a, but b is present, so it stays.
    const p = project([asset('a'), asset('b')])
    const stored = ['asset/a', 'thumb/a', 'asset/b', 'thumb/b']
    expect(orphanedBlobKeys(stored, p)).toEqual([])
  })

  it('collects an orphaned thumbnail even when its asset blob is still reachable', () => {
    // Asset lost its thumbnailKey (e.g. thumbnail regenerated under a new id).
    const p = project([asset('a', { thumbnailKey: undefined })])
    const stored = ['asset/a', 'thumb/a']
    expect(orphanedBlobKeys(stored, p)).toEqual(['thumb/a'])
  })

  it('NEVER orphans a lib/ key, even when it is absent from the project', () => {
    const p = project([asset('a')])
    const stored = ['lib/x', 'lib-thumb/x', 'asset/a', 'thumb/a']
    expect(orphanedBlobKeys(stored, p)).toEqual([])
  })

  it('NEVER orphans a lib/ key even when the project is empty', () => {
    const stored = ['lib/x', 'lib-thumb/x']
    expect(orphanedBlobKeys(stored, project([]))).toEqual([])
  })

  it('NEVER orphans an unknown-prefixed key (conservative on unrecognised keys)', () => {
    const p = project([asset('a')])
    const stored = ['render-cache/1', 'proxy/2', 'lastProjectId', 'weird', 'asset/a', 'thumb/a']
    expect(orphanedBlobKeys(stored, p)).toEqual([])
  })

  it('returns [] for an empty project and empty stored list', () => {
    expect(orphanedBlobKeys([], project([]))).toEqual([])
  })

  it('collects every stored media key when the project has no assets', () => {
    const stored = ['asset/a', 'thumb/a', 'asset/b']
    expect(orphanedBlobKeys(stored, project([]))).toEqual(['asset/a', 'thumb/a', 'asset/b'])
  })

  it('mixes reachable, orphaned, library, and unknown keys correctly in one pass', () => {
    const p = project([asset('keep')])
    const stored = [
      'asset/keep', // reachable  -> kept
      'thumb/keep', // reachable  -> kept
      'asset/dead', // orphan     -> collected
      'thumb/dead', // orphan     -> collected
      'lib/evergreen', // library    -> kept
      'lib-thumb/evergreen', // library    -> kept
      'mystery/thing', // unknown    -> kept
    ]
    expect(orphanedBlobKeys(stored, p)).toEqual(['asset/dead', 'thumb/dead'])
  })

  it('preserves input order and does not dedupe the returned orphans', () => {
    const stored = ['asset/b', 'asset/a', 'asset/a']
    expect(orphanedBlobKeys(stored, project([]))).toEqual(['asset/b', 'asset/a', 'asset/a'])
  })

  it('treats a bare prefix with no id as project media (still eligible)', () => {
    // Defensive: a malformed 'asset/' key is project-owned, so it is collectable
    // rather than silently immortal.
    expect(orphanedBlobKeys(['asset/'], project([]))).toEqual(['asset/'])
  })

  it('does not mutate the input array', () => {
    const stored = ['asset/a', 'lib/x']
    const copy = [...stored]
    orphanedBlobKeys(stored, project([]))
    expect(stored).toEqual(copy)
  })
})
