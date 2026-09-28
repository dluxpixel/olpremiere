import { describe, expect, it } from 'vitest'
import {
  ALL_VIEW,
  CATEGORY_NAME_MAX,
  UNSORTED_ID,
  categoryCounts,
  categoryIdOf,
  categoryLabel,
  categoryNameProblem,
  cleanCategoryName,
  findCategoryByName,
  itemsInView,
  liveView,
  migrateLibraryItem,
  parseCategoryMeta,
  saveTargetOf,
  sortedCategories,
  withCategory,
  type LibraryCategory,
} from './libraryCategories'

const cats: LibraryCategory[] = [
  { id: 'bc', name: 'Battle Cats', createdAt: 1 },
  { id: 'mc', name: 'Minecraft', createdAt: 2 },
]

describe('parseCategoryMeta', () => {
  it('reads an install from before categories as no categories, never an error', () => {
    expect(parseCategoryMeta(undefined)).toEqual({ categories: [], lastUsedId: null })
    expect(parseCategoryMeta(null)).toEqual({ categories: [], lastUsedId: null })
    expect(parseCategoryMeta('junk')).toEqual({ categories: [], lastUsedId: null })
    expect(parseCategoryMeta({ categories: 'nope' })).toEqual({ categories: [], lastUsedId: null })
  })

  it('keeps what it can vouch for and drops the rest', () => {
    const parsed = parseCategoryMeta({
      categories: [
        { id: 'bc', name: '  Battle   Cats ', createdAt: 5 },
        { id: 'bc', name: 'Same id twice' },
        { id: 'x2', name: 'battle cats' }, // same name, other case
        { id: UNSORTED_ID, name: 'Sneaky' },
        { id: ALL_VIEW, name: 'Also sneaky' },
        { id: '', name: 'No id' },
        { id: 'blank', name: '   ' },
        { name: 'No id at all' },
        null,
        7,
        { id: 'mc', name: 'Minecraft' },
      ],
      lastUsedId: 'mc',
    })
    expect(parsed.categories).toEqual([
      { id: 'bc', name: 'Battle Cats', createdAt: 5 },
      { id: 'mc', name: 'Minecraft', createdAt: 0 },
    ])
    expect(parsed.lastUsedId).toBe('mc')
  })

  it('forgets a last-used category that is not there any more', () => {
    expect(parseCategoryMeta({ categories: cats, lastUsedId: 'gone' }).lastUsedId).toBeNull()
    expect(parseCategoryMeta({ categories: cats, lastUsedId: 42 }).lastUsedId).toBeNull()
  })
})

describe('category names', () => {
  it('cleans spaces and caps the length', () => {
    expect(cleanCategoryName('  Battle \n  Cats  ')).toBe('Battle Cats')
    expect(cleanCategoryName('x'.repeat(100))).toHaveLength(CATEGORY_NAME_MAX)
  })

  it('says why a name will not do', () => {
    expect(categoryNameProblem('   ', cats)).toBe('Type a name first')
    expect(categoryNameProblem('unsorted', cats)).toMatch(/Pick another name/)
    expect(categoryNameProblem('All', cats)).toMatch(/Pick another name/)
    expect(categoryNameProblem('battle cats', cats)).toBe('You already have Battle Cats')
    expect(categoryNameProblem('Clash Royale', cats)).toBeNull()
  })

  it('lets a category keep its own name when renamed', () => {
    expect(categoryNameProblem('Battle Cats', cats, 'bc')).toBeNull()
    expect(categoryNameProblem('BATTLE CATS', cats, 'bc')).toBeNull()
    expect(categoryNameProblem('Minecraft', cats, 'bc')).toBe('You already have Minecraft')
  })

  it('finds a category by name whatever the case', () => {
    expect(findCategoryByName(cats, ' minecraft ')?.id).toBe('mc')
    expect(findCategoryByName(cats, 'Fortnite')).toBeUndefined()
  })

  it('sorts A to Z without caring about case', () => {
    const list = sortedCategories([...cats, { id: 'a', name: 'among us', createdAt: 3 }])
    expect(list.map((c) => c.name)).toEqual(['among us', 'Battle Cats', 'Minecraft'])
  })
})

