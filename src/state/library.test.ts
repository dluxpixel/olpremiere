// The Library's categories against a stand-in for IndexedDB that keeps what is
// written, so "after a restart" is a real question: wipe the in-memory Library,
// load it again from the stores, and look.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, audioTracks, newProject, type MediaAsset } from '../engine/types'

const hoisted = vi.hoisted(() => {
  const stores: Record<string, Map<string, unknown>> = {}
  const store = (name: string): Map<string, unknown> => (stores[name] ??= new Map())
  // What IndexedDB does to a record: it keeps a COPY, never the live object.
  const keep = (v: unknown): unknown => (v instanceof Blob ? v : structuredClone(v))
  const fakeDb = {
    getAll: async (name: string) => [...store(name).values()].map(keep),
    get: async (name: string, key: string) => keep(store(name).get(key)),
    put: async (name: string, value: unknown, key: string) => {
      store(name).set(key, keep(value))
    },
    delete: async (name: string, key: string) => {
      store(name).delete(key)
    },
    transaction: (names: string | string[]) => {
      const allowed = new Set(Array.isArray(names) ? names : [names])
      return {
        objectStore: (name: string) => {
          if (!allowed.has(name)) throw new Error(`${name} is not in this transaction`)
          return {
            put: async (value: unknown, key: string) => {
              store(name).set(key, keep(value))
            },
            delete: async (key: string) => {
              store(name).delete(key)
            },
          }
        },
        done: Promise.resolve(),
      }
    },
  }
  return { stores, store, fakeDb, toasts: [] as { message: string; action?: { label: string; onClick: () => void } }[] }
})

vi.mock('./persistence', () => ({
  db: async () => hoisted.fakeDb,
  getBlob: async (key: string) => (hoisted.store('blobs').get(key) as Blob | undefined) ?? null,
  putBlob: async (key: string, blob: Blob) => {
    hoisted.store('blobs').set(key, blob)
  },
}))
vi.mock('./toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (message: string, _kind?: string, action?: { label: string; onClick: () => void }) => {
        hoisted.toasts.push({ message, ...(action ? { action } : {}) })
      },
    }),
  },
}))

import {
  addLibraryItemToProject,
  addLibraryItemToTimeline,
  createLibraryCategory,
  deleteLibraryCategory,
  loadLibrary,
  moveLibraryItems,
  promptNewLibraryCategory,
  promptRenameLibraryCategory,
  renameLibraryCategory,
  saveAssetToLibrary,
  saveAssetToNewCategory,
  setLibraryView,
  useLibrary,
  type LibraryItem,
} from './library'
import { ALL_VIEW, CATEGORY_META_KEY, UNSORTED_ID, categoryCounts } from './libraryCategories'
import { saveToCategoryItems } from './libraryMenus'
import { answerNamePrompt, useNamePrompt } from './namePrompt'
import { useStore } from './store'

/** Exactly what the Library stored before categories existed (2026-09-28). */
const oldItem = (id: string, name: string, over: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  name,
  kind: 'audio',
  blobKey: `lib/${id}`,
  durationS: 1.5,
  hasAudio: true,
  hasVideo: false,
  addedAt: 100,
  ...over,
})

function seedOldLibrary(items: LibraryItem[]): void {
  for (const i of items) {
    hoisted.store('library').set(i.id, structuredClone(i))
    hoisted.store('blobs').set(i.blobKey, new Blob(['bytes of ' + i.name]))
  }
}

/** Quit and reopen: nothing survives but what was written to the stores. */
async function restart(): Promise<void> {
  useLibrary.setState({ items: [], presets: [], categories: [], lastCategoryId: null, view: ALL_VIEW, loaded: false })
  await loadLibrary()
}

/** A media asset in the open project's bin, with its bytes stored. */
function binAsset(id: string, name: string, over: Partial<MediaAsset> = {}): MediaAsset {
  const asset: MediaAsset = {
    id,
    name,
    kind: 'audio',
    blobKey: `asset/${id}`,
    durationS: 2,
    hasAudio: true,
    hasVideo: false,
    ...over,
  }
  hoisted.store('blobs').set(asset.blobKey, new Blob(['bytes of ' + name]))
  useStore.getState().dispatch('seed', (p) => ({ ...p, assets: { ...p.assets, [id]: asset } }))
  return asset
}

const stored = (id: string): LibraryItem | undefined => hoisted.store('library').get(id) as LibraryItem | undefined
const lib = () => useLibrary.getState()
const catId = (name: string): string => lib().categories.find((c) => c.name === name)!.id
const lastToast = (): string => hoisted.toasts[hoisted.toasts.length - 1]?.message ?? ''

