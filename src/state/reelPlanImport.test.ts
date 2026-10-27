// "Import reel plan..." on the page: all of it or none of it. A clip that will not come
// in must leave the open edit as it was, no project behind, and nothing for him to Undo.
// The file dialog and the clip files are faked (window.api), and so are the app's media
// import and its saves; the tabs, the store and the mapper are the real ones.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReelPlanImportResult } from '../../electron/ipc-types'
import type { ReelPlan } from '../../electron/reelPlan'
import { newProject, type MediaAsset, type Project } from '../engine/types'

const saved = new Map<string, Project>()
const toasts: { message: string; kind?: string; action?: unknown }[] = []
const h = vi.hoisted(() => ({
  importFiles: vi.fn<(files: File[], opts?: unknown) => Promise<string[]>>(),
}))

vi.mock('./toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (message: string, kind?: string, action?: unknown) => {
        toasts.push({ message, kind, action })
      },
    }),
  },
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))
vi.mock('./transcribeActions', () => ({ useTranscribe: { getState: () => ({ status: 'idle' }) } }))
vi.mock('./voiceRecorder', () => ({
  useRecorder: { getState: () => ({ recording: false, pendingTake: null, keeping: false }) },
}))
// The app's media import: its progress store is real (a switch reads it), the import is ours.
vi.mock('./mediaActions', async () => {
  const { create } = await import('zustand')
  return {
    importFiles: h.importFiles,
    useImportProgress: create(() => ({ total: 0, done: 0, name: '', step: '', frac: 0 })),
  }
})
vi.mock('./persistence', () => ({
  saveSettled: vi.fn(async () => {
    const p = useStore.getState().project
    saved.set(p.id, p)
  }),
  loadProjectById: vi.fn(async (id: string) => saved.get(id) ?? null),
  rememberOpenProject: vi.fn(async () => {}),
  settleAfterLoad: vi.fn(),
  saveProject: vi.fn(async (p: Project) => {
    saved.set(p.id, p)
  }),
  deleteProject: vi.fn(async (id: string) => {
    const p = saved.get(id) ?? null
    saved.delete(id)
    return p
  }),
  dropUnusedBlobs: vi.fn(async () => 0),
  listProjects: vi.fn(async () => [...saved.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: 0 }))),
}))

const { importReelPlan } = await import('./reelPlanImport')
const { useStore } = await import('./store')
const { useEditTabs, resetEditTabsForTests } = await import('./editTabs')
const { useImportProgress } = await import('./mediaActions')
const { deleteProject } = await import('./persistence')

const here = path.dirname(fileURLToPath(import.meta.url))
const loadPlan = (): ReelPlan => JSON.parse(readFileSync(path.join(here, '..', '..', 'electron', 'fixtures', 'reel-plan.json'), 'utf8'))

/** What main answers for a plan that passed: the plan and one small file per clip. */
function planAnswer(): ReelPlanImportResult {
  const plan = loadPlan()
  return {
    status: 'plan',
    plan,
    fileName: 'reel-plan.json',
    files: plan.clips.map((c) => ({ id: c.id, name: `${c.id}.mp4`, size: 10, mime: 'video/mp4' })),
  }
}

/** The desktop shell's two calls the import makes. */
function shell(answer: () => Promise<ReelPlanImportResult> = async () => planAnswer()) {
  const api = {
    reelPlanImport: vi.fn(answer),
    reelPlanReadClip: vi.fn(async (_id: string, _offset: number, length: number) => new ArrayBuffer(length)),
  }
  // setTimeout is the one window call a tab switch makes when it wakes a sleeping edit.
  vi.stubGlobal('window', { api, setTimeout: () => 0 })
  return api
}

/** The edit that was open when the media import was asked to run: the project the import made. */
const openWhenImporting = { id: '' }

/** The app's media import, finishing with `count` of the clips stored in the open edit. */
function bringIn(count: number): void {
  h.importFiles.mockImplementation(async (files) => {
    const live = useStore.getState().project
    openWhenImporting.id = live.id
    const made = files.slice(0, count).map(
      (f, i): MediaAsset => ({
        id: `a${i}`,
        name: f.name,
        kind: 'video',
        blobKey: `blob/a${i}`,
        durationS: 30,
        width: 1080,
        height: 1920,
        hasAudio: true,
        hasVideo: true,
      }),
    )
    useStore.setState({ project: { ...live, assets: { ...live.assets, ...Object.fromEntries(made.map((a) => [a.id, a])) } } })
    // Like the real import, it clears the progress it set when it is done.
    useImportProgress.setState({ total: 0, done: 0, name: '', step: '', frac: 0 })
    return made.map((a) => a.id)
  })
}

