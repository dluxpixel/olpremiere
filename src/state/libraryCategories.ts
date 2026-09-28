// Library categories he names, as plain data rules with no storage in them.
//
// His words, 2026-09-28: *"add to the planner that we can save content like
// music, sound effects, and stuff like that for different categories that I can
// name. For example, when I want to save a sound effect for Battle Cats, I can."*
//
// The shape is deliberately small. A category is a name and an id. An item says
// which category it is in with an optional `categoryId` on its OWN record, so no
// item ever lives in two places at once and no index can drift from the items.
// "Unsorted" is not stored anywhere: it is simply every item whose category is
// missing or gone. That one rule is the whole migration (every item saved
// before 2026-09-28 has no categoryId, so it reads as Unsorted, with nothing
// rewritten), and it is also the safety net, because an item can never point at
// a category that vanished and disappear with it.

import { matchesQuery } from '../engine/effects/search'
import type { Id } from '../engine/types'

export interface LibraryCategory {
  id: Id
  name: string
  createdAt: number
}

/** The categories plus the one he saved into last, as kept in the 'meta' store. */
export interface CategoryMeta {
  categories: LibraryCategory[]
  /** Where a one-click "Save to Library" goes. Null means Unsorted. */
  lastUsedId: Id | null
}

/** The 'meta' store key the categories live under. */
export const CATEGORY_META_KEY = 'libraryCategories'

/** Unsorted is a place, not a record. Never a real category id. */
export const UNSORTED_ID = 'unsorted'
export const UNSORTED_NAME = 'Unsorted'
/** The Library view that shows every item, whatever its category. */
export const ALL_VIEW = 'all'
/** What the Library tab is showing: everything, Unsorted, or one category's id. */
export type LibraryView = string

/** Long enough for "Battle Cats boss fights", short enough to fit the panel. */
export const CATEGORY_NAME_MAX = 40

const RESERVED = new Set([UNSORTED_ID, ALL_VIEW])

/**
 * Read whatever the 'meta' store holds for the categories, never throwing.
 *
 * A missing record is a normal install from before categories existed. A record
 * that is broken in any way keeps only the categories it can still vouch for,
 * because the worst thing this can do is lose his Library to a bad byte: the
 * items themselves are never read from here, so at worst they show as Unsorted.
 */
export function parseCategoryMeta(raw: unknown): CategoryMeta {
  const empty: CategoryMeta = { categories: [], lastUsedId: null }
  if (!raw || typeof raw !== 'object') return empty
  const r = raw as { categories?: unknown; lastUsedId?: unknown }
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const categories: LibraryCategory[] = []
  for (const c of Array.isArray(r.categories) ? r.categories : []) {
    if (!c || typeof c !== 'object') continue
    const { id, name, createdAt } = c as { id?: unknown; name?: unknown; createdAt?: unknown }
    if (typeof id !== 'string' || id === '' || RESERVED.has(id) || seenIds.has(id)) continue
    if (typeof name !== 'string') continue
    const clean = cleanCategoryName(name)
    if (clean === '' || seenNames.has(clean.toLowerCase())) continue
    seenIds.add(id)
    seenNames.add(clean.toLowerCase())
    categories.push({ id, name: clean, createdAt: typeof createdAt === 'number' ? createdAt : 0 })
  }
  const lastUsedId =
    typeof r.lastUsedId === 'string' && categories.some((c) => c.id === r.lastUsedId) ? r.lastUsedId : null
  return { categories, lastUsedId }
}

/** Trim, fold runs of spaces, and cap the length. */
export function cleanCategoryName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, CATEGORY_NAME_MAX).trim()
}

/** The category with this name, ignoring case and extra spaces. */
export function findCategoryByName(
  categories: readonly LibraryCategory[],
  name: string,
): LibraryCategory | undefined {
  const want = cleanCategoryName(name).toLowerCase()
  return categories.find((c) => c.name.toLowerCase() === want)
}