beforeEach(async () => {
  for (const k of Object.keys(hoisted.stores)) delete hoisted.stores[k]
  hoisted.toasts.length = 0
  useNamePrompt.setState({ request: null, resolve: null })
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ playheadS: 0, selection: [] })
  await restart()
})

describe('the migration: a Library from before categories', () => {
  it('opens with every old item in Unsorted and nothing lost or rewritten', async () => {
    const before = [oldItem('a', 'meow.wav', { addedAt: 1 }), oldItem('b', 'hiss.wav', { addedAt: 2 })]
    seedOldLibrary(before)
    await restart()

    expect(lib().items).toEqual([before[1], before[0]]) // newest first, every field intact
    expect(lib().categories).toEqual([])
    const counts = categoryCounts(lib().items, lib().categories)
    expect(counts.get(UNSORTED_ID)).toBe(2)
    // Nothing was written to make that true.
    expect(stored('a')).toEqual(before[0])
    expect(hoisted.store('meta').has(CATEGORY_META_KEY)).toBe(false)
  })

  it('still opens the items when the category record is garbage', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav', { categoryId: 'lost' })])
    hoisted.store('meta').set(CATEGORY_META_KEY, 'not a record')
    await restart()
    expect(lib().items.map((i) => i.name)).toEqual(['meow.wav'])
    expect(categoryCounts(lib().items, lib().categories).get(UNSORTED_ID)).toBe(1)
  })
})

describe('making, renaming and removing categories', () => {
  it('makes a category that is still there after a restart', async () => {
    const made = await createLibraryCategory('  Battle Cats ')
    expect(made?.name).toBe('Battle Cats')
    await restart()
    expect(lib().categories.map((c) => c.name)).toEqual(['Battle Cats'])
  })

  it('refuses a blank, reserved or taken name and saves nothing', async () => {
    await createLibraryCategory('Battle Cats')
    expect(await createLibraryCategory('   ')).toBeNull()
    expect(lastToast()).toBe('Type a name first')
    expect(await createLibraryCategory('unsorted')).toBeNull()
    expect(await createLibraryCategory('battle cats')).toBeNull()
    expect(lastToast()).toBe('You already have Battle Cats')
    await restart()
    expect(lib().categories).toHaveLength(1)
  })

  it('renames a category and its items stay in it', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav')])
    await restart()
    const bc = (await createLibraryCategory('Battle Cat'))!
    await moveLibraryItems(['a'], bc.id)
    expect(await renameLibraryCategory(bc.id, 'Battle Cats')).toBe(true)
    await restart()
    expect(lib().categories.map((c) => c.name)).toEqual(['Battle Cats'])
    expect(lib().items[0].categoryId).toBe(bc.id)
  })

  it('will not rename onto a name that is taken', async () => {
    await createLibraryCategory('Battle Cats')
    const mc = (await createLibraryCategory('Minecraft'))!
    expect(await renameLibraryCategory(mc.id, 'BATTLE CATS')).toBe(false)
    await restart()
    expect(lib().categories.map((c) => c.name).sort()).toEqual(['Battle Cats', 'Minecraft'])
  })

  it('removing a category keeps every item in it, moved to Unsorted, on disk too', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav'), oldItem('b', 'hiss.wav'), oldItem('c', 'intro.mp4')])
    await restart()
    const bc = (await createLibraryCategory('Battle Cats'))!
    const mc = (await createLibraryCategory('Minecraft'))!
    await moveLibraryItems(['a', 'b'], bc.id)
    await moveLibraryItems(['c'], mc.id)
    setLibraryView(bc.id)

    await deleteLibraryCategory(bc.id)

    expect(lib().categories.map((c) => c.name)).toEqual(['Minecraft'])
    expect(lib().items).toHaveLength(3)
    expect(lastToast()).toBe('Removed Battle Cats. Its 2 items are in Unsorted now')
    // He is shown where they went.
    expect(lib().view).toBe(UNSORTED_ID)
    await restart()
    const counts = categoryCounts(lib().items, lib().categories)
    expect(counts.get(UNSORTED_ID)).toBe(2)
    expect(counts.get(mc.id)).toBe(1)
    expect('categoryId' in stored('a')!).toBe(false)
    // The bytes were never touched.
    expect(hoisted.store('blobs').has('lib/a')).toBe(true)
  })

  it('the Undo on a removal puts the category and its items back', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav'), oldItem('b', 'hiss.wav')])
    await restart()
    const bc = (await createLibraryCategory('Battle Cats'))!
    await moveLibraryItems(['a', 'b'], bc.id)
    await deleteLibraryCategory(bc.id)
    const undo = hoisted.toasts[hoisted.toasts.length - 1].action!
    expect(undo.label).toBe('Undo')

    undo.onClick()
    await vi.waitFor(() => expect(lib().categories).toHaveLength(1))
    await restart()
    expect(lib().categories[0]).toEqual(bc)
    expect(categoryCounts(lib().items, lib().categories).get(bc.id)).toBe(2)
  })

  it('removing the category he saved to last sends the next one-click save to Unsorted', async () => {
    binAsset('x', 'meow.wav')
    const bc = (await createLibraryCategory('Battle Cats'))!
    await saveAssetToLibrary('x', bc.id)
    expect(lib().lastCategoryId).toBe(bc.id)
    await deleteLibraryCategory(bc.id)
    expect(lib().lastCategoryId).toBeNull()
    await restart()
    expect(lib().lastCategoryId).toBeNull()
  })
})

