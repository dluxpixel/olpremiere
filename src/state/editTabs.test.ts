// Edit tabs: several edits open, only the one on screen loaded. His ask,
// 2026-10-03: *"make it so I can copy things from edit to edit ... make it so it
// has to load when I click each one"*, and he picked tabs.
//
// What these pin is the promise a tab makes: switching away saves first and loses
// nothing, a sleeping tab holds plain data and no media, and waking one puts him
// back exactly where he was, undo included.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, newProject, newTitleClip, type Project } from '../engine/types'
import { useStore } from './store'

/** The store and the files, as one map: what a save writes and a wake reads. */
const saved = new Map<string, Project>()
let saveFails = false
/** Called while a wake is reading its project, to land an edit mid switch. */
let duringLoad: (() => void) | null = null
const toasts: string[] = []
const released: { from: string; to: string }[] = []
const closed: string[] = []
let captions = 'idle'
let recording = false

vi.mock('./persistence', () => ({
  saveSettled: vi.fn(async () => {
    if (saveFails) throw new Error('disk full')
    const p = useStore.getState().project
    saved.set(p.id, p)
    useStore.getState().setUI({ saveState: 'saved' })
  }),
  loadProjectById: vi.fn(async (id: string) => {
    await Promise.resolve()
    duringLoad?.()
    duringLoad = null
    const p = saved.get(id)
    // A wake reads a fresh copy of the document, the way IndexedDB hands one back.
    return p ? (JSON.parse(JSON.stringify(p)) as Project) : null
  }),
  rememberOpenProject: vi.fn(async () => {}),
  settleAfterLoad: vi.fn(),
  listProjects: vi.fn(async () => [...saved.values()].map((p) => ({ id: p.id, name: p.name }))),
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))
vi.mock('./projectResources', () => ({
  releaseSleepingEdit: (prev: Project, next: Project) => {
    released.push({ from: prev.name, to: next.name })
    return { heavy: [], cheap: [] }
  },
  releaseClosedEdit: (p: { id: string }) => {
    closed.push(p.id)
    return []
  },
}))
// The three things that write into whatever edit is open when they finish.
vi.mock('./transcribeActions', () => ({ useTranscribe: { getState: () => ({ status: captions }) } }))
vi.mock('./voiceRecorder', () => ({
  useRecorder: { getState: () => ({ recording, pendingTake: null, keeping: false }) },
}))
vi.mock('./mediaActions', () => ({ useImportProgress: { getState: () => ({ total: 0 }) } }))

const bag = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => bag.set(k, v),
  removeItem: (k: string) => bag.delete(k),
})

const tabsMod = await import('./editTabs')
const { closeTab, installEditTabs, reconcileEditTabs, resetEditTabsForTests, sleepingTabForTests, switchTo, useEditTabs } = tabsMod

const names = (): string[] => useEditTabs.getState().tabs.map((t) => t.name)
const open = (): Project => useStore.getState().project

/** Three of his edits on disk, A open. */
function threeEdits(): { a: Project; b: Project; c: Project } {
  const a = newProject('Green')
  const b = newProject('mc night')
  const c = newProject('BC')
  for (const p of [a, b, c]) saved.set(p.id, p)
  useStore.getState().setProject(a)
  useStore.getState().setUI({ saveState: 'saved', selection: [], playheadS: 0, pxPerS: 60 })
  return { a, b, c }
}

/** A real edit: a marker, one undo step. */
function addMarker(at: number): void {
  useStore.getState().dispatch('Add marker', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, markers: [...seq.markers, { id: `m${at}`, t: at, label: '', color: '#fff' }] } } }
  })
}
const markers = (p: Project): number[] => p.sequences[p.activeSequenceId].markers.map((m) => m.t)

