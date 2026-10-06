/**
 * @vitest-environment jsdom
 *
 * jsdom for localStorage and the theme attribute on <html>.
 */

// His moves, track setups and settings come back after the browser profile is
// wiped. Caption styles already did (captionStyles.ts); these lived only in
// localStorage and came back as nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listMyMoves } from './myMoves'
import {
  initPrefsHome,
  parsePrefs,
  PREFS_SAVED_AT_KEY,
  prefsDecision,
  resetPrefsHomeForTests,
  type PrefsSnapshot,
} from './prefsHome'
import { setPlatformLoudness, useSettings } from './settings'
import { useStore } from './store'
import { listTrackPresets } from './trackTemplate'

const toasts: string[] = []
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))

/** Two moves and one track setup, in the shapes their own modules store. */
const beat = { at: { frames: 0 }, d: 1.2, aim: { x: 0.5, y: 0.4 }, curve: 'snapIn' }
const MOVES = JSON.stringify([
  { id: 'mym-a', name: 'Slam', def: { id: 'mym-a', name: 'Slam', window: 'moment', beats: [beat] } },
  { id: 'mym-b', name: 'Drift', def: { id: 'mym-b', name: 'Drift', window: 'clip', beats: [beat] } },
])
const PRESETS = JSON.stringify({
  presets: [{ id: 'tp-1', name: 'Gym', tracks: [{ kind: 'video', name: 'V1', volumeDb: 0, pan: 0 }] }],
  defaultId: 'tp-1',
})

function fileWith(values: Record<string, string>, savedAt = 5000): string {
  const snap: PrefsSnapshot = { kind: 'ol-premiere-preferences', version: 1, savedAt, values }
  return JSON.stringify(snap)
}

let fileText: string | null = null
const writes: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  toasts.length = 0
  writes.length = 0
  fileText = null
  resetPrefsHomeForTests()
  Object.assign(window, {
    api: {
      prefsRead: async () => fileText,
      prefsWrite: async (json: string) => void writes.push(json),
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('prefsDecision', () => {
  const file = (savedAt: number, values: Record<string, string> = { 'olpremiere:my-moves': '[]' }) =>
    parsePrefs(fileWith(values, savedAt))

  it('takes the file back when it is newer than the quick copy and holds something of his', () => {
    expect(prefsDecision({ values: {}, savedAt: 0 }, file(10))).toBe('adopt-file')
  })

  it('keeps the quick copy when it is the newer one, and brings the file up to it', () => {
    expect(prefsDecision({ values: { 'olpremiere:snapping': '0' }, savedAt: 20 }, file(10))).toBe('write-file')
  })

  it('a launch with nothing of his never writes over the file', () => {
    expect(prefsDecision({ values: {}, savedAt: 0 }, null)).toBe('nothing')
    expect(prefsDecision({ values: {}, savedAt: 30 }, file(10))).toBe('nothing')
  })

  it('refuses a file that is not one of these, and keys it does not know', () => {
    expect(parsePrefs('{"kind":"something else","version":1,"savedAt":1,"values":{}}')).toBeNull()
    expect(parsePrefs('not json')).toBeNull()
    expect(parsePrefs(fileWith({ 'olpremiere:snapping': '0', 'evil:key': 'x' }))?.values).toEqual({
      'olpremiere:snapping': '0',
    })
  })
})

describe('after the profile is wiped', () => {
  it('his moves, his track setup and his settings come back from the file, and he is told once', async () => {
    fileText = fileWith({
      'olpremiere:my-moves': MOVES,
      'olpremiere:track-presets': PRESETS,
      'olpremiere:settings:theme': 'light',
      'olpremiere:snapping': '0',
    })
    // The wiped profile: nothing in localStorage at all.
    await initPrefsHome()
    expect(listMyMoves().map((m) => m.name)).toEqual(['Slam', 'Drift'])
    expect(listTrackPresets().map((p) => p.name)).toEqual(['Gym'])
    expect(useSettings.getState().theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(useStore.getState().ui.snapping).toBe(false)
    expect(toasts).toEqual(['Your saved moves and settings came back from their file'])
    // Taking the file back is not a change of his, so nothing is written over it.
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual([])
  })

  it('a change he makes after that is written to the file once', async () => {
    localStorage.setItem('olpremiere:my-moves', MOVES)
    localStorage.setItem(PREFS_SAVED_AT_KEY, '9000')
    fileText = fileWith({ 'olpremiere:my-moves': MOVES }, 9000)
    await initPrefsHome()
    writes.length = 0
    setPlatformLoudness(false)
    useStore.getState().setUI({ snapping: false })
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    expect(writes).toHaveLength(1)
    const snap = parsePrefs(writes[0]!)!
    expect(snap.values['olpremiere:settings:platform-loudness']).toBe('off')
    expect(snap.values['olpremiere:snapping']).toBe('0')
    expect(snap.values['olpremiere:my-moves']).toBe(MOVES)
  })

  it('an old file never undoes a change he made since', async () => {
    localStorage.setItem('olpremiere:settings:theme', 'claude')
    localStorage.setItem(PREFS_SAVED_AT_KEY, '9000')
    fileText = fileWith({ 'olpremiere:settings:theme': 'light' }, 5000)
    await initPrefsHome()
    expect(localStorage.getItem('olpremiere:settings:theme')).toBe('claude')
    // And the file is brought up to the quick copy.
    expect(parsePrefs(writes.at(-1)!)?.values['olpremiere:settings:theme']).toBe('claude')
  })
})
