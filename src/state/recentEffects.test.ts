import { describe, expect, it } from 'vitest'

import { RECENT_CAP, noteRecentEffect, onShelf, useRecentEffects, withRecent } from './recentEffects'

describe('withRecent', () => {
  it('puts the newest first', () => {
    expect(withRecent([], 'blur')).toEqual(['blur'])
    expect(withRecent(['blur'], 'glow')).toEqual(['glow', 'blur'])
  })

  it('moves a repeat to the front instead of listing it twice', () => {
    // Reaching for the same blur all afternoon must not fill the list with it.
    expect(withRecent(['glow', 'blur'], 'blur')).toEqual(['blur', 'glow'])
    expect(withRecent(['glow', 'blur', 'vignette'], 'blur')).toEqual(['blur', 'glow', 'vignette'])
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

// His call, 2026-10-12: "sharpen is a really bad setting that just makes my videos look
// bad quality". Sharpen is off the shelf, so it may not ride in the Recent row either.
describe('the Recent row only holds what is on the shelf', () => {
  it('drops Sharpen and anything unknown from a saved list, keeping the order', () => {
    expect(onShelf(['gaussianBlur', 'sharpen', 'glow', 'thisEffectDoesNotExist', 'vignette'])).toEqual([
      'gaussianBlur',
      'glow',
      'vignette',
    ])
  })

  it('does not remember Sharpen when it is applied to a clip that already carries it', () => {
    useRecentEffects.setState({ types: ['glow'] })
    noteRecentEffect('sharpen')
    expect(useRecentEffects.getState().types).toEqual(['glow'])
    noteRecentEffect('vignette')
    expect(useRecentEffects.getState().types).toEqual(['vignette', 'glow'])
  })
})
