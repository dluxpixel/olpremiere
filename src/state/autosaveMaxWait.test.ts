/**
 * @vitest-environment jsdom
 *
 * jsdom for the window timers and the pagehide listener the autosave installs.
 */

// The autosave writes during a steady run of edits, not only after he stops.
//
// MEASURED 2026-10-01 in his GYM: one character typed into a title every 0.75 s
// for 20 s, the app ended 300 ms after the last one, and 6 of 27 characters came
// back. The save waited for a one second pause that never came.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'

/** Every project document the store write was handed, in order. */
const written: Project[] = []

// The database, faked down to the calls a save and a boot make.
vi.mock('idb', () => ({
  openDB: async () => ({
    get: async () => undefined,
    getAll: async () => [],
    getAllKeys: async () => [],
    put: async () => undefined,
    transaction: () => ({
      objectStore: (name: string) => ({
        put: (value: unknown) => {
          if (name === 'projects') written.push(value as Project)
        },
      }),
      done: Promise.resolve(),
    }),
  }),
}))
// No desktop shell: the file half of a save has nothing to write to.
vi.mock('./diskProjects', () => ({
  diskApi: () => null,
  healStoreFromDisk: async () => ({ names: [] }),
  trashProjectOnDisk: async () => undefined,
  writeProjectToDisk: async () => undefined,
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { autosaveDelayMs, initPersistence } = await import('./persistence')
const { useStore } = await import('./store')

/** One keystroke into the project name: a real change to the document. */
const type = (ch: string): void => {
  useStore.getState().dispatch('Rename', (p) => ({ ...p, name: p.name + ch }), 'name')
}

beforeEach(() => {
  vi.useFakeTimers()
  written.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('autosave during a steady run of edits', () => {
  it('writes at least every five seconds, and the last write is at most five seconds behind', async () => {
    useStore.getState().setProject(newProject(''))
    await initPersistence()
    written.length = 0

    // His measurement: a character every 0.75 s for 20 s, never a 1 s pause.
    let typed = ''
    const savedAt: number[] = []
    for (let i = 0; i < 27; i++) {
      const ch = String.fromCharCode(97 + (i % 26))
      typed += ch
      type(ch)
      const before = written.length
      await vi.advanceTimersByTimeAsync(750)
      if (written.length > before) savedAt.push(i)
    }
    // Ended 300 ms after the last keystroke, inside the one second debounce.
    await vi.advanceTimersByTimeAsync(300)

    const last = written.at(-1)?.name ?? ''
    // The old debounce wrote nothing at all during the run: 0 of 27.
    expect(savedAt.length).toBeGreaterThanOrEqual(3)
    // Whatever was typed more than 5 s (7 keystrokes) before the end is safe.
    expect(last.length).toBeGreaterThanOrEqual(typed.length - 7)
    expect(typed.startsWith(last)).toBe(true)
  })

  it('a single edit still waits the one second, so a burst is one write', async () => {
    useStore.getState().setProject(newProject('x'))
    await initPersistence()
    written.length = 0
    type('a')
    await vi.advanceTimersByTimeAsync(900)
    expect(written).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(written).toHaveLength(1)
  })
})

describe('autosaveDelayMs', () => {
  it('is the one second debounce while the oldest unsaved edit is fresh', () => {
    expect(autosaveDelayMs(10_000, 10_000)).toBe(1000)
    expect(autosaveDelayMs(10_000, 13_000)).toBe(1000)
  })

  it('shrinks so the oldest unsaved edit is written five seconds after it landed', () => {
    expect(autosaveDelayMs(10_000, 14_500)).toBe(500)
    expect(autosaveDelayMs(10_000, 15_000)).toBe(0)
    expect(autosaveDelayMs(10_000, 19_000)).toBe(0)
  })
})
