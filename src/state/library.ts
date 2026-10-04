// The global Library: media and effect presets that OUTLIVE any project.
//
// Ownership model is copy-on-save and copy-on-use. Saving an asset to the
// Library copies its blob under a 'lib/' key; using a library item in a project
// copies it back under a fresh 'asset/' key. Bytes are duplicated, but neither
// side can ever break the other: deleting a bin asset cannot hole the Library,
// and removing a Library item cannot hole a project that used it. For the small
// evergreen media a library holds (intros, watermarks, jingles) that trade is
// obviously right.
//
// Library operations are global, so they are NOT on the project undo stack.
// Destructive ones (remove) only ever delete the Library's own copy.
//
// Media is filed in categories he names (libraryCategories.ts holds the rules).
// His words, 2026-09-28: *"when I want to save a sound effect for Battle Cats,
// I can."* An item carries its category on its own record and the category
// list sits in ONE small 'meta' record, so this needed no new object store and
// no database version bump: an old install opens exactly as before and every
// item it already had reads as Unsorted.

import { autoPresetName, copyEffects, presetFromClip, type EffectPreset } from '../engine/effects/presets'
import { addClipFromAsset, addClipWithLinkedAudio } from '../engine/timeline'
import {
  activeSequence,
  audioTracks,
  newId,
  videoTracks,
  type Id,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { create } from 'zustand'
import {
  ALL_VIEW,
  CATEGORY_META_KEY,
  CATEGORY_NAME_MAX,
  UNSORTED_ID,
  categoryIdOf,
  categoryLabel,
  categoryNameProblem,
  cleanCategoryName,
  findCategoryByName,
  liveView,
  migrateLibraryItem,
  parseCategoryMeta,
  saveTargetOf,
  withCategory,
  type CategoryMeta,
  type LibraryCategory,
  type LibraryView,
} from './libraryCategories'
import {
  cameBackMessage,
  isEmptyLibrary,
  libMirrorId,
  libraryHomeApi,
  libThumbMirrorId,
  parseLibrarySnapshot,
  restoreLibrary,
  snapshotOf,
  type LibraryRestored,
} from './libraryHome'
import { mirrorApi, mirrorAsset, mirroredIds, readMirrored } from './mediaMirror'
import { askForName } from './namePrompt'
import { db, getBlob, putBlob } from './persistence'
import { lockedLeftOut } from './bulkEdits'
import { useStore } from './store'
import { useToasts } from './toasts'

export interface LibraryItem {
  id: Id
  name: string
  kind: MediaAsset['kind']
  /** 'lib/<id>': the Library's OWN copy of the media. */
  blobKey: string
  thumbnailKey?: string
  durationS: number
  width?: number
  height?: number
  hasAudio: boolean
  hasVideo: boolean
  addedAt: number
  /**
   * The category he filed it in. Absent on everything saved before 2026-09-28,
   * and absent again whenever it is moved to Unsorted: absent IS Unsorted.
   */
  categoryId?: Id
}

interface LibraryState {
  items: LibraryItem[]
  presets: EffectPreset[]
  categories: LibraryCategory[]
  /** Where a one-click "Save to Library" goes. Null means Unsorted. */
  lastCategoryId: Id | null
  /** What the Library tab is showing. Not saved: every launch opens on All. */
  view: LibraryView
  loaded: boolean
}

export const useLibrary = create<LibraryState>(() => ({
  items: [],
  presets: [],
  categories: [],
  lastCategoryId: null,
  view: ALL_VIEW,
  loaded: false,
}))

const byNewest = <T extends { addedAt?: number; createdAt?: number }>(a: T, b: T): number =>
  (b.addedAt ?? b.createdAt ?? 0) - (a.addedAt ?? a.createdAt ?? 0)

/** Load once at boot. Safe to call again (idempotent refresh). */
export async function loadLibrary(): Promise<void> {
  const d = await db()
  let [items, presets, meta] = await Promise.all([
    d.getAll('library'),
    d.getAll('presets'),
    // A category record that cannot be read must never cost him the Library
    // itself: the items still load, and they read as Unsorted.
    Promise.resolve(d.get('meta', CATEGORY_META_KEY)).catch(() => undefined),
  ])
  // ⛔ A STORE THAT CAME UP WITH NO LIBRARY AT ALL ASKS ITS FILE FIRST. That is
  // what a wipe looks like from here, and the file beside his projects is the
  // copy a wipe cannot touch (libraryHome.ts).
  let cameBack: string | null = null
  if (items.length === 0 && presets.length === 0 && meta === undefined) {
    const back = await putLibraryBackFromHome()
    if (back) {
      items = back.items
      presets = back.presets
      meta = back.meta
      cameBack = cameBackMessage(back)
    }
  }
  const { categories, lastUsedId } = parseCategoryMeta(meta)
  useLibrary.setState((s) => ({
    items: (items as LibraryItem[]).map(migrateLibraryItem).sort(byNewest),
    presets: (presets as EffectPreset[]).sort(byNewest),
    categories,
    lastCategoryId: lastUsedId,
    view: liveView(s.view, categories),
    loaded: true,
  }))
  if (cameBack) useToasts.getState().show(cameBack, 'success', undefined, { durationMs: 10_000 })
  keepLibraryHome()
}

// ---------------------------------------------------------------------------
// The second home (libraryHome.ts): the file beside his projects and the spare
// copies of the bytes, kept current, and read back after a wipe.

/** Set when a put-back failed half way: the file is then the only good copy. */
let homeBlocked = false
let homeKept = false
let homeTimer: ReturnType<typeof setTimeout> | undefined

/** Put the Library back from its file, or null when there is nothing to put back. */
async function putLibraryBackFromHome(): Promise<LibraryRestored | null> {
  const api = libraryHomeApi()
  if (!api) return null
  const snap = parseLibrarySnapshot(await api.libraryRead().catch(() => null))
  if (!snap || isEmptyLibrary(snap)) return null
  try {
    return await restoreLibrary(snap, {
      listMirror: async () => {
        const listing = await mirrorApi()?.mediaList().catch(() => null)
        return new Map((listing?.files ?? []).map((f) => [f.id, f.size]))
      },
      readMirror: readMirrored,
      putBlob,
      putRecords: async (items, presets, meta) => {
        const d = await db()
        const tx = d.transaction(['library', 'presets', 'meta'], 'readwrite')
        for (const item of items) void tx.objectStore('library').put(item, item.id)
        for (const preset of presets) void tx.objectStore('presets').put(preset, preset.id)
        void tx.objectStore('meta').put(meta, CATEGORY_META_KEY)
        await tx.done
      },
    })
  } catch (err) {
    // Never write over the file this session: it is the copy that still has it all.
    homeBlocked = true
    console.error('OL Premiere: the Library could not be put back from its file', err)
    return null
  }
}

/** Copy out the bytes of anything saved before the second home existed. */
async function backfillLibraryBytes(items: readonly LibraryItem[]): Promise<void> {
  const onDisk = await mirroredIds()
  for (const item of items) {
    const pairs: [string, string | undefined][] = [
      [libMirrorId(item.id), item.blobKey],
      [libThumbMirrorId(item.id), item.thumbnailKey],
    ]
    for (const [name, key] of pairs) {
      if (!key || onDisk.has(name)) continue
      const blob = await getBlob(key).catch(() => null)
      if (blob && blob.size > 0) await mirrorAsset(name, blob)
    }
  }
}

/**
 * Keep the file current: written on every change to the items, the presets or
 * the categories, a moment after the last one. Installed once.
 *
 * ⛔ AN EMPTY LIBRARY NEVER WRITES AT BOOT. A store that came up empty and could
 * not be put back must not overwrite the one file that still holds it all; it
 * writes only once he changes something himself.
 */
function keepLibraryHome(): void {
  const api = libraryHomeApi()
  if (!api || homeKept) return
  homeKept = true
  const write = (): void => {
    if (homeBlocked) return
    const s = useLibrary.getState()
    const snap = snapshotOf(s.items, s.presets, { categories: s.categories, lastUsedId: s.lastCategoryId }, Date.now())
    void api.libraryWrite(JSON.stringify(snap)).catch((err: unknown) => {
      console.warn('OL Premiere: the Library file could not be written', err)
    })
  }
  const now = useLibrary.getState()
  if (!isEmptyLibrary(now)) {
    write()
    void backfillLibraryBytes(now.items).catch(() => undefined)
  }
  useLibrary.subscribe((next, prev) => {
    if (!next.loaded) return
    const same =
      next.items === prev.items &&
      next.presets === prev.presets &&
      next.categories === prev.categories &&
      next.lastCategoryId === prev.lastCategoryId
    if (same) return
    clearTimeout(homeTimer)
    homeTimer = setTimeout(write, 300)
  })
}

// ---------------------------------------------------------------------------
// Categories

const toast = (message: string, kind?: 'info' | 'success' | 'danger'): void =>
  useToasts.getState().show(message, kind)

/** Run a storage write; on failure say so and report false, so no state changes. */
async function saved(write: () => Promise<void>): Promise<boolean> {
  try {
    await write()
    return true
  } catch {
    toast('Could not save that. Try again', 'danger')
    return false
  }
}

const metaRecord = (categories: LibraryCategory[], lastUsedId: Id | null): CategoryMeta => ({
  categories,
  lastUsedId,
})

async function writeCategoryMeta(categories: LibraryCategory[], lastUsedId: Id | null): Promise<void> {
  const d = await db()
  await d.put('meta', metaRecord(categories, lastUsedId), CATEGORY_META_KEY)
}

/** Remember where he saved last, so the next one-click save goes there too. */
async function rememberSaveTarget(target: Id): Promise<void> {
  const { categories, lastCategoryId } = useLibrary.getState()
  const next = target === UNSORTED_ID ? null : target
  if (next === lastCategoryId) return
  if (await saved(() => writeCategoryMeta(categories, next))) useLibrary.setState({ lastCategoryId: next })
}

/** Make a category. Says why and returns null when the name cannot be used. */
export async function createLibraryCategory(rawName: string): Promise<LibraryCategory | null> {
  const { categories, lastCategoryId } = useLibrary.getState()
  const problem = categoryNameProblem(rawName, categories)
  if (problem) {
    toast(problem)
    return null
  }
  const category: LibraryCategory = { id: newId(), name: cleanCategoryName(rawName), createdAt: Date.now() }
  const next = [...categories, category]
  if (!(await saved(() => writeCategoryMeta(next, lastCategoryId)))) return null
  useLibrary.setState({ categories: next })
  return category
}

/** Rename a category. Its items stay in it: they point at its id, not its name. */
export async function renameLibraryCategory(id: Id, rawName: string): Promise<boolean> {
  const { categories, lastCategoryId } = useLibrary.getState()
  const old = categories.find((c) => c.id === id)
  if (!old) return false
  const problem = categoryNameProblem(rawName, categories, id)
  if (problem) {
    toast(problem)
    return false
  }
  const name = cleanCategoryName(rawName)
  if (name === old.name) return true
  const next = categories.map((c) => (c.id === id ? { ...c, name } : c))
  if (!(await saved(() => writeCategoryMeta(next, lastCategoryId)))) return false
  useLibrary.setState({ categories: next })
  toast(`Renamed ${old.name} to ${name}`, 'success')
  return true
}

/**
 * Delete a category and NOTHING in it. Its items move to Unsorted, in the same
 * storage transaction that drops the category, so there is no moment where an
 * item points at a category that is gone. The toast can put it all back.
 */
export async function deleteLibraryCategory(id: Id): Promise<void> {
  const { categories, items, lastCategoryId, view } = useLibrary.getState()
  const category = categories.find((c) => c.id === id)
  if (!category) return
  const inside = items.filter((i) => categoryIdOf(i, categories) === id)
  const moved = new Map(inside.map((i) => [i.id, withCategory(i, UNSORTED_ID)]))
  const nextCategories = categories.filter((c) => c.id !== id)
  const nextLast = lastCategoryId === id ? null : lastCategoryId
  const ok = await saved(async () => {
    const d = await db()
    const tx = d.transaction(['library', 'meta'], 'readwrite')
    for (const item of moved.values()) void tx.objectStore('library').put(item, item.id)
    void tx.objectStore('meta').put(metaRecord(nextCategories, nextLast), CATEGORY_META_KEY)
    await tx.done
  })
  if (!ok) return
  useLibrary.setState((s) => ({
    categories: nextCategories,
    items: s.items.map((i) => moved.get(i.id) ?? i),
    lastCategoryId: nextLast,
    // Show him where they went.
    view: view === id ? UNSORTED_ID : view,
  }))
  const n = inside.length
  useToasts
    .getState()
    .show(
      n === 0
        ? `Removed ${category.name}`
        : `Removed ${category.name}. ${n === 1 ? 'Its item is' : `Its ${n} items are`} in Unsorted now`,
      'info',
      { label: 'Undo', onClick: () => void restoreLibraryCategory(category, [...moved.keys()]) },
    )
}

/** The Undo on a delete: the category comes back and its items go back in. */
async function restoreLibraryCategory(category: LibraryCategory, itemIds: Id[]): Promise<void> {
  const { categories, items, lastCategoryId } = useLibrary.getState()
  if (categories.some((c) => c.id === category.id)) return
  if (findCategoryByName(categories, category.name)) {
    toast(`You already have ${category.name}`)
    return
  }
  const nextCategories = [...categories, category]
  const wanted = new Set(itemIds)
  // Only what is still in Unsorted: anything he filed elsewhere since stays put.
  const back = new Map(
    items
      .filter((i) => wanted.has(i.id) && categoryIdOf(i, categories) === UNSORTED_ID)
      .map((i) => [i.id, withCategory(i, category.id)]),
  )
  const ok = await saved(async () => {
    const d = await db()
    const tx = d.transaction(['library', 'meta'], 'readwrite')
    for (const item of back.values()) void tx.objectStore('library').put(item, item.id)
    void tx.objectStore('meta').put(metaRecord(nextCategories, lastCategoryId), CATEGORY_META_KEY)
    await tx.done
  })
  if (!ok) return
  useLibrary.setState((s) => ({ categories: nextCategories, items: s.items.map((i) => back.get(i.id) ?? i) }))
  toast(`${category.name} is back`, 'success')
}

/** File items in a category (or Unsorted). Items already there are left alone. */
export async function moveLibraryItems(itemIds: readonly Id[], categoryId: Id): Promise<void> {
  const { categories, items } = useLibrary.getState()
  if (categoryId !== UNSORTED_ID && !categories.some((c) => c.id === categoryId)) return
  const wanted = new Set(itemIds)
  const moved = new Map(
    items
      .filter((i) => wanted.has(i.id) && categoryIdOf(i, categories) !== categoryId)
      .map((i) => [i.id, withCategory(i, categoryId)]),
  )
  if (moved.size === 0) return
  const ok = await saved(async () => {
    const d = await db()
    const tx = d.transaction('library', 'readwrite')
    for (const item of moved.values()) void tx.objectStore('library').put(item, item.id)
    await tx.done
  })
  if (!ok) return
  useLibrary.setState((s) => ({ items: s.items.map((i) => moved.get(i.id) ?? i) }))
  const where = categoryLabel(categoryId, categories)
  const first = [...moved.values()][0]
  toast(moved.size === 1 ? `Moved ${first.name} to ${where}` : `Moved ${moved.size} items to ${where}`, 'success')
}

/** Pick what the Library tab shows. */
export function setLibraryView(view: LibraryView): void {
  useLibrary.setState((s) => ({ view: liveView(view, s.categories) }))
}

/**
 * Ask for a name and hand back the category it means. A name he already has
 * is not an error HERE: when he is filing something, "Battle Cats" typed again
 * just means the Battle Cats he has.
 */
async function askForCategory(title: string, confirmLabel: string): Promise<LibraryCategory | null> {
  const name = await askForName({
    title,
    confirmLabel,
    placeholder: 'Like Battle Cats',
    maxLength: CATEGORY_NAME_MAX,
    validate: (n) => {
      const { categories } = useLibrary.getState()
      return findCategoryByName(categories, n) ? null : categoryNameProblem(n, categories)
    },
  })
  if (name === null) return null
  return findCategoryByName(useLibrary.getState().categories, name) ?? (await createLibraryCategory(name))
}

/** The Library tab's "New category" button. */
export async function promptNewLibraryCategory(): Promise<void> {
  const name = await askForName({
    title: 'New category',
    confirmLabel: 'Make it',
    placeholder: 'Like Battle Cats',
    maxLength: CATEGORY_NAME_MAX,
    validate: (n) => categoryNameProblem(n, useLibrary.getState().categories),
  })
  if (name === null) return
  const category = await createLibraryCategory(name)
  if (category) {
    setLibraryView(category.id)
    toast(`Made ${category.name}. Save things into it from any media item's right-click menu`, 'success')
  }
}

/** Ask for a new name for a category, then rename it. */
export async function promptRenameLibraryCategory(id: Id): Promise<void> {
  const category = useLibrary.getState().categories.find((c) => c.id === id)
  if (!category) return
  const name = await askForName({
    title: `Rename ${category.name}`,
    confirmLabel: 'Rename',
    initial: category.name,
    maxLength: CATEGORY_NAME_MAX,
    validate: (n) => categoryNameProblem(n, useLibrary.getState().categories, id),
  })
  if (name !== null) await renameLibraryCategory(id, name)
}

/** "New category..." on a save menu: name it, then save into it. */
export async function saveAssetToNewCategory(assetId: Id): Promise<void> {
  const category = await askForCategory('Save to a new category', 'Save')
  if (category) await saveAssetToLibrary(assetId, category.id)
}

/** "New category..." on a move menu: name it, then move the items into it. */
export async function moveLibraryItemsToNewCategory(itemIds: readonly Id[]): Promise<void> {
  const category = await askForCategory('Move to a new category', 'Move')
  if (category) await moveLibraryItems(itemIds, category.id)
}

// ---------------------------------------------------------------------------
// Media

/**
 * Is this media already in the Library? Name plus duration IS the Library's
 * identity for a piece of media: the bytes are copied on save, so blob keys
 * never match, and re-importing the same file gives it a fresh asset id.
 *
 * Exported so the bin's permanent Save button can show the answer BEFORE the
 * click instead of re-deriving the rule and drifting from the one below.
 */
export function isInLibrary(items: readonly LibraryItem[], name: string, durationS: number): boolean {
  return items.some((i) => i.name === name && i.durationS === durationS)
}

/**
 * Save a bin asset to the Library (copy-on-save).
 *
 * With no category it goes where he saved last, or Unsorted, so the one-click
 * "Save to Library" he already knows still takes one click. Naming a category
 * files it there and makes that the new one-click place. Picking a category for
 * media that is ALREADY saved moves it there instead of refusing: he asked for
 * it to be in Battle Cats, and one copy in the right place is what he gets.
 */
export async function saveAssetToLibrary(assetId: Id, categoryId?: Id): Promise<void> {
  const asset = useStore.getState().project.assets[assetId]
  if (!asset) return
  const { items, categories, lastCategoryId } = useLibrary.getState()
  const explicit = categoryId !== undefined
  const target = saveTargetOf(explicit ? (categoryId === UNSORTED_ID ? null : categoryId) : lastCategoryId, categories)
  const existing = items.find((i) => i.name === asset.name && i.durationS === asset.durationS)
  if (existing) {
    if (explicit && categoryIdOf(existing, categories) !== target) {
      await moveLibraryItems([existing.id], target)
      await rememberSaveTarget(target)
      return
    }
    toast(`${asset.name} is already in the Library, in ${categoryLabel(categoryIdOf(existing, categories), categories)}`)
    return
  }
  const blob = await getBlob(asset.blobKey)
  if (!blob) {
    toast(`${asset.name}: media is missing from local storage`, 'danger')
    return
  }
  const id = newId()
  const item = withCategory<LibraryItem>(
    {
      id,
      name: asset.name,
      kind: asset.kind,
      blobKey: `lib/${id}`,
      durationS: asset.durationS,
      ...(asset.width !== undefined ? { width: asset.width } : {}),
      ...(asset.height !== undefined ? { height: asset.height } : {}),
      hasAudio: asset.hasAudio,
      hasVideo: asset.hasVideo,
      addedAt: Date.now(),
    },
    target,
  )
  await putBlob(item.blobKey, blob)
  // And a spare copy outside the store, the Library's second home. Never waited
  // on and never fatal, the same terms as an import's own mirror.
  void mirrorAsset(libMirrorId(id), blob)
  if (asset.thumbnailKey) {
    const thumb = await getBlob(asset.thumbnailKey)
    if (thumb) {
      item.thumbnailKey = `lib-thumb/${id}`
      await putBlob(item.thumbnailKey, thumb)
      void mirrorAsset(libThumbMirrorId(id), thumb)
    }
  }
  const d = await db()
  await d.put('library', item, id)
  useLibrary.setState((s) => ({ items: [item, ...s.items] }))
  if (explicit) await rememberSaveTarget(target)
  // "to Library" stays in every version of this line: it is how he (and the
  // end to end test) knows the save happened.
  toast(
    target === UNSORTED_ID
      ? `Saved ${asset.name} to Library`
      : `Saved ${asset.name} to Library: ${categoryLabel(target, categories)}`,
    'success',
  )
}

/**
 * The project's own copy of a Library item (copy-on-use), not yet in the
 * project. Null (and a toast) when the Library's bytes are gone.
 */
async function copyIntoProject(item: LibraryItem): Promise<MediaAsset | null> {
  const blob = await getBlob(item.blobKey)
  if (!blob) {
    toast(`${item.name}: Library media is missing`, 'danger')
    return null
  }
  const id = newId()
  const blobKey = `asset/${id}`
  await putBlob(blobKey, blob)
  const asset: MediaAsset = {
    id,
    name: item.name,
    kind: item.kind,
    blobKey,
    durationS: item.durationS,
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    hasAudio: item.hasAudio,
    hasVideo: item.hasVideo,
    codec: undefined,
  }
  if (item.thumbnailKey) {
    const thumb = await getBlob(item.thumbnailKey)
    if (thumb) {
      asset.thumbnailKey = `thumb/${id}`
      await putBlob(asset.thumbnailKey, thumb)
    }
  }
  return asset
}

/** Bring a Library item into the current project's bin (copy-on-use). */
export async function addLibraryItemToProject(itemId: Id): Promise<void> {
  const item = useLibrary.getState().items.find((i) => i.id === itemId)
  if (!item) return
  const asset = await copyIntoProject(item)
  if (!asset) return
  useStore.getState().dispatch(`Add ${item.name} from Library`, (p) => ({
    ...p,
    assets: { ...p.assets, [asset.id]: asset },
  }))
  toast(`Added ${item.name} to the project`, 'success')
}

/** Where a Library item lands on the timeline. Defaults to the playhead. */
export interface LibraryPlacement {
  atS?: number
  /** The lane it was dropped on, already checked to be the right kind. */
  trackId?: Id
  /** A drop lands exactly where it was aimed, on the next free line if taken. */
  exact?: boolean
}

/** Lay one clip of `asset` on the sequence, the way the bin's own add and drop do. */
function placeAsset(seq: Sequence, asset: MediaAsset, atS: number, place: LibraryPlacement): { seq: Sequence; clipId: Id } {
  const lanes = asset.kind === 'audio' ? audioTracks(seq) : videoTracks(seq)
  const trackId = place.trackId ?? lanes.find((t) => !t.locked)?.id
  if (!trackId) return { seq, clipId: '' }
  const opts = { exact: place.exact === true }
  if (asset.kind === 'video' && asset.hasAudio) {
    const audio = audioTracks(seq).find((t) => !t.locked) ?? null
    const r = addClipWithLinkedAudio(seq, trackId, audio?.id ?? null, asset, atS, opts)
    return { seq: r.seq, clipId: r.videoClipId }
  }
  return addClipFromAsset(seq, trackId, asset, atS, opts)
}

/**
 * Put a Library item on the timeline (Enter, the + button, or a drag). The
 * media and the clip arrive in ONE undo step, like a sound off the shelf.
 *
 * The project's copy is REUSED when it already has this media (the Library's
 * own identity, name plus duration), so dropping the same Battle Cats sound
 * ten times makes ten clips and one bin entry, not ten copies of the bytes.
 * Either way the project owns its copy: removing the Library item later can
 * never hole the edit.
 */
export async function addLibraryItemToTimeline(itemId: Id, place: LibraryPlacement = {}): Promise<void> {
  const item = useLibrary.getState().items.find((i) => i.id === itemId)
  if (!item) return
  const atS = place.atS ?? useStore.getState().ui.playheadS
  const reused = Object.values(useStore.getState().project.assets).find(
    (a) => a.kind === item.kind && a.name === item.name && a.durationS === item.durationS,
  )
  const asset = reused ?? (await copyIntoProject(item))
  if (!asset) return
  let clipId: Id = ''
  useStore.getState().dispatch(`Add ${item.name} from Library`, (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const r = placeAsset(seq, asset, atS, place)
    clipId = r.clipId
    if (!clipId && p.assets[asset.id]) return p
    return {
      ...p,
      assets: p.assets[asset.id] ? p.assets : { ...p.assets, [asset.id]: asset },
      sequences: clipId ? { ...p.sequences, [seq.id]: r.seq } : p.sequences,
    }
  })
  if (!clipId) {
    const kind = item.kind === 'audio' ? 'audio' : 'video'
    toast(
      reused ? `No unlocked ${kind} track for ${item.name}` : `No unlocked ${kind} track, so ${item.name} went to the Media bin`,
      'danger',
    )
    return
  }
  // A fresh insert lands unselected, exactly as the bin's own add does, so the
  // next edit never reads as "I singled this one half out".
  if (useStore.getState().ui.selection.length > 0) useStore.getState().setUI({ selection: [] })
}

/** Remove a Library item and ITS OWN blobs. Projects that used it keep their copies. */
export async function removeLibraryItem(itemId: Id): Promise<void> {
  const item = useLibrary.getState().items.find((i) => i.id === itemId)
  if (!item) return
  const d = await db()
  await d.delete('library', itemId)
  await d.delete('blobs', item.blobKey)
  if (item.thumbnailKey) await d.delete('blobs', item.thumbnailKey)
  useLibrary.setState((s) => ({ items: s.items.filter((i) => i.id !== itemId) }))
  useToasts.getState().show(`Removed ${item.name} from Library`)
}

// ---------------------------------------------------------------------------
// Effect presets

/** Save the selected clip's effect stack as a preset. */
export async function saveSelectionAsPreset(): Promise<void> {
  const show = useToasts.getState().show
  const { project, ui } = useStore.getState()
  const clipId = ui.selection[0]
  const clip = clipId
    ? activeSequence(project)
        .tracks.flatMap((t) => t.clips)
        .find((c) => c.id === clipId)
    : undefined
  if (!clip) return
  const preset = presetFromClip(clip, newId(), Date.now(), newId)
  if (!preset) {
    show('This clip has no effects to save')
    return
  }
  const d = await db()
  await d.put('presets', preset, preset.id)
  useLibrary.setState((s) => ({ presets: [preset, ...s.presets] }))
  show(`Saved preset "${preset.name}"`, 'success')
}

/**
 * Apply a preset to every selected clip that can take it, as ONE undo step on the
 * project stack, and say how many it went on.
 *
 * ⛔ IT USED TO TAKE THE FIRST SELECTED CLIP AND NOTHING ELSE. His words,
 * 2026-10-04: *"selecting multiple images and putting effects on them that
 * actually apply to all of them."* A preset double-clicked with three pictures
 * selected landed on one of them, the Apply row said "selected clip", and the
 * toast said "Applied" as if that were the whole job.
 */
export function applyPresetToSelection(presetId: Id): void {
  const show = useToasts.getState().show
  const preset = useLibrary.getState().presets.find((p) => p.id === presetId)
  const { project, ui, dispatch } = useStore.getState()
  if (!preset) return
  if (ui.selection.length === 0) {
    show('Select a clip first')
    return
  }
  // Sound takes no picture effect, so the audio that rides along in a selection is
  // neither changed nor counted. ⛔ A LOCKED TRACK IS REFUSED, like everywhere else
  // in the app. Clicking a clip on a locked track still selects it, on purpose, so
  // the selection this runs on can easily hold one: the preset landed on the very
  // clips he locked the track to protect, and said "Applied" as if nothing were
  // unusual. Those are named instead.
  const where = new Map<Id, { kind: string; locked: boolean }>()
  for (const t of activeSequence(project).tracks) for (const c of t.clips) where.set(c.id, { kind: t.kind, locked: t.locked })
  const visual = ui.selection.filter((id) => where.has(id) && where.get(id)!.kind === 'video')
  const targets = new Set(visual.filter((id) => !where.get(id)!.locked))
  const lockedOut = visual.length - targets.size
  if (visual.length === 0) {
    show('Effects don’t apply to audio clips', 'danger')
    return
  }
  if (targets.size === 0) {
    show(lockedOut === 1 ? 'That clip is on a locked track' : 'Those clips are on a locked track', 'danger')
    return
  }
  dispatch(`Apply preset ${preset.name}`, (p) => {
    const seq = activeSequence(p)
    const tracks = seq.tracks.map((t) =>
      t.clips.some((c) => targets.has(c.id))
        ? {
            ...t,
            clips: t.clips.map((c) =>
              // Append with fresh ids (copyEffects), never replace: a preset is
              // "add my look", and clobbering an existing grade would surprise.
              // Each clip gets its OWN copy, never one shared stack.
              targets.has(c.id) ? { ...c, effects: [...c.effects, ...copyEffects(preset.effects, newId)] } : c,
            ),
          }
        : t,
    )
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
  })
  const n = targets.size
  const left = lockedOut > 0 ? `. ${lockedLeftOut(lockedOut)}` : ''
  show(`Applied "${preset.name}"${n > 1 ? ` to ${n} clips` : ''}${left}`, 'success')
}

/**
 * Apply a preset to EVERY video clip in the active sequence, in ONE undo step.
 * Audio clips are skipped (visual effects don't apply to them). Each clip gets
 * its OWN fresh-id copy of the effects, appended (never replacing an existing
 * grade), exactly like applyPresetToSelection.
 */
export function applyPresetToAllClips(presetId: Id): void {
  const show = useToasts.getState().show
  const preset = useLibrary.getState().presets.find((p) => p.id === presetId)
  const { project, dispatch } = useStore.getState()
  if (!preset) return
  // Locked tracks are neither changed nor COUNTED. Counting them made the toast
  // over-report by however many clips he had protected.
  const targetCount = activeSequence(project)
    .tracks.filter((t) => t.kind === 'video' && !t.locked)
    .reduce((n, t) => n + t.clips.length, 0)
  if (targetCount === 0) {
    show('No video clips to apply the preset to')
    return
  }
  dispatch(`Apply preset ${preset.name} to all clips`, (p) => {
    const seq = activeSequence(p)
    const tracks = seq.tracks.map((t) =>
      t.kind !== 'video' || t.locked
        ? t
        : {
            ...t,
            clips: t.clips.map((c) => ({
              ...c,
              effects: [...c.effects, ...copyEffects(preset.effects, newId)],
            })),
          },
    )
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
  })
  show(`Applied "${preset.name}" to ${targetCount} clip${targetCount === 1 ? '' : 's'}`, 'success')
}

export async function removePreset(presetId: Id): Promise<void> {
  const preset = useLibrary.getState().presets.find((p) => p.id === presetId)
  if (!preset) return
  const d = await db()
  await d.delete('presets', presetId)
  useLibrary.setState((s) => ({ presets: s.presets.filter((p) => p.id !== presetId) }))
  useToasts.getState().show(`Removed preset "${preset.name}"`)
}

export { autoPresetName }
