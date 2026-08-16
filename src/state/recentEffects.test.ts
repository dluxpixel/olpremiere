import { describe, expect, it } from 'vitest'

import { RECENT_CAP, withRecent } from './recentEffects'

describe('withRecent', () => {
  it('puts the newest first', () => {
    expect(withRecent([], 'blur')).toEqual(['blur'])
    expect(withRecent(['blur'], 'glow')).toEqual(['glow', 'blur'])
  })

  it('moves a repeat to the front instead of listing it twice', () => {
    // Reaching for the same blur all afternoon must not fill the list with it.
    expect(withRecent(['glow', 'blur'], 'blur')).toEqual(['blur', 'glow'])
    expect(withRecent(['glow', 'blur', 'sharpen'], 'blur')).toEqual(['blur', 'glow', 'sharpen'])
  })

  it('never grows past the cap', () => {
    let list: string[] = []
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) list = withRecent(list, t)
    expect(list).toHaveLength(RECENT_CAP)
    expect(list[0]).toBe('g')
    // The oldest fell off the end, which is the point of a recents list.
    expect(list).not.toContain('a')
  })
})
