/**
 * @vitest-environment jsdom
 *
 * jsdom for the window timers, the pagehide listener and a text field to type in.
 */

// The save a close waits for, and the word "Saved" it trusts.
//
// Before 2026-10-06 a write that landed set "Saved" even when he had typed
// another letter while it was on its way, and a close trusted that word and
// skipped the letter. Nothing held the close either: the window went while the
// last write was still on its way. Main now holds the close until the page
// answers (electron/closeGate.ts); this is the page's half.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type Project } from '../engine/types'

/** Every project document the store write was handed, in order. */
const written: Project[] = []
/** One resolver per write still on its way to disk. */
const landing: (() => void)[] = []
/** How many file writes in a row fail from now. */
let fileFailures = 0
/** Every toast, newest last. */
const toasts: string[] = []

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
  writeProjectToDisk: async () => {
    if (fileFailures > 0) {
      fileFailures -= 1
      throw new Error('EPERM: operation not permitted, rename')
    }
  },
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))

// The desktop bridge: main asks through onBeforeClose, the page answers through closeReady.
let askToSave: (() => void) | null = null
const closeReady = vi.fn<(saved: boolean, onlyTheFile?: boolean) => void>()
Object.assign(window, {
  api: {
    onBeforeClose: (cb: () => void) => {
      askToSave = cb
      return () => undefined
    },
    closeReady,
  },
})

const { initPersistence, saveNow, saveSettled, settleAfterLoad, saveFailedMessage, FileNotWrittenError } =
  await import('./persistence')
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
const saveState = () => useStore.getState().ui.saveState
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
  toasts.length = 0
  closeReady.mockClear()
  fileFailures = 0
})

afterEach(() => {
  while (landing.length) landing.shift()?.()
  vi.useRealTimers()
})

describe('"Saved" means what he has is written', () => {
  it('a letter typed while a write is on its way leaves the project unsaved', async () => {
    type('a')
    void saveNow()
    await settle()
    // He types while that write is on its way to disk.
    type('b')
    await land()
    expect(written.map((p) => p.name)).toEqual(['a'])
    // It said "saved" here before, over a letter that was never written.
    expect(saveState()).toBe('unsaved')
  })

  it('so a close of the page right then still writes the last letter', async () => {
    type('a')
    void saveNow()
    await settle()
    type('b')
    await land()
    // Inside the one second wait: only the page going away can write it now.
    window.dispatchEvent(new Event('pagehide'))
    await land()
    expect(written.at(-1)?.name).toBe('ab')
  })

  it('still marks a write saved when nothing changed while it was on its way', async () => {
    type('a')
    void saveNow()
    await land()
    expect(saveState()).toBe('saved')
  })
})

describe('the save a close waits for', () => {
  it('answers only once the edit queued behind a write in flight is down too', async () => {
    type('a')
    void saveNow()
    await settle()
    type('b')
    // He clicks the X while "a" is still on its way and "b" waits behind it.
    askToSave?.()
    await land()
    expect(closeReady).not.toHaveBeenCalled()
    await land()
    expect(written.at(-1)?.name).toBe('ab')
    expect(closeReady).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('answers at once, writing nothing, when everything is already saved', async () => {
    askToSave?.()
    await settle()
    expect(written).toEqual([])
    expect(closeReady).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('commits the field he is typing in before it saves', async () => {
    // A caption field: what he typed reaches the project when it loses focus.
    const field = document.createElement('input')
    document.body.append(field)
    field.addEventListener('blur', () => type(field.value))
    field.focus()
    field.value = 'hello'
    askToSave?.()
    await land()
    expect(written.at(-1)?.name).toBe('hello')
    expect(closeReady).toHaveBeenCalledExactlyOnceWith(true)
    field.remove()
  })

  it('leaves him in that field, so a close he stays in keeps his next keys his', async () => {
    // A failed save asks him, and Stay keeps the window. A field left by the
    // commit would hand his next Backspace to Delete clip.
    const field = document.createElement('input')
    document.body.append(field)
    field.addEventListener('blur', () => type(field.value))
    field.focus()
    field.value = 'hi'
    askToSave?.()
    await land()
    expect(written.at(-1)?.name).toBe('hi')
    expect(document.activeElement).toBe(field)
    field.remove()
  })

  it('tries a failed save again on its own, with no new edit, and says when it is back', async () => {
    fileFailures = 1
    type('x')
    await vi.advanceTimersByTimeAsync(1000)
    await land()
    expect(saveState()).toBe('unsaved')
    // The app store took it; only the file failed, so the words must not say it is lost.
    expect(toasts).toEqual(['Saved in the app, but its file in Documents could not be written. Trying again'])
    written.length = 0
    // He does nothing. Before, nothing was written again until his next edit.
    await vi.advanceTimersByTimeAsync(5000)
    await land()
    expect(written.map((p) => p.name)).toEqual(['x'])
    expect(saveState()).toBe('saved')
    expect(toasts.at(-1)).toBe('Saved again')
  })

  it('says when only the file failed, so the question does not tell him his work is lost', async () => {
    // Documents unwritable: the app's store has the change, the file does not.
    fileFailures = 1
    type('x')
    askToSave?.()
    await land()
    expect(closeReady).toHaveBeenCalledExactlyOnceWith(false, true)
    // Let the retry land so the next test starts clean.
    await vi.advanceTimersByTimeAsync(5000)
    await land()
    expect(saveState()).toBe('saved')
  })

  it('answers false when the write fails, so main asks him before it closes', async () => {
    type('x')
    const { db } = await import('./persistence')
    const real = await db()
    const spy = vi.spyOn(real, 'transaction').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    askToSave?.()
    await settle()
    expect(closeReady).toHaveBeenCalledExactlyOnceWith(false)
    spy.mockRestore()
    // Let the retry land so the next test starts clean.
    await vi.advanceTimersByTimeAsync(5000)
    await land()
    expect(saveState()).toBe('saved')
  })
})

describe('saveFailedMessage', () => {
  it('says the work is safe in the app when only the file failed', () => {
    expect(saveFailedMessage(new FileNotWrittenError(new Error('EBUSY')))).toMatch(/^Saved in the app/)
    expect(saveFailedMessage(new Error('quota exceeded'))).toBe('Could not save your work. Trying again')
  })

  it('never says "memory", which is not a word for him', () => {
    expect(saveFailedMessage(new Error('x'))).not.toMatch(/memory/i)
  })
})

describe('Ctrl+S from the edit in flight', () => {
  it('resolves only after the edit made during a write is down', async () => {
    type('a')
    void saveNow()
    await settle()
    type('b')
    let done = false
    void saveSettled(true).then(() => (done = true))
    await land()
    expect(done).toBe(false)
    await land()
    expect(done).toBe(true)
    expect(written.at(-1)?.name).toBe('ab')
  })
})
