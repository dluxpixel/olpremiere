// The right-click menu rows that file media into his Library categories. One
// builder for every surface (the media card, the timeline clip, a Library
// card), so the list of places reads the same everywhere he meets it.

import type { Id } from '../engine/types'
import type { MenuItem } from './contextMenu'
import {
  moveLibraryItems,
  moveLibraryItemsToNewCategory,
  saveAssetToLibrary,
  saveAssetToNewCategory,
  useLibrary,
} from './library'
import { UNSORTED_ID, UNSORTED_NAME, saveTargetOf, sortedCategories } from './libraryCategories'

/** Unsorted, then his categories A to Z, then "New category...". */
function placeItems(checkedId: Id | null, pick: (categoryId: Id) => void, pickNew: () => void): MenuItem[] {
  const { categories } = useLibrary.getState()
  return [
    { label: UNSORTED_NAME, checked: checkedId === UNSORTED_ID, onClick: () => pick(UNSORTED_ID) },
    ...sortedCategories(categories).map((c) => ({
      label: c.name,
      checked: checkedId === c.id,
      onClick: () => pick(c.id),
    })),
    { label: 'New category...', separator: true, onClick: pickNew },
  ]
}

/**
 * Where a save can go. The tick marks where a one-click "Save to Library"
 * would put it, so the flyout also answers "where did my last one go?".
 */
export function saveToCategoryItems(assetId: Id): MenuItem[] {
  const { categories, lastCategoryId } = useLibrary.getState()
  return placeItems(
    saveTargetOf(lastCategoryId, categories),
    (categoryId) => void saveAssetToLibrary(assetId, categoryId),
    () => void saveAssetToNewCategory(assetId),
  )
}

/** Where a Library item can move. The tick marks where it is now. */
export function moveToCategoryItems(itemIds: readonly Id[], currentId: Id | null): MenuItem[] {
  return placeItems(
    currentId,
    (categoryId) => void moveLibraryItems(itemIds, categoryId),
    () => void moveLibraryItemsToNewCategory(itemIds),
  )
}

/**
 * The one-click save's hint: the category it will land in, when not Unsorted.
 * Takes the Library state so a component can use it as a selector.
 */
export function oneClickSaveHint(
  { categories, lastCategoryId }: Pick<ReturnType<typeof useLibrary.getState>, 'categories' | 'lastCategoryId'> = useLibrary.getState(),
): string | undefined {
  const target = saveTargetOf(lastCategoryId, categories)
  return target === UNSORTED_ID ? undefined : categories.find((c) => c.id === target)?.name
}