describe('where an item is filed', () => {
  it('reads a missing, blank or deleted category as Unsorted', () => {
    expect(categoryIdOf({}, cats)).toBe(UNSORTED_ID)
    expect(categoryIdOf({ categoryId: '' }, cats)).toBe(UNSORTED_ID)
    expect(categoryIdOf({ categoryId: 'deleted-one' }, cats)).toBe(UNSORTED_ID)
    expect(categoryIdOf({ categoryId: 42 }, cats)).toBe(UNSORTED_ID)
    expect(categoryIdOf({ categoryId: 'bc' }, cats)).toBe('bc')
  })

  it('names every place', () => {
    expect(categoryLabel(ALL_VIEW, cats)).toBe('All')
    expect(categoryLabel(UNSORTED_ID, cats)).toBe('Unsorted')
    expect(categoryLabel('bc', cats)).toBe('Battle Cats')
  })

  it('counts every place, Unsorted and All included', () => {
    const counts = categoryCounts([{ categoryId: 'bc' }, { categoryId: 'bc' }, {}, { categoryId: 'gone' }], cats)
    expect(counts.get(ALL_VIEW)).toBe(4)
    expect(counts.get('bc')).toBe(2)
    expect(counts.get('mc')).toBe(0)
    expect(counts.get(UNSORTED_ID)).toBe(2)
  })
})

describe('itemsInView', () => {
  const items = [
    { name: 'meow.wav', categoryId: 'bc' },
    { name: 'boss theme.mp3', categoryId: 'bc' },
    { name: 'creeper hiss.wav', categoryId: 'mc' },
    { name: 'intro.mp4' },
  ]

  it('shows everything on All and one place otherwise, in the order given', () => {
    expect(itemsInView(items, cats, ALL_VIEW, '')).toHaveLength(4)
    expect(itemsInView(items, cats, 'bc', '').map((i) => i.name)).toEqual(['meow.wav', 'boss theme.mp3'])
    expect(itemsInView(items, cats, UNSORTED_ID, '').map((i) => i.name)).toEqual(['intro.mp4'])
  })

  it('narrows by the quick filter, which also knows category names', () => {
    expect(itemsInView(items, cats, ALL_VIEW, 'WAV').map((i) => i.name)).toEqual(['meow.wav', 'creeper hiss.wav'])
    expect(itemsInView(items, cats, 'bc', 'boss').map((i) => i.name)).toEqual(['boss theme.mp3'])
    expect(itemsInView(items, cats, ALL_VIEW, 'battle').map((i) => i.name)).toEqual(['meow.wav', 'boss theme.mp3'])
    expect(itemsInView(items, cats, 'mc', 'meow')).toEqual([])
  })
})

describe('the one-click save target', () => {
  it('is the last category used while it exists, else Unsorted', () => {
    expect(saveTargetOf('bc', cats)).toBe('bc')
    expect(saveTargetOf(null, cats)).toBe(UNSORTED_ID)
    expect(saveTargetOf('deleted-one', cats)).toBe(UNSORTED_ID)
  })

  it('never leaves the Library tab on a category that is gone', () => {
    expect(liveView('bc', cats)).toBe('bc')
    expect(liveView(UNSORTED_ID, cats)).toBe(UNSORTED_ID)
    expect(liveView('deleted-one', cats)).toBe(ALL_VIEW)
  })
})

describe('filing and the migration', () => {
  const old: { id: string; name: string; addedAt: number; categoryId?: string } = { id: 'i1', name: 'meow.wav', addedAt: 3 }

  it('files into a category, and Unsorted takes the field away again', () => {
    const filed = withCategory(old, 'bc')
    expect(filed).toEqual({ ...old, categoryId: 'bc' })
    const back = withCategory(filed, UNSORTED_ID)
    expect(back).toEqual(old)
    expect('categoryId' in back).toBe(false)
  })

  it('leaves an item saved before categories exactly as it was', () => {
    expect(migrateLibraryItem(old)).toBe(old)
    const filed = { ...old, categoryId: 'bc' }
    expect(migrateLibraryItem(filed)).toBe(filed)
  })

  it('drops only a category field that cannot be used, keeping everything else', () => {
    for (const bad of [42, '', null, UNSORTED_ID, ALL_VIEW]) {
      const item = migrateLibraryItem({ ...old, categoryId: bad as unknown })
      expect(item).toEqual(old)
    }
  })
})