/**
 * Why this name cannot be used, in words he can act on, or null when it can.
 * `exceptId` is the category being renamed, so keeping its own name is fine.
 */
export function categoryNameProblem(
  raw: string,
  categories: readonly LibraryCategory[],
  exceptId?: Id,
): string | null {
  const name = cleanCategoryName(raw)
  if (name === '') return 'Type a name first'
  if (RESERVED.has(name.toLowerCase())) return `${name} is already there. Pick another name`
  const clash = findCategoryByName(categories, name)
  if (clash && clash.id !== exceptId) return `You already have ${clash.name}`
  return null
}

/** Where an item is filed. Missing, blank or gone all mean Unsorted. */
export function categoryIdOf(item: { categoryId?: unknown }, categories: readonly LibraryCategory[]): Id {
  const id = item.categoryId
  return typeof id === 'string' && categories.some((c) => c.id === id) ? id : UNSORTED_ID
}

/** A category id as the words to show him. */
export function categoryLabel(id: Id, categories: readonly LibraryCategory[]): string {
  if (id === ALL_VIEW) return 'All'
  return categories.find((c) => c.id === id)?.name ?? UNSORTED_NAME
}

/** A to Z, ignoring case, so a long list reads like an index. */
export function sortedCategories(categories: readonly LibraryCategory[]): LibraryCategory[] {
  return [...categories].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** How many items each place holds: every category, Unsorted, and All. */
export function categoryCounts(
  items: readonly { categoryId?: unknown }[],
  categories: readonly LibraryCategory[],
): Map<Id, number> {
  const counts = new Map<Id, number>([
    [ALL_VIEW, items.length],
    [UNSORTED_ID, 0],
  ])
  for (const c of categories) counts.set(c.id, 0)
  for (const item of items) {
    const id = categoryIdOf(item, categories)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** The items one view shows, narrowed by the quick filter. Order is kept. */
export function itemsInView<T extends { name: string; categoryId?: unknown }>(
  items: readonly T[],
  categories: readonly LibraryCategory[],
  view: LibraryView,
  query: string,
): T[] {
  return items.filter(
    (item) =>
      (view === ALL_VIEW || categoryIdOf(item, categories) === view) &&
      matchesQuery(query, item.name, categoryLabel(categoryIdOf(item, categories), categories)),
  )
}

/** Where a one-click save goes: the category he used last, while it still exists. */
export function saveTargetOf(lastUsedId: Id | null, categories: readonly LibraryCategory[]): Id {
  return lastUsedId !== null && categories.some((c) => c.id === lastUsedId) ? lastUsedId : UNSORTED_ID
}

/** A view that no longer exists (its category was deleted) falls back to All. */
export function liveView(view: LibraryView, categories: readonly LibraryCategory[]): LibraryView {
  return view === ALL_VIEW || view === UNSORTED_ID || categories.some((c) => c.id === view) ? view : ALL_VIEW
}

/**
 * The same item filed somewhere else. Filing into Unsorted REMOVES the field,
 * so an Unsorted item has exactly the shape an item saved before categories
 * had, and there is only one way to be Unsorted on disk.
 */
export function withCategory<T extends { categoryId?: Id }>(item: T, categoryId: Id): T {
  const next = { ...item }
  delete next.categoryId
  return categoryId === UNSORTED_ID ? next : { ...next, categoryId }
}

/**
 * An item record as it comes out of storage, made safe to use. Everything he
 * saved stays exactly as it was; only a categoryId that is not a usable string
 * is dropped, which files the item under Unsorted.
 */
export function migrateLibraryItem<T extends { categoryId?: unknown }>(raw: T): T {
  if (raw.categoryId === undefined) return raw
  if (typeof raw.categoryId === 'string' && raw.categoryId !== '' && !RESERVED.has(raw.categoryId)) return raw
  const next = { ...raw }
  delete next.categoryId
  return next
}