describe('saving into a category', () => {
  it('one click with no categories still saves to the Library the way it always did', async () => {
    binAsset('x', 'meow.wav')
    await saveAssetToLibrary('x')
    expect(lastToast()).toBe('Saved meow.wav to Library')
    expect(lib().items).toHaveLength(1)
    expect('categoryId' in lib().items[0]).toBe(false)
  })

  it('saves into the category he picks, and the next one click goes there too', async () => {
    binAsset('x', 'meow.wav')
    binAsset('y', 'hiss.wav')
    const bc = (await createLibraryCategory('Battle Cats'))!

    await saveAssetToLibrary('x', bc.id)
    // The words the end to end test waits for are still in there.
    expect(lastToast()).toMatch(/Saved .* to Library/)
    expect(lastToast()).toBe('Saved meow.wav to Library: Battle Cats')

    await saveAssetToLibrary('y')
    await restart()
    expect(lib().items.map((i) => i.categoryId)).toEqual([bc.id, bc.id])
    expect(lib().lastCategoryId).toBe(bc.id)
  })

  it('picking Unsorted makes Unsorted the one-click place again', async () => {
    binAsset('x', 'meow.wav')
    binAsset('y', 'hiss.wav')
    const bc = (await createLibraryCategory('Battle Cats'))!
    await saveAssetToLibrary('x', bc.id)
    await saveAssetToLibrary('y', UNSORTED_ID)
    expect(lib().lastCategoryId).toBeNull()
    expect(lib().items.find((i) => i.name === 'hiss.wav')!.categoryId).toBeUndefined()
  })

  it('picking a category for something already saved moves it there, never a second copy', async () => {
    binAsset('x', 'meow.wav')
    await saveAssetToLibrary('x')
    const bc = (await createLibraryCategory('Battle Cats'))!
    await saveAssetToLibrary('x', bc.id)
    expect(lib().items).toHaveLength(1)
    expect(lib().items[0].categoryId).toBe(bc.id)
    expect(lastToast()).toBe('Moved meow.wav to Battle Cats')
  })

  it('"New category..." asks for a name, makes it, and saves into it', async () => {
    binAsset('x', 'meow.wav')
    const saving = saveAssetToNewCategory('x')
    await vi.waitFor(() => expect(useNamePrompt.getState().request).not.toBeNull())
    answerNamePrompt('  Battle Cats ')
    await saving
    expect(lib().categories.map((c) => c.name)).toEqual(['Battle Cats'])
    expect(lib().items[0].categoryId).toBe(catId('Battle Cats'))
  })

  it('"New category..." with a name he already has just uses that one', async () => {
    binAsset('x', 'meow.wav')
    const bc = (await createLibraryCategory('Battle Cats'))!
    const saving = saveAssetToNewCategory('x')
    await vi.waitFor(() => expect(useNamePrompt.getState().request).not.toBeNull())
    expect(useNamePrompt.getState().request!.validate!('battle cats')).toBeNull()
    answerNamePrompt('battle cats')
    await saving
    expect(lib().categories).toHaveLength(1)
    expect(lib().items[0].categoryId).toBe(bc.id)
  })

  it('backing out of the name saves nothing', async () => {
    binAsset('x', 'meow.wav')
    const saving = saveAssetToNewCategory('x')
    await vi.waitFor(() => expect(useNamePrompt.getState().request).not.toBeNull())
    answerNamePrompt(null)
    await saving
    expect(lib().items).toHaveLength(0)
    expect(lib().categories).toHaveLength(0)
  })

  it('the save menu lists Unsorted, his categories A to Z, then New category, ticking the one-click place', async () => {
    binAsset('x', 'meow.wav')
    await createLibraryCategory('Minecraft')
    const bc = (await createLibraryCategory('Battle Cats'))!
    let menu = saveToCategoryItems('x')
    expect(menu.map((m) => m.label)).toEqual(['Unsorted', 'Battle Cats', 'Minecraft', 'New category...'])
    expect(menu.find((m) => m.checked)?.label).toBe('Unsorted')

    menu.find((m) => m.label === 'Battle Cats')!.onClick!()
    await vi.waitFor(() => expect(lib().items).toHaveLength(1))
    expect(lib().items[0].categoryId).toBe(bc.id)
    await vi.waitFor(() => expect(lib().lastCategoryId).toBe(bc.id))
    menu = saveToCategoryItems('x')
    expect(menu.find((m) => m.checked)?.label).toBe('Battle Cats')
  })
})

