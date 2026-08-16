import { describe, expect, it } from 'vitest'

import { addMenuRows, highlightedRow, nextHighlight } from './addMenu'
import { BROWSABLE_EFFECTS } from './registry'
import { filterEffects } from './search'

// Taken off the registry rather than typed in, so a renamed effect cannot turn
// this file red for a reason that has nothing to do with the menu.
const first = BROWSABLE_EFFECTS[0]
const second = BROWSABLE_EFFECTS[1]

describe('addMenuRows', () => {
  it('with no recents, it is the whole browsable registry', () => {
    const rows = addMenuRows('', [])
    expect(rows).toHaveLength(BROWSABLE_EFFECTS.length)
    expect(rows.every((r) => r.group === 'all')).toBe(true)
  })

  it('puts recents at the top, newest first, and repeats them below', () => {
    const rows = addMenuRows('', [second.type, first.type])
    expect(rows.slice(0, 2).map((r) => r.type)).toEqual([second.type, first.type])
    expect(rows.slice(0, 2).every((r) => r.group === 'recent')).toBe(true)
    // The repeat under All is deliberate: the shortcut at the top does not take
    // the effect out of the list he scrolls.
    expect(rows).toHaveLength(BROWSABLE_EFFECTS.length + 2)
  })

  // ⛔ The recent list is persisted to his machine and the registry is not, so
  // the two can disagree after an effect is retired.
  it('drops a recent type the registry no longer browses', () => {
    const rows = addMenuRows('', ['thisEffectDoesNotExist', first.type])
    const recents = rows.filter((r) => r.group === 'recent')
    expect(recents.map((r) => r.type)).toEqual([first.type])
  })

  it('filters both groups with the same query the Effects browser uses', () => {
    const rows = addMenuRows(first.label, [first.type])
    const all = rows.filter((r) => r.group === 'all').map((r) => r.type)
    expect(all).toEqual(filterEffects(first.label).map((e) => e.type))
    expect(rows[0]).toMatchObject({ type: first.type, group: 'recent' })
  })

  it('a query that matches nothing gives no rows at all', () => {
    expect(addMenuRows('zzzzzznotaneffect', [first.type])).toEqual([])
  })

  it('carries the description, which is what makes the search worth having', () => {
    const rows = addMenuRows('', [])
    expect(rows.every((r) => typeof r.description === 'string')).toBe(true)
    expect(rows.some((r) => r.description.length > 0)).toBe(true)
  })
})

describe('nextHighlight', () => {
  it('steps down and back up', () => {
    expect(nextHighlight(5, 0, 1)).toBe(1)
    expect(nextHighlight(5, 3, -1)).toBe(2)
  })

  it('wraps at both ends rather than dying at them', () => {
    expect(nextHighlight(5, 4, 1)).toBe(0)
    expect(nextHighlight(5, 0, -1)).toBe(4)
  })

  it('an empty list has nothing to highlight', () => {
    expect(nextHighlight(0, 0, 1)).toBe(-1)
    expect(nextHighlight(0, -1, -1)).toBe(-1)
  })

  it('the first press down from nothing lands on the first row', () => {
    expect(nextHighlight(5, -1, 1)).toBe(0)
    expect(nextHighlight(5, -1, -1)).toBe(4)
  })
})

describe('highlightedRow', () => {
  it('is the row Enter would apply', () => {
    const rows = addMenuRows('', [])
    expect(highlightedRow(rows, 0)?.type).toBe(rows[0].type)
  })

  it('is nothing when the query matched nothing', () => {
    expect(highlightedRow([], -1)).toBeUndefined()
    expect(highlightedRow(addMenuRows('', []), -1)).toBeUndefined()
  })
})
