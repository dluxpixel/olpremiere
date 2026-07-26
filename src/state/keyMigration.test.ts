import { describe, expect, it } from 'vitest'
import { RENAMED_KEYS, migrateRenamedKeys } from './keyMigration'

/** A minimal in-memory Storage stand-in (the node env has no localStorage). */
function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

describe('migrateRenamedKeys', () => {
  it('carries a legacy value onto the new key and drops the old one', () => {
    const s = fakeStore({ 'reel:settings:theme': 'dark' })
    expect(migrateRenamedKeys(s)).toBe(1)
    expect(s.getItem('olpremiere:settings:theme')).toBe('dark')
    expect(s.getItem('reel:settings:theme')).toBeNull()
  })

  it('keeps user-MADE content, not just preferences', () => {
    // The presets are the reason this exists: losing a theme is an annoyance,
    // losing saved text/track presets is losing something the user built.
    const presets = JSON.stringify([{ id: 'a' }])
    const s = fakeStore({ 'reel:textPresets': presets, 'reel:track-presets': presets })
    migrateRenamedKeys(s)
    expect(s.getItem('olpremiere:textPresets')).toBe(presets)
    expect(s.getItem('olpremiere:track-presets')).toBe(presets)
  })

  it('never overwrites a value already stored under the new name', () => {
    const s = fakeStore({ 'reel:settings:theme': 'dark', 'olpremiere:settings:theme': 'light' })
    expect(migrateRenamedKeys(s)).toBe(0)
    expect(s.getItem('olpremiere:settings:theme')).toBe('light')
    // ...and still clears the legacy key, so this cannot run again next boot.
    expect(s.getItem('reel:settings:theme')).toBeNull()
  })

  it('is a no-op on a fresh machine, and idempotent', () => {
    const s = fakeStore()
    expect(migrateRenamedKeys(s)).toBe(0)
    const seeded = fakeStore({ 'reel:quickstart': 'done' })
    migrateRenamedKeys(seeded)
    expect(migrateRenamedKeys(seeded)).toBe(0)
    expect(seeded.getItem('olpremiere:quickstart')).toBe('done')
  })

  it('survives a storage that throws (private mode, blocked origin)', () => {
    const hostile = {
      getItem: () => 'x',
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => migrateRenamedKeys(hostile)).not.toThrow()
  })

  it('every mapped key renames reel -> olpremiere and nothing else', () => {
    for (const [next, legacy] of Object.entries(RENAMED_KEYS)) {
      expect(legacy.startsWith('reel')).toBe(true)
      expect(next.startsWith('olpremiere')).toBe(true)
      // The suffix must be identical, or a rename would quietly become a move
      // to a different setting.
      expect(next.replace(/^olpremiere/, '')).toBe(legacy.replace(/^reel/, ''))
    }
  })
})