let before: Project
beforeEach(() => {
  toasts.length = 0
  saved.clear()
  h.importFiles.mockReset()
  openWhenImporting.id = ''
  vi.mocked(deleteProject).mockClear()
  resetEditTabsForTests()
  useImportProgress.setState({ total: 0, done: 0, name: '', step: '', frac: 0 })
  before = newProject('Current')
  useStore.getState().setProject(before)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Every project that exists anywhere: stored, open, or sitting in the tab strip. */
const everywhere = (): string[] =>
  [...new Set([...saved.keys(), useStore.getState().project.id, ...useEditTabs.getState().tabs.map((t) => t.id)])].sort()

/** What a half built import must leave behind: nothing but the edit he was in. */
function expectNothingLeft(createdId: string): void {
  expect(useStore.getState().project.id).toBe(before.id)
  expect(useStore.getState().project).toEqual(before)
  expect(everywhere()).toEqual([before.id])
  expect(useEditTabs.getState().tabs.some((t) => t.id === createdId)).toBe(false)
  // Deleted outright, with its media: not the delete that offers an Undo.
  expect(deleteProject).toHaveBeenCalledTimes(1)
  expect(deleteProject).toHaveBeenCalledWith(createdId, { keepBytes: false })
  expect(toasts.some((t) => t.action !== undefined)).toBe(false)
  expect(toasts.some((t) => /deleted|undo/i.test(t.message))).toBe(false)
  expect(toasts.some((t) => t.kind === 'success')).toBe(false)
}

describe('a reel plan that cannot be finished leaves nothing behind', () => {
  it('a clip that did not come in: the open edit is untouched, no project is left, no Undo, no success toast', async () => {
    const api = shell()
    // One clip of the three does not come in (importFiles says which, in its own toast).
    bringIn(2)

    await importReelPlan()

    expect(api.reelPlanReadClip).toHaveBeenCalledTimes(3)
    const createdId = openWhenImporting.id
    expect(createdId).not.toBe('')
    expect(createdId).not.toBe(before.id)
    expectNothingLeft(createdId)
    expect(toasts.map((t) => t.message)).toEqual(['A clip of the reel plan could not be imported, so no project was made'])
    expect(toasts[0].kind).toBe('danger')
  })

  it('a clip that cannot be read from disk: the same, and the media import is never asked', async () => {
    const api = shell()
    let createdId = ''
    api.reelPlanReadClip.mockImplementation(async (id, _offset, length) => {
      createdId = useStore.getState().project.id
      if (id === 'c2') throw new Error('Refused: the clip changed on disk')
      return new ArrayBuffer(length)
    })

    await importReelPlan()

    expect(h.importFiles).not.toHaveBeenCalled()
    expect(createdId).not.toBe(before.id)
    expectNothingLeft(createdId)
    expect(toasts.map((t) => t.message)).toEqual(['The reel plan could not be imported. No project was made'])
    expect(toasts[0].kind).toBe('danger')
    // The reading progress is not left on screen.
    expect(useImportProgress.getState().total).toBe(0)
  })

  it('does not delete the open edit when the way back is refused, and says it is still open', async () => {
    shell()
    let createdId = ''
    h.importFiles.mockImplementation(async () => {
      createdId = useStore.getState().project.id
      // Media still landing in this edit: a switch away is refused until it ends.
      useImportProgress.setState({ total: 1, done: 0, name: 'x', step: 'Reading', frac: 0 })
      return []
    })

    await importReelPlan()

    expect(useStore.getState().project.id).toBe(createdId)
    expect(deleteProject).not.toHaveBeenCalled()
    expect(toasts.at(-1)).toEqual({
      message: 'A clip of the reel plan could not be imported, and the half built project is still open',
      kind: 'danger',
      action: undefined,
    })
    expect(toasts.some((t) => t.kind === 'success')).toBe(false)
  })
})

describe('a reel plan that finishes', () => {
  it('keeps the new project, and says it is built only after the build, once', async () => {
    shell()
    bringIn(3)

    await importReelPlan()

    const open = useStore.getState().project
    expect(open.id).not.toBe(before.id)
    expect(open.name).toBe('reel-plan')
    expect(saved.has(open.id)).toBe(true)
    expect(saved.has(before.id)).toBe(true)
    expect(deleteProject).not.toHaveBeenCalled()
    // The media import is asked to stay quiet: no success toast of its own.
    expect(h.importFiles).toHaveBeenCalledWith(expect.any(Array), { quiet: true })
    expect(toasts).toEqual([{ message: 'Built “reel-plan” from the reel plan: 4 shots', kind: 'success', action: undefined }])
  })
})

describe('one import at a time', () => {
  it('a second call while one runs does nothing, and the next one after it is let in', async () => {
    let release: (r: ReelPlanImportResult) => void = () => {}
    const api = shell(() => new Promise<ReelPlanImportResult>((resolve) => (release = resolve)))

    const first = importReelPlan()
    await importReelPlan()
    expect(api.reelPlanImport).toHaveBeenCalledTimes(1)

    release({ status: 'cancelled' })
    await first
    expect(toasts).toEqual([])

    api.reelPlanImport.mockImplementation(async () => ({ status: 'cancelled' }))
    await importReelPlan()
    expect(api.reelPlanImport).toHaveBeenCalledTimes(2)
  })

  it('a refused plan makes no project and says every problem', async () => {
    const api = shell(async () => ({ status: 'refused', problems: ['clips[1]: the file is missing'] }))
    await importReelPlan()
    expect(api.reelPlanReadClip).not.toHaveBeenCalled()
    expect(everywhere()).toEqual([before.id])
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('danger')
    expect(toasts[0].message).toContain('clips[1]')
  })
})