describe('moving items between categories', () => {
  it('moves items and the move survives a restart', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav'), oldItem('b', 'hiss.wav')])
    await restart()
    const bc = (await createLibraryCategory('Battle Cats'))!
    const mc = (await createLibraryCategory('Minecraft'))!

    await moveLibraryItems(['a', 'b'], bc.id)
    expect(lastToast()).toBe('Moved 2 items to Battle Cats')
    await moveLibraryItems(['b'], mc.id)
    expect(lastToast()).toBe('Moved hiss.wav to Minecraft')
    await moveLibraryItems(['a'], UNSORTED_ID)

    await restart()
    const byName = Object.fromEntries(lib().items.map((i) => [i.name, i.categoryId]))
    expect(byName).toEqual({ 'meow.wav': undefined, 'hiss.wav': mc.id })
  })

  it('does nothing for a category that does not exist', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav')])
    await restart()
    await moveLibraryItems(['a'], 'no-such-category')
    expect(lib().items[0].categoryId).toBeUndefined()
    expect(hoisted.toasts).toHaveLength(0)
  })
})

describe('the name dialog flows from the Library tab', () => {
  it('New category makes it and shows it', async () => {
    const making = promptNewLibraryCategory()
    await vi.waitFor(() => expect(useNamePrompt.getState().request?.title).toBe('New category'))
    answerNamePrompt('Battle Cats')
    await making
    expect(lib().view).toBe(catId('Battle Cats'))
    // A taken name is caught in the dialog, before he presses anything.
    const again = promptNewLibraryCategory()
    await vi.waitFor(() => expect(useNamePrompt.getState().request).not.toBeNull())
    expect(useNamePrompt.getState().request!.validate!('battle cats')).toBe('You already have Battle Cats')
    answerNamePrompt(null)
    await again
  })

  it('Rename starts from the old name', async () => {
    const bc = (await createLibraryCategory('Battle Cat'))!
    const renaming = promptRenameLibraryCategory(bc.id)
    await vi.waitFor(() => expect(useNamePrompt.getState().request?.initial).toBe('Battle Cat'))
    answerNamePrompt('Battle Cats')
    await renaming
    expect(lib().categories[0].name).toBe('Battle Cats')
  })
})

describe('using a Library item', () => {
  const clipsOnA1 = () => audioTracks(activeSequence(useStore.getState().project))[0].clips

  it('puts it on the timeline at the playhead, media and clip in one undo step', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav')])
    await restart()
    useStore.getState().setUI({ playheadS: 3 })

    await addLibraryItemToTimeline('a')

    const assets = Object.values(useStore.getState().project.assets)
    expect(assets).toHaveLength(1)
    expect(assets[0].blobKey).not.toBe('lib/a') // the project's OWN copy
    expect(hoisted.store('blobs').get(assets[0].blobKey)).toBeInstanceOf(Blob)
    expect(clipsOnA1().map((c) => c.startS)).toEqual([3])

    useStore.getState().undo()
    expect(Object.keys(useStore.getState().project.assets)).toHaveLength(0)
    expect(clipsOnA1()).toHaveLength(0)
  })

  it('lands a drop exactly where it was aimed', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav')])
    await restart()
    const lane = audioTracks(activeSequence(useStore.getState().project))[0]
    await addLibraryItemToTimeline('a', { atS: 7.5, trackId: lane.id, exact: true })
    expect(clipsOnA1().map((c) => c.startS)).toEqual([7.5])
  })

  it('reuses the project copy the second time instead of copying the bytes again', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav')])
    await restart()
    await addLibraryItemToTimeline('a')
    useStore.getState().setUI({ playheadS: 5 })
    await addLibraryItemToTimeline('a')
    expect(Object.keys(useStore.getState().project.assets)).toHaveLength(1)
    expect(clipsOnA1()).toHaveLength(2)
  })

  it('double click still copies into the bin every time, as the end to end test expects', async () => {
    seedOldLibrary([oldItem('a', 'meow.wav')])
    await restart()
    await addLibraryItemToProject('a')
    await addLibraryItemToProject('a')
    expect(Object.keys(useStore.getState().project.assets)).toHaveLength(2)
    expect(clipsOnA1()).toHaveLength(0)
  })
})