beforeEach(() => {
  saved.clear()
  saveFails = false
  duringLoad = null
  toasts.length = 0
  released.length = 0
  closed.length = 0
  captions = 'idle'
  recording = false
  resetEditTabsForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('opening edits as tabs', () => {
  it('each open adds a tab, the one he left stays, and only the one on screen is in the store', async () => {
    const { b, c } = threeEdits()
    expect(await switchTo(b.id)).toBe('ok')
    expect(await switchTo(c.id)).toBe('ok')
    expect(names()).toEqual(['Green', 'mc night', 'BC'])
    expect(open().id).toBe(c.id)
    // Every switch let go of the edit it left, toward the one it landed on.
    expect(released).toEqual([
      { from: 'Green', to: 'mc night' },
      { from: 'mc night', to: 'BC' },
    ])
  })

  it('opening an edit that is already a tab focuses it rather than adding a second', async () => {
    const { a, b } = threeEdits()
    await switchTo(b.id)
    await switchTo(a.id)
    await switchTo(b.id)
    expect(names()).toEqual(['Green', 'mc night'])
    expect(await switchTo(b.id)).toBe('ok') // the open one: nothing to do
    expect(released).toHaveLength(3)
  })
})

describe('switching never loses work', () => {
  it('saves the edit he leaves before it goes to sleep', async () => {
    const { a, b } = threeEdits()
    addMarker(3)
    await switchTo(b.id)
    expect(markers(saved.get(a.id)!)).toEqual([3])
  })

  it('stays exactly where it is when that save fails', async () => {
    const { a, b } = threeEdits()
    addMarker(3)
    saveFails = true
    expect(await switchTo(b.id)).toBe('refused')
    expect(open().id).toBe(a.id)
    expect(markers(open())).toEqual([3])
    expect(toasts).toEqual(['Could not save this project. Staying here so nothing is lost'])
    expect(released).toEqual([])
  })

  it('an edit made while the next tab was loading is written too, before it is let go', async () => {
    const { a, b } = threeEdits()
    addMarker(1)
    // He nudges something in the instant between the save and the swap.
    duringLoad = () => addMarker(2)
    await switchTo(b.id)
    expect(markers(saved.get(a.id)!)).toEqual([1, 2])
  })

  it('closing the open tab saves it and lands on its right-hand neighbour', async () => {
    const { a, b, c } = threeEdits()
    await switchTo(b.id)
    await switchTo(c.id)
    await switchTo(b.id)
    addMarker(5)
    expect(await closeTab(b.id)).toBe(true)
    expect(open().id).toBe(c.id)
    expect(markers(saved.get(b.id)!)).toEqual([5])
    expect(names()).toEqual(['Green', 'BC'])
    // A sleeping one closes without a switch: it was saved when he left it.
    expect(await closeTab(a.id)).toBe(true)
    expect(open().id).toBe(c.id)
    expect(names()).toEqual(['BC'])
    // Nothing is kept for a closed tab.
    expect(sleepingTabForTests(a.id)).toBeUndefined()
    expect(closed).toEqual([b.id, a.id])
  })

  it('never closes the last tab: the editor always has an edit open', async () => {
    const { a, b } = threeEdits()
    await switchTo(b.id)
    await closeTab(a.id)
    expect(names()).toEqual(['mc night'])
    expect(await closeTab(b.id)).toBe(false)
    expect(open().id).toBe(b.id)
  })
})

describe('a sleeping tab keeps plain data and wakes where he left it', () => {
  it('comes back with its playhead, zoom, selection and its own undo', async () => {
    const { a, b } = threeEdits()
    const clipId = 'kept-clip'
    useStore.getState().dispatch('Add clip', (p) => {
      const seq = p.sequences[p.activeSequenceId]
      const clip = { ...newTitleClip(defaultTitleDef('round 2'), 0, 2), id: clipId }
      const tracks = seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t))
      return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
    })
    addMarker(4)
    useStore.getState().setUI({ playheadS: 7.5, pxPerS: 140, selection: [clipId] })

    await switchTo(b.id)
    // The other edit starts clean: none of A's undo, none of its place.
    expect(useStore.getState().history.undo).toHaveLength(0)
    expect(useStore.getState().ui.playheadS).toBe(0)
    expect(useStore.getState().ui.selection).toEqual([])
    // A is asleep as plain data: the snapshots and where he was, nothing else.
    const sleeping = sleepingTabForTests(a.id)!
    expect(sleeping.history.undo.map((c) => c.label)).toEqual(['Add clip', 'Add marker'])
    expect(sleeping.view).toMatchObject({ playheadS: 7.5, pxPerS: 140, selection: [clipId] })

    await switchTo(a.id)
    const s = useStore.getState()
    expect(s.ui).toMatchObject({ playheadS: 7.5, pxPerS: 140, selection: [clipId], saveState: 'saved' })
    expect(s.history.undo.map((c) => c.label)).toEqual(['Add clip', 'Add marker'])
    // And the undo still works on the woken document.
    expect(s.undo()).toBe('Add marker')
    expect(markers(open())).toEqual([])
    expect(s.undo()).toBe('Add clip')
    expect(sleepingTabForTests(a.id)).toBeUndefined()
  })

  it('drops the undo when the stored copy changed while it slept, rather than undo into a project that never existed', async () => {
    const { a, b } = threeEdits()
    addMarker(4)
    await switchTo(b.id)
    // A file restored over it while it slept.
    saved.set(a.id, { ...saved.get(a.id)!, name: 'Green', updatedAt: saved.get(a.id)!.updatedAt + 1 })
    await switchTo(a.id)
    expect(useStore.getState().history.undo).toHaveLength(0)
    expect(markers(open())).toEqual([4])
  })

  it('a tab whose project has gone closes when clicked, and says so', async () => {
    const { b, c } = threeEdits()
    await switchTo(b.id)
    await switchTo(c.id)
    saved.delete(b.id)
    expect(await switchTo(b.id)).toBe('missing')
    expect(open().id).toBe(c.id)
    expect(names()).toEqual(['Green', 'BC'])
    expect(toasts).toEqual(['That edit could not be opened, so its tab was closed'])
  })
})

