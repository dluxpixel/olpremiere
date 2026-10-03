// The Library comes back after a wipe, from its file and its spare copies.
//
// MEASURED 2026-10-01: GYM's music saved into a new category "Battle Cats",
// the profile's IndexedDB thrown away the way the browser engine did it to him
// on 2026-08-23, and the app relaunched. GYM came back from its file with its
// media; the Library said "Nothing of your own saved yet". These cover the
// decisions; the hidden app proved the whole round trip.

import { describe, expect, it } from 'vitest'
import type { EffectPreset } from '../engine/effects/presets'
import type { LibraryItem } from './library'
import type { CategoryMeta } from './libraryCategories'
import {
  cameBackMessage,
  isEmptyLibrary,
  libMirrorId,
  libThumbMirrorId,
  parseLibrarySnapshot,
  restoreLibrary,
  snapshotOf,
  type LibraryRestoreDeps,
} from './libraryHome'

const music: LibraryItem = {
  id: 'f7e44845',
  name: 'LUKE - Cachalot - Super Slowed (SPOTISAVER).mp3',
  kind: 'audio',
  blobKey: 'lib/f7e44845',
  durationS: 120,
  hasAudio: true,
  hasVideo: false,
  addedAt: 1,
  categoryId: 'battle-cats',
}
const intro: LibraryItem = {
  id: 'a1b2',
  name: 'intro.mp4',
  kind: 'video',
  blobKey: 'lib/a1b2',
  thumbnailKey: 'lib-thumb/a1b2',
  durationS: 3,
  hasAudio: false,
  hasVideo: true,
  addedAt: 2,
}
const grade: EffectPreset = { id: 'p1', name: 'Warm', effects: [], createdAt: 3 }
const meta: CategoryMeta = { categories: [{ id: 'battle-cats', name: 'Battle Cats', createdAt: 1 }], lastUsedId: 'battle-cats' }

/** A store and a spare-copy folder in memory. */
function fakeDeps(onDisk: Record<string, string>) {
  const blobs = new Map<string, Blob>()
  const records: { items?: LibraryItem[]; presets?: EffectPreset[]; meta?: CategoryMeta } = {}
  const deps: LibraryRestoreDeps = {
    listMirror: async () => new Map(Object.entries(onDisk).map(([id, text]) => [id, text.length])),
    readMirror: async (id) => (onDisk[id] ? new Blob([onDisk[id]]) : null),
    putBlob: async (key, blob) => {
      blobs.set(key, blob)
    },
    putRecords: async (items, presets, m) => {
      Object.assign(records, { items, presets, meta: m })
    },
  }
  return { deps, blobs, records }
}

describe('the Library file', () => {
  it('round trips everything he filed: items, presets, categories and where he saved last', () => {
    const snap = snapshotOf([music, intro], [grade], meta, 1000)
    const back = parseLibrarySnapshot(JSON.stringify(snap))
    expect(back).toEqual(snap)
  })

  it('refuses anything that is not a Library file, rather than reading it as an empty one', () => {
    expect(parseLibrarySnapshot(null)).toBeNull()
    expect(parseLibrarySnapshot('{ half a file')).toBeNull()
    expect(parseLibrarySnapshot(JSON.stringify({ kind: 'ol-premiere-backup', version: 1 }))).toBeNull()
  })

  it('knows an empty Library, so an empty store never writes over a full file', () => {
    expect(isEmptyLibrary(snapshotOf([], [], { categories: [], lastUsedId: null }, 0))).toBe(true)
    expect(isEmptyLibrary(snapshotOf([], [grade], { categories: [], lastUsedId: null }, 0))).toBe(false)
  })
})

describe('putting the Library back after a wipe', () => {
  it('puts back the records AND the bytes under the keys the records name', async () => {
    const { deps, blobs, records } = fakeDeps({
      [libMirrorId(music.id)]: 'music bytes',
      [libMirrorId(intro.id)]: 'intro bytes',
      [libThumbMirrorId(intro.id)]: 'thumb',
    })
    const r = await restoreLibrary(snapshotOf([music, intro], [grade], meta, 1000), deps)
    expect(r.lost).toEqual([])
    expect(records.items).toEqual([music, intro])
    expect(records.presets).toEqual([grade])
    expect(records.meta).toEqual(meta)
    expect(await blobs.get('lib/f7e44845')!.text()).toBe('music bytes')
    expect(await blobs.get('lib-thumb/a1b2')!.text()).toBe('thumb')
    expect(cameBackMessage(r)).toBe('Your Library came back from its file')
  })

  it('leaves out an item whose media is nowhere, and says which', async () => {
    const { deps, records } = fakeDeps({ [libMirrorId(intro.id)]: 'intro bytes' })
    const r = await restoreLibrary(snapshotOf([music, intro], [grade], meta, 1000), deps)
    expect(records.items!.map((i) => i.id)).toEqual([intro.id])
    // Its thumbnail was not there either: no key pointing at nothing.
    expect(records.items![0].thumbnailKey).toBeUndefined()
    expect(r.lost).toEqual([music.name])
    // His categories and presets are only records, and always come back.
    expect(records.meta).toEqual(meta)
    expect(records.presets).toEqual([grade])
    expect(cameBackMessage(r)).toBe(`Your Library came back from its file, except ${music.name}, whose media is not on this computer`)
  })
})
