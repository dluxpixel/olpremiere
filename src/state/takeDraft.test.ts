// A take written to disk as it records, so a crash costs a second, not the take.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearDraft, draftStore, leftoverDrafts, startDraft, type DraftStore } from './takeDraft'

/** Drafts held in a Map, the four calls and nothing else. */
function memoryDraftStore(): DraftStore & { map: Map<string, Blob>; failPuts: boolean } {
  const map = new Map<string, Blob>()
  const store = {
    map,
    failPuts: false,
    put: async (key: string, blob: Blob) => {
      if (store.failPuts) throw new Error('QuotaExceededError')
      map.set(key, blob)
    },
    keys: async () => [...map.keys()],
    get: async (key: string) => map.get(key),
    delete: async (key: string) => void map.delete(key),
  }
  return store
}

let store: ReturnType<typeof memoryDraftStore>
beforeEach(() => {
  store = memoryDraftStore()
  draftStore.current = store
})

const text = (b: Blob) => b.text()

describe('take drafts', () => {
  it('keeps every chunk in recording order, and a draft from this run is never left over', async () => {
    const d = startDraft()
    for (let i = 0; i < 12; i++) d.add(new Blob([`${i},`], { type: 'audio/webm;codecs=pcm' }))
    await clearDraft('nothing') // waits for the queue
    expect(store.map.size).toBe(12)
    expect(await leftoverDrafts()).toEqual([])
  })

  it('a take from an earlier run comes back as one file, in order, with its type', async () => {
    // What an earlier run left: chunk keys written out of order on purpose.
    const id = 'take-1-old'
    store.map.set(`${id}/0000010`, new Blob(['k'], { type: 'audio/webm;codecs=pcm' }))
    for (let i = 0; i < 10; i++) store.map.set(`${id}/${String(i).padStart(7, '0')}`, new Blob([String(i)], { type: 'audio/webm;codecs=pcm' }))

    const [left] = await leftoverDrafts()
    expect(left!.id).toBe(id)
    expect(await text(left!.blob)).toBe('0123456789k')
    expect(left!.blob.type).toBe('audio/webm;codecs=pcm')
  })

  it('clearing a draft removes its chunks and leaves the others', async () => {
    store.map.set('take-1-old/0000000', new Blob(['old']))
    const d = startDraft()
    d.add(new Blob(['a']))
    d.add(new Blob(['b']))
    await clearDraft(d.id)
    expect([...store.map.keys()]).toEqual(['take-1-old/0000000'])
  })

  it('a full drive stops the draft and never throws at the recorder', async () => {
    const d = startDraft()
    d.add(new Blob(['a']))
    await clearDraft('wait')
    store.failPuts = true
    expect(() => d.add(new Blob(['b']))).not.toThrow()
    await clearDraft('wait')
    store.failPuts = false
    // No gap in the middle of the file: once a write fails, nothing more is written.
    d.add(new Blob(['c']))
    await clearDraft('wait')
    expect(store.map.size).toBe(1)
  })
})
