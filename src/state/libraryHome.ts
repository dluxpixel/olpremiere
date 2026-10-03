// THE LIBRARY'S SECOND HOME, AND THE WAY BACK FROM IT.
//
// ⛔ MEASURED 2026-10-01: his Library (the media he saved, the categories he
// filed it in, his effect presets) lived only in IndexedDB. A wipe like the one
// the browser engine did to him on 2026-08-23 brought every project back from
// its file and its media from the spare copies, and left the Library saying
// "Nothing of your own saved yet". The music he had filed under Battle Cats was
// gone with nothing anywhere able to bring it back.
//
// So the Library gets the same two homes a project has: its records as one file
// beside his project files (electron/libraryFile.ts), its media bytes in the
// spare-copy folder under `lib-<item id>` (mediaMirror.ts). When the store comes
// up empty and the file is there, everything is put back under the keys the
// records already name, before he opens the Library tab.
//
// Pure where it can be: the store, the disk and the spare copies are handed in,
// so the decisions here run under test without IndexedDB or Electron.

import type { EffectPreset } from '../engine/effects/presets'
import type { Id } from '../engine/types'
import type { LibraryItem } from './library'
import type { CategoryMeta, LibraryCategory } from './libraryCategories'

/** What the file holds. `kind` and `version` let a reader refuse anything else. */
export interface LibrarySnapshot {
  kind: 'ol-premiere-library'
  version: 1
  savedAt: number
  items: LibraryItem[]
  presets: EffectPreset[]
  categories: LibraryCategory[]
  lastUsedId: Id | null
}

/** The desktop half: one file, read and written whole. */
export interface LibraryHomeApi {
  libraryWrite(json: string): Promise<void>
  libraryRead(): Promise<string | null>
}

/** The desktop api, or null in the browser build where there is no disk. */
export function libraryHomeApi(): LibraryHomeApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  if (!api || typeof api.libraryWrite !== 'function' || typeof api.libraryRead !== 'function') return null
  return api
}

/** The spare-copy names of a Library item's bytes and thumbnail. */
export const libMirrorId = (itemId: Id): string => `lib-${itemId}`
export const libThumbMirrorId = (itemId: Id): string => `lib-thumb-${itemId}`

export function snapshotOf(
  items: readonly LibraryItem[],
  presets: readonly EffectPreset[],
  meta: CategoryMeta,
  savedAt: number,
): LibrarySnapshot {
  return {
    kind: 'ol-premiere-library',
    version: 1,
    savedAt,
    items: [...items],
    presets: [...presets],
    categories: [...meta.categories],
    lastUsedId: meta.lastUsedId,
  }
}

/** True when there is nothing in it worth a file. */
export const isEmptyLibrary = (s: Pick<LibrarySnapshot, 'items' | 'presets' | 'categories'>): boolean =>
  s.items.length === 0 && s.presets.length === 0 && s.categories.length === 0

/**
 * The file's text as a snapshot, or null for anything that is not one. Only the
 * spine is checked: a record that cannot be used is dropped, never the file.
 */
export function parseLibrarySnapshot(raw: string | null): LibrarySnapshot | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const r = v as Partial<LibrarySnapshot> | null
  if (!r || r.kind !== 'ol-premiere-library' || r.version !== 1) return null
  const isItem = (i: unknown): i is LibraryItem => {
    const x = i as Partial<LibraryItem> | null
    return !!x && typeof x.id === 'string' && typeof x.blobKey === 'string' && typeof x.name === 'string'
  }
  const isPreset = (p: unknown): p is EffectPreset => {
    const x = p as Partial<EffectPreset> | null
    return !!x && typeof x.id === 'string' && Array.isArray(x.effects)
  }
  return {
    kind: 'ol-premiere-library',
    version: 1,
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    items: Array.isArray(r.items) ? r.items.filter(isItem) : [],
    presets: Array.isArray(r.presets) ? r.presets.filter(isPreset) : [],
    categories: Array.isArray(r.categories) ? r.categories : [],
    lastUsedId: typeof r.lastUsedId === 'string' ? r.lastUsedId : null,
  }
}

/** Everything the put-back touches, handed in. */
export interface LibraryRestoreDeps {
  /** Spare copies on disk, by name, with their sizes. */
  listMirror(): Promise<Map<string, number>>
  readMirror(id: string, size: number): Promise<Blob | null>
  putBlob(key: string, blob: Blob): Promise<void>
  /** Write the records into the store, in one go. */
  putRecords(items: LibraryItem[], presets: EffectPreset[], meta: CategoryMeta): Promise<void>
}

export interface LibraryRestored {
  items: LibraryItem[]
  presets: EffectPreset[]
  meta: CategoryMeta
  /** Items whose media was not in the spare copies either, by name. */
  lost: string[]
}

/**
 * Put the Library back from its file and its spare copies.
 *
 * ⛔ AN ITEM COMES BACK ONLY WITH ITS BYTES. A card that opens onto "Library
 * media is missing" is a second disappointment, not a recovery, so an item whose
 * media the spare copies do not have is left out and named in `lost`. Presets
 * and categories are only records, and always come back.
 */
export async function restoreLibrary(snap: LibrarySnapshot, deps: LibraryRestoreDeps): Promise<LibraryRestored> {
  const onDisk = await deps.listMirror()
  const items: LibraryItem[] = []
  const lost: string[] = []
  for (const item of snap.items) {
    const size = onDisk.get(libMirrorId(item.id))
    const blob = size ? await deps.readMirror(libMirrorId(item.id), size) : null
    if (!blob || blob.size === 0) {
      lost.push(item.name)
      continue
    }
    await deps.putBlob(item.blobKey, blob)
    let back: LibraryItem = item
    if (item.thumbnailKey) {
      const tSize = onDisk.get(libThumbMirrorId(item.id))
      const thumb = tSize ? await deps.readMirror(libThumbMirrorId(item.id), tSize) : null
      if (thumb && thumb.size > 0) await deps.putBlob(item.thumbnailKey, thumb)
      else {
        // No picture to show is better than a key that points at nothing.
        back = { ...item }
        delete back.thumbnailKey
      }
    }
    items.push(back)
  }
  const meta: CategoryMeta = { categories: snap.categories, lastUsedId: snap.lastUsedId }
  await deps.putRecords(items, snap.presets, meta)
  return { items, presets: snap.presets, meta, lost }
}

/** What he is told when it came back. */
export function cameBackMessage(r: Pick<LibraryRestored, 'lost'>): string {
  const n = r.lost.length
  if (n === 0) return 'Your Library came back from its file'
  return `Your Library came back from its file, except ${n === 1 ? `${r.lost[0]}, whose media is` : `${n} items whose media is`} not on this computer`
}