describe('one switch at a time, and never out from under work still landing', () => {
  it('a second click while a tab is waking is ignored', async () => {
    const { b, c } = threeEdits()
    const first = switchTo(b.id)
    expect(await switchTo(c.id)).toBe('refused')
    expect(await first).toBe('ok')
    expect(open().id).toBe(b.id)
  })

  it('stays while captions are being made for this edit, and says why', async () => {
    const { a, b } = threeEdits()
    captions = 'listening'
    expect(await switchTo(b.id)).toBe('refused')
    expect(open().id).toBe(a.id)
    expect(toasts[0]).toMatch(/Captions are still being made/)
  })

  it('stays while a voice take is recording', async () => {
    const { a, b } = threeEdits()
    recording = true
    expect(await switchTo(b.id)).toBe('refused')
    expect(open().id).toBe(a.id)
  })
})

describe('the strip outlives a restart', () => {
  it('every change to the list is written, and a fresh start reads it back in order', async () => {
    const { b, c } = threeEdits()
    await switchTo(b.id)
    await switchTo(c.id)
    expect(JSON.parse(bag.get('olpremiere:editTabs')!)).toEqual(useEditTabs.getState().tabs)

    vi.resetModules()
    const fresh = await import('./editTabs')
    expect(fresh.useEditTabs.getState().tabs.map((t) => t.name)).toEqual(['Green', 'mc night', 'BC'])
  })

  it('a stored list that will not parse opens on an empty strip instead of throwing', async () => {
    bag.set('olpremiere:editTabs', '{not json')
    vi.resetModules()
    const fresh = await import('./editTabs')
    expect(fresh.useEditTabs.getState().tabs).toEqual([])
  })

  it('after the boot, tabs whose project has gone leave and the rest take their current names', async () => {
    const { b, c } = threeEdits()
    await switchTo(b.id)
    await switchTo(c.id)
    saved.delete(b.id)
    saved.set(c.id, { ...saved.get(c.id)!, name: 'BC final' })
    useStore.setState({ project: { ...open(), name: 'BC final' } })
    await reconcileEditTabs()
    expect(names()).toEqual(['Green', 'BC final'])
  })
})

describe('a project opened some other way still gets its tab', () => {
  it('the boot, a room or a restored file: a tab for it, the one it replaced kept and let go', async () => {
    const { a, b } = threeEdits()
    // The blank project the app starts on, before anything hydrates.
    useStore.getState().setProject(newProject('placeholder'))
    const stop = installEditTabs()
    try {
      // The boot hydrating A over it.
      useStore.getState().setProject(a)
      expect(names()).toEqual(['Green'])
      addMarker(2)
      // Something outside the strip opening B.
      useStore.getState().setProject(b)
      expect(names()).toEqual(['Green', 'mc night'])
      expect(released.at(-1)).toEqual({ from: 'Green', to: 'mc night' })
      expect(sleepingTabForTests(a.id)?.history.undo).toHaveLength(1)
      // A rename in the top bar reaches its tab.
      useStore.getState().dispatch('Rename', (p) => ({ ...p, name: 'mc night 2' }))
      expect(names()).toEqual(['Green', 'mc night 2'])
    } finally {
      stop()
    }
  })
})
