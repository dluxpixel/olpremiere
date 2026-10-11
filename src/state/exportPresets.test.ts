// @vitest-environment jsdom
//
// Export presets live in the app's own preferences: they are made, renamed,
// changed and deleted here, they survive a restart, and the preferences file
// carries them too (prefsHome.ts), so a wiped profile gets them back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})
afterEach(() => {
  localStorage.clear()
})

/** A fresh module, as the next start would load it. */
const load = () => import('./exportPresets')

describe('export presets', () => {
  it('start empty: there are no built in presets', async () => {
    const { useExportPresets } = await load()
    expect(useExportPresets.getState().presets).toEqual([])
    expect(localStorage.getItem('olpremiere:export-presets')).toBeNull()
  })

  it('create: a name, the setting as it is now and no folder yet', async () => {
    const { createPreset, useExportPresets } = await load()
    const p = createPreset('  Gym   ', false)
    expect(p).toMatchObject({ name: 'Gym', folder: null, platformLoudness: false })
    expect(useExportPresets.getState().presets).toHaveLength(1)
  })

  it('create: a blank name makes nothing', async () => {
    const { createPreset, useExportPresets } = await load()
    expect(createPreset('   ', true)).toBeNull()
    expect(createPreset('\n\t', true)).toBeNull()
    expect(useExportPresets.getState().presets).toEqual([])
  })

  it('create: a name that is taken gets a number, like the files do', async () => {
    const { createPreset } = await load()
    createPreset('Gym', true)
    expect(createPreset('gym', true)?.name).toBe('gym 2')
    expect(createPreset('Gym', true)?.name).toBe('Gym 3')
  })

  it('rename: changes the label, refuses a blank one, never collides with another', async () => {
    const { createPreset, renamePreset, useExportPresets } = await load()
    const a = createPreset('Gym', true)!
    const b = createPreset('Vlog', true)!
    expect(renamePreset(a.id, 'Leg day')).toBe(true)
    expect(renamePreset(a.id, '   ')).toBe(false)
    expect(renamePreset(b.id, 'leg day')).toBe(true)
    const names = useExportPresets.getState().presets.map((p) => p.name)
    expect(names).toEqual(['Leg day', 'leg day 2'])
    expect(renamePreset('nope', 'X')).toBe(false)
  })

  it('update: changes the setting it remembers and leaves the rest', async () => {
    const { createPreset, setPresetFolder, updatePresetSettings, useExportPresets } = await load()
    const a = createPreset('Gym', true)!
    setPresetFolder(a.id, 'D:/Videos/Gym')
    updatePresetSettings(a.id, { platformLoudness: false })
    expect(useExportPresets.getState().presets[0]).toMatchObject({
      name: 'Gym',
      folder: 'D:/Videos/Gym',
      platformLoudness: false,
    })
  })

  it('folder: set, change and forget', async () => {
    const { createPreset, setPresetFolder, findPreset } = await load()
    const a = createPreset('Gym', true)!
    setPresetFolder(a.id, 'D:/Videos/Gym')
    expect(findPreset(a.id)?.folder).toBe('D:/Videos/Gym')
    setPresetFolder(a.id, 'E:/Other')
    expect(findPreset(a.id)?.folder).toBe('E:/Other')
    setPresetFolder(a.id, null)
    expect(findPreset(a.id)?.folder).toBeNull()
    setPresetFolder(a.id, '   ')
    expect(findPreset(a.id)?.folder).toBeNull()
  })

  it('delete: removes only that one, and the last one leaves nothing stored', async () => {
    const { createPreset, deletePreset, useExportPresets } = await load()
    const a = createPreset('Gym', true)!
    const b = createPreset('Vlog', true)!
    deletePreset(a.id)
    expect(useExportPresets.getState().presets.map((p) => p.name)).toEqual(['Vlog'])
    deletePreset('nope')
    expect(useExportPresets.getState().presets).toHaveLength(1)
    deletePreset(b.id)
    expect(localStorage.getItem('olpremiere:export-presets')).toBeNull()
  })

  it('⛔ survives a restart, with everything in it', async () => {
    const first = await load()
    const a = first.createPreset('Gym', false)!
    first.setPresetFolder(a.id, 'D:/Videos/Gym')
    first.createPreset('Vlog', true)
    vi.resetModules()
    const second = await load()
    expect(second.useExportPresets.getState().presets).toEqual([
      { id: a.id, name: 'Gym', folder: 'D:/Videos/Gym', platformLoudness: false },
      expect.objectContaining({ name: 'Vlog', folder: null, platformLoudness: true }),
    ])
  })

  it('a damaged store reads as no presets, and a bad row costs only itself', async () => {
    const { parsePresets } = await load()
    expect(parsePresets('not json')).toEqual([])
    expect(parsePresets('{"a":1}')).toEqual([])
    expect(parsePresets(null)).toEqual([])
    const rows = JSON.stringify([
      { id: 'a', name: 'Gym', folder: 'D:/G', platformLoudness: false },
      { id: 'b', name: '   ' },
      { name: 'No id' },
      7,
      null,
      { id: 'a', name: 'Same id again' },
      { id: 'c', name: 'Gym', folder: 5 },
    ])
    expect(parsePresets(rows)).toEqual([
      { id: 'a', name: 'Gym', folder: 'D:/G', platformLoudness: false },
      { id: 'c', name: 'Gym 2', folder: null, platformLoudness: true },
    ])
  })

  it('a change tells the preferences file, and the file carries the list', async () => {
    const { createPreset } = await load()
    const { onPrefsChanged } = await import('./prefsSignal')
    const { PREFS_KEYS } = await import('./prefsHome')
    const told = vi.fn()
    onPrefsChanged(told)
    createPreset('Gym', true)
    expect(told).toHaveBeenCalledTimes(1)
    expect(PREFS_KEYS).toContain('olpremiere:export-presets')
    onPrefsChanged(null)
  })

  it('⛔ a wiped profile gets its presets back from the preferences file', async () => {
    const { parsePrefs, initPrefsHome, resetPrefsHomeForTests } = await import('./prefsHome')
    const rows = JSON.stringify([{ id: 'a', name: 'Gym', folder: 'D:/Videos/Gym', platformLoudness: false }])
    const file = JSON.stringify({
      kind: 'ol-premiere-preferences',
      version: 1,
      savedAt: Date.now() + 1000,
      values: { 'olpremiere:export-presets': rows },
    })
    expect(parsePrefs(file)?.values['olpremiere:export-presets']).toBe(rows)
    resetPrefsHomeForTests()
    ;(window as unknown as { api: unknown }).api = { prefsRead: async () => file, prefsWrite: async () => undefined }
    await initPrefsHome()
    const { useExportPresets } = await load()
    expect(useExportPresets.getState().presets).toEqual([
      { id: 'a', name: 'Gym', folder: 'D:/Videos/Gym', platformLoudness: false },
    ])
    resetPrefsHomeForTests()
    Reflect.deleteProperty(window, 'api')
  })
})
