import { describe, expect, it } from 'vitest'

import { BROWSABLE_EFFECTS } from './registry'
import { filterEffects, matchesQuery } from './search'

const labels = (q: string) => filterEffects(q).map((e) => e.label)

describe('filterEffects', () => {
  it('an empty box is not a filter', () => {
    expect(filterEffects('')).toHaveLength(BROWSABLE_EFFECTS.length)
    expect(filterEffects('   ')).toHaveLength(BROWSABLE_EFFECTS.length)
  })

  it('finds by label, whatever the case', () => {
    expect(labels('blur').length).toBeGreaterThan(0)
    expect(labels('BLUR')).toEqual(labels('blur'))
  })

  // ⛔ The reason the description is in the haystack at all. A search that only
  // reads labels needs him to already know the name of the thing he wants.
  // "bloom" is nowhere in the word Glow, and "greyscale" is nowhere in
  // Saturation, so neither was reachable before.
  it('finds by what an effect DOES, not only by its name', () => {
    const bloom = filterEffects('bloom')
    expect(bloom.map((e) => e.label)).toContain('Glow')
    const grey = filterEffects('greyscale')
    expect(grey.map((e) => e.label)).toContain('Saturation')
    // And the label route still works, so nothing was traded away for it.
    expect(filterEffects('glow').map((e) => e.label)).toContain('Glow')
  })

  it('narrows on every word rather than widening', () => {
    const one = filterEffects('mid')
    const two = filterEffects('mid grey')
    expect(two.length).toBeLessThanOrEqual(one.length)
    for (const e of two) expect(one).toContain(e)
  })

  it('says nothing matched instead of everything', () => {
    expect(filterEffects('zzzznotathing')).toHaveLength(0)
  })

  it('keeps registry order, so the list never reshuffles under him', () => {
    const all = filterEffects('')
    const order = BROWSABLE_EFFECTS.map((e) => e.type)
    expect(all.map((e) => e.type)).toEqual(order)
  })

  it('hands back a copy, so a caller sorting it cannot reorder the registry', () => {
    const a = filterEffects('')
    a.reverse()
    expect(filterEffects('')[0]?.type).toBe(BROWSABLE_EFFECTS[0]?.type)
  })
})

describe('matchesQuery', () => {
  it('is the same rule, for the lists that are not effects', () => {
    expect(matchesQuery('', 'anything')).toBe(true)
    expect(matchesQuery('cross', 'Cross dissolve', 'crossDissolve')).toBe(true)
    expect(matchesQuery('cross flash', 'Cross dissolve', 'crossDissolve')).toBe(false)
  })
})
