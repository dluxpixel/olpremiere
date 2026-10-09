// The backup timer: the code that exists because an edit was lost on 2026-07-26
// and finished projects were lost on 2026-08-23. Its disk half
// (electron/backups.ts) had tests; this half, the one that decides WHEN to write
// and WHAT, had none (found 2026-10-06). These drive it on fake timers with a
// fake desktop shell and prove it by what it writes, never by how it is written.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Doc {
  id: string
  name: string
  assets: Record<string, never>
  note?: string
}

/** What the store holds: the open project and whether he is playing. */
const state: { project: Doc | null; ui: { playing: boolean } } = { project: null, ui: { playing: false } }
/** The other projects on his shelf, with the stamp the store keeps for each. */
let shelf: { doc: Doc; updatedAt: number }[] = []
const loaded: string[] = []

vi.mock('./store', () => ({ useStore: { getState: () => state } }))
vi.mock('./persistence', () => ({
  listProjects: () => Promise.resolve(shelf.map((s) => ({ id: s.doc.id, updatedAt: s.updatedAt }))),
  loadProjectById: (id: string) => {
    loaded.push(id)
    return Promise.resolve(shelf.find((s) => s.doc.id === id)?.doc ?? null)
  },
}))

const BOOT_MS = 20_000
const TICK_MS = 2 * 60 * 1000

/** Every file the shell was asked to write: the name it was given and the project inside. */
let writes: { name: string; id: string; note?: string }[] = []
let failNext = 0
let onPagehide: (() => void) | null = null
let intervals = 0

function desktopShell(): void {
  vi.stubGlobal('window', {
    api: {
      isElectron: true,
      backupWrite: async (name: string, json: string) => {
        if (failNext > 0) {
          failNext--
          throw new Error('disk full')
        }
        const doc = JSON.parse(json).project as Doc
        writes.push({ name, id: doc.id, note: doc.note })
      },
    },
    setInterval: (fn: () => void, ms: number) => {
      intervals++
      return setInterval(fn, ms)
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'pagehide') onPagehide = fn
    },
  })
}

/** A fresh copy of the module: its fingerprints and its timer are module state. */
async function start(): Promise<void> {
  const { initAutoBackup } = await import('./autoBackup')
  initAutoBackup()
}

/** Run the clock forward and let every write it started finish. */
async function after(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  state.project = { id: 'open', name: 'The edit', assets: {} }
  state.ui.playing = false
  shelf = []
  loaded.length = 0
  writes = []
  failNext = 0
  onPagehide = null
  intervals = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('automatic backups', () => {
  it('the web build starts no timer and has nothing to write with', async () => {
    vi.stubGlobal('window', {
      setInterval: () => {
        intervals++
        return 0
      },
      setTimeout: () => 0,
      addEventListener: () => undefined,
    })
    await start()
    await after(10 * TICK_MS)
    expect(intervals).toBe(0)
  })

  it('writes the open edit shortly after boot, so a session that crashes early still leaves a copy', async () => {
    desktopShell()
    await start()
    await after(BOOT_MS - 1000)
    expect(writes).toEqual([])
    await after(1000)
    expect(writes).toEqual([{ name: 'The edit', id: 'open' }])
  })

  it('an idle app writes nothing more, and a change is written at the next tick', async () => {
    desktopShell()
    await start()
    await after(BOOT_MS)
    await after(3 * TICK_MS)
    expect(writes).toHaveLength(1)

    state.project = { ...state.project!, note: 'a cut he made' }
    await after(TICK_MS)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual({ name: 'The edit', id: 'open', note: 'a cut he made' })
  })

  it('backs up every project on his shelf, not only the open one, and skips the ones that did not change', async () => {
    shelf = [
      { doc: { id: 'later', name: 'Later edit', assets: {} }, updatedAt: 5 },
      { doc: { id: 'finished', name: 'Finished edit', assets: {} }, updatedAt: 7 },
    ]
    desktopShell()
    await start()
    await after(BOOT_MS)
    expect(writes.map((w) => w.id).sort()).toEqual(['finished', 'later', 'open'])
    expect(loaded.sort()).toEqual(['finished', 'later'])

    // Nothing moved: not one more write, and no project is even read again.
    await after(TICK_MS)
    expect(writes).toHaveLength(3)
    expect(loaded).toHaveLength(2)

    // One of them changed: that one, and only that one, is read and written.
    shelf[0] = { doc: { ...shelf[0]!.doc, note: 'trimmed' }, updatedAt: 6 }
    await after(TICK_MS)
    expect(loaded.slice(2)).toEqual(['later'])
    expect(writes.slice(3)).toEqual([{ name: 'Later edit', id: 'later', note: 'trimmed' }])
  })

  it('never reads the other projects while he is playing, and catches up on the next quiet tick', async () => {
    shelf = [{ doc: { id: 'later', name: 'Later edit', assets: {} }, updatedAt: 5 }]
    desktopShell()
    state.ui.playing = true
    await start()
    await after(BOOT_MS)
    // The open edit is written (it is already in memory), the shelf waits.
    expect(writes.map((w) => w.id)).toEqual(['open'])
    expect(loaded).toEqual([])

    state.ui.playing = false
    await after(TICK_MS)
    expect(writes.map((w) => w.id)).toEqual(['open', 'later'])
  })

  it('a write that fails is tried again at the next tick', async () => {
    desktopShell()
    failNext = 1
    await start()
    await after(BOOT_MS)
    expect(writes).toEqual([])
    await after(TICK_MS)
    expect(writes).toEqual([{ name: 'The edit', id: 'open' }])
  })

  it('closing the window writes the last minutes the timer has not reached', async () => {
    desktopShell()
    await start()
    await after(BOOT_MS)
    state.project = { ...state.project!, note: 'the last cut' }
    expect(onPagehide).not.toBeNull()
    onPagehide!()
    await after(0)
    expect(writes.at(-1)).toEqual({ name: 'The edit', id: 'open', note: 'the last cut' })
  })
})
