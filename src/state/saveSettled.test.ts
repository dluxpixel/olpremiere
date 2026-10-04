/**
 * @vitest-environment jsdom
 *
 * jsdom for the window timers and the pagehide listener the autosave installs.
 */

// The save an edit tab makes on its way to sleep. It has to have written EVERY
// change before it resolves, because the moment it does the store holds another
// edit, and anything still queued would read that one instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'

/** Every project document the store write was handed, in order. */
const written: Project[] = []
/** One resolver per write still on its way to disk. */
const landing: (() => void)[] = []

// The database, faked down to a write that lands when the test says so.
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
      done: new Promise<void>((resolve) => landing.push(resolve)),
    }),
  }),
}))
vi.mock('./diskProjects', () => ({
  diskApi: () => null,
  healStoreFromDisk: async () => ({ names: [] }),
  trashProjectOnDisk: async () => undefined,
  writeProjectToDisk: async () => undefined,
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { initPersistence, saveNow, saveSettled, settleAfterLoad } = await import('./persistence')
const { useStore } = await import('./store')

const type = (ch: string): void => {
  useStore.getState().dispatch('Rename', (p) => ({ ...p, name: p.name + ch }), 'name')
}
/** Let every pending promise run, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)
/** Land the oldest write still in flight. */
const land = async (): Promise<void> => {
  await settle()
  landing.shift()?.()
  await settle()
}
let installed = false

beforeEach(async () => {
  vi.useFakeTimers()
  useStore.getState().setProject(newProject(''))
  if (!installed) {
    installed = true
    await initPersistence()
  }
  // A fresh, saved project: no timer, nothing in flight.
  while (landing.length) await land()
  settleAfterLoad()
  useStore.getState().setUI({ saveState: 'saved' })
  written.length = 0
})

afterEach(() => {
  while (landing.length) landing.shift()?.()
  vi.useRealTimers()
})

describe('the save an edit makes before it goes to sleep', () => {
  it('waits for an edit made DURING the write, which saveNow alone did not', async () => {
    type('a')
    void saveNow()
    await settle()
    expect(written.map((p) => p.name)).toEqual(['a'])
    // He types while that write is on its way to disk.
    type('b')

    let quick = false
    let settled = false
    void saveNow().then(() => (quick = true))
    void saveSettled().then(() => (settled = true))
    await land()
    // ⛔ The old guarantee: saveNow is done, yet "b" is only now starting to be written.
    expect(quick).toBe(true)
    expect(written.map((p) => p.name)).toEqual(['a', 'ab'])
    expect(settled).toBe(false)

    await land()
    expect(settled).toBe(true)
    expect(written.at(-1)?.name).toBe('ab')
  })

  it('writes nothing for an edit that is already saved, so a switch between saved edits costs no disk', async () => {
    await saveSettled()
    expect(written).toEqual([])
  })

  it('writes anyway when asked to, for a project that may never have been written', async () => {
    const done = saveSettled(true)
    await land()
    await done
    expect(written).toHaveLength(1)
  })

  it('rejects when the write fails, so the switch stays put', async () => {
    type('x')
    const { db } = await import('./persistence')
    const real = await db()
    const spy = vi.spyOn(real, 'transaction').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    await expect(saveSettled()).rejects.toThrow('quota exceeded')
    spy.mockRestore()
  })
})
