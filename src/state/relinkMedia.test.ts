// Putting his media back on his edit without touching the edit.
//
// The rule that must never break: the document does not move. Same asset ids,
// same keys, same clips. Only what `getBlob` answers with changes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../engine/types'

const store = new Map<string, Blob>()
vi.mock('./persistence', () => ({
  getBlob: (k: string) => Promise.resolve(store.get(k) ?? null),
  putBlob: (k: string, b: Blob) => {
    if (k === 'asset/explodes') return Promise.reject(new Error('quota'))
    store.set(k, b)
    return Promise.resolve()
  },
}))

const { matchFilesToMissing, missingMedia, relink, relinkSummary } = await import('./relinkMedia')

const file = (name: string, bytes = 8): File => new File([new Uint8Array(bytes)], name)
const asset = (id: string, name: string) => ({ id, name, blobKey: `asset/${id}` })

beforeEach(() => {
  store.clear()
})

describe('finding what is missing', () => {
  const project = {
    assets: {
      a: { id: 'a', name: 'clip.mp4', blobKey: 'asset/a' },
      b: { id: 'b', name: 'voice.webm', blobKey: 'asset/b' },
      t: { id: 't', name: 'Title' },
    },
  } as unknown as Project

  it('names the assets whose bytes are gone and leaves the ones that are fine', async () => {
    store.set('asset/a', new Blob(['x']))
    const missing = await missingMedia(project)
    expect(missing.map((m) => m.name)).toEqual(['voice.webm'])
  })

  it('never counts a title, which has no media by design', async () => {
    store.set('asset/a', new Blob(['x']))
    store.set('asset/b', new Blob(['x']))
    expect(await missingMedia(project)).toEqual([])
  })

  it('says everything when the store came up empty, which is his case', async () => {
    expect((await missingMedia(project)).map((m) => m.name)).toEqual(['clip.mp4', 'voice.webm'])
  })
})

describe('matching the files he picks', () => {
  it('matches on the exact name first', () => {
    const r = matchFilesToMissing([asset('a', 'clip.mp4')], [file('other.mp4'), file('clip.mp4')])
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].file.name).toBe('clip.mp4')
    expect(r.unused.map((f) => f.name)).toEqual(['other.mp4'])
  })

  it('matches whatever case the folder gave them', () => {
    const r = matchFilesToMissing([asset('a', 'Voice Recording 9.webm')], [file('voice recording 9.webm')])
    expect(r.matched).toHaveLength(1)
  })

  // Survives a round trip through a phone or a re-encode.
  it('matches on the name without its extension when nothing else does', () => {
    const r = matchFilesToMissing([asset('a', 'Voice recording 12.webm')], [file('Voice recording 12.m4a')])
    expect(r.matched).toHaveLength(1)
    expect(r.stillMissing).toEqual([])
  })

  // ⛔ Two clips playing the same audio looks fine and is not, which is worse
  // than staying visibly broken.
  it('uses each file ONCE, so two assets with one name cannot share it', () => {
    const r = matchFilesToMissing([asset('a', 'take.wav'), asset('b', 'take.wav')], [file('take.wav')])
    expect(r.matched).toHaveLength(1)
    expect(r.stillMissing.map((m) => m.id)).toEqual(['b'])
  })

  it('says which assets are still missing and which files were no use', () => {
    const r = matchFilesToMissing([asset('a', 'clip.mp4'), asset('b', 'gone.wav')], [file('clip.mp4'), file('spare.png')])
    expect(r.stillMissing.map((m) => m.name)).toEqual(['gone.wav'])
    expect(r.unused.map((f) => f.name)).toEqual(['spare.png'])
  })

  it('copes with him picking nothing at all', () => {
    const r = matchFilesToMissing([asset('a', 'clip.mp4')], [])
    expect(r.matched).toEqual([])
    expect(r.stillMissing).toHaveLength(1)
  })
})

describe('writing the bytes back', () => {
  it('writes under the key the document already points at, so every clip keeps working', async () => {
    const a = asset('keepme', 'clip.mp4')
    const { done } = await relink([{ asset: a, file: file('clip.mp4', 42) }])
    expect(done).toBe(1)
    expect(store.get('asset/keepme')?.size).toBe(42)
  })

  it('reports the ones it could not write rather than claiming them', async () => {
    const { done, failed } = await relink([
      { asset: asset('explodes', 'big.mp4'), file: file('big.mp4') },
      { asset: asset('fine', 'ok.mp4'), file: file('ok.mp4') },
    ])
    expect(done).toBe(1)
    expect(failed).toEqual(['big.mp4'])
  })
})

describe('what he reads', () => {
  it('leads with what came back', () => {
    const r = matchFilesToMissing([asset('a', 'clip.mp4')], [file('clip.mp4')])
    expect(relinkSummary(r, 1)).toBe('Put 1 file back on your edit')
  })

  it('says plainly when nothing matched, and names what is still gone', () => {
    const r = matchFilesToMissing([asset('a', 'clip.mp4')], [file('nope.png')])
    expect(relinkSummary(r, 0)).toContain('None of those matched')
    expect(relinkSummary(r, 0)).toContain('clip.mp4')
  })

  it('counts what is still missing and what was no use', () => {
    const r = matchFilesToMissing([asset('a', 'clip.mp4'), asset('b', 'gone.wav')], [file('clip.mp4'), file('spare.png')])
    const s = relinkSummary(r, 1)
    expect(s).toContain('Put 1 file back')
    expect(s).toContain('Still missing 1')
    expect(s).toContain('1 did not match')
  })
})
