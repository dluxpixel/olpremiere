import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobKeysOnlyUsedBy } from '../engine/blobGc'
import { newClipFromAsset, newProject, type MediaAsset, type Project } from '../engine/types'
import { createProject, duplicateProject, openProject, removeProject, UNDO_DELETE_MS } from './projectActions'
import { deleteProject, dropUnusedBlobs } from './persistence'
import { useStore } from './store'

const saved = new Map<string, Project>()
let roomSession: object | null = null
/** Flip on to make the autosave flush REJECT, as a full disk / dead IDB would. */
let saveFails = false

/** Every toast shown, with its button, so a test can press Undo. */
const toasts: { message: string; action?: { label: string; onClick: () => void } }[] = []
vi.mock('./toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (message: string, _kind?: string, action?: { label: string; onClick: () => void }) => {
        toasts.push({ message, action })
      },
    }),
  },
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({
  useCollab: { getState: () => ({ session: roomSession }) },
}))
/** The switch-away save: the open project, or a throw as a full disk would. */
const flush = async (): Promise<void> => {
  if (saveFails) throw new Error('quota exceeded')
  const p = useStore.getState().project
  saved.set(p.id, p)
}
vi.mock('./persistence', () => ({
  saveNow: vi.fn(() => flush()),
  saveSettled: vi.fn(() => flush()),
  rememberOpenProject: vi.fn(async () => {}),
  settleAfterLoad: vi.fn(),
  saveProject: vi.fn(async (p: Project) => {
    saved.set(p.id, p)
  }),
  loadProjectById: vi.fn(async (id: string) => saved.get(id) ?? null),
  deleteProject: vi.fn(async (id: string) => {
    const p = saved.get(id) ?? null
    saved.delete(id)
    return p
  }),
  dropUnusedBlobs: vi.fn(async () => 0),
  listProjects: vi.fn(async () =>
    [...saved.values()].map((p, i) => ({ id: p.id, name: p.name, updatedAt: i })),
  ),
}))

beforeEach(() => {
  toasts.length = 0
  vi.mocked(dropUnusedBlobs).mockClear()
  saved.clear()
  roomSession = null
  saveFails = false
  useStore.getState().setProject(newProject('Current'))
  useStore.getState().setUI({ selection: ['x'], playheadS: 7, playing: false })
})

describe('openProject', () => {
  it('autosaves the current edit, adopts the other one, and resets the UI', async () => {
    const other = newProject('Other')
    saved.set(other.id, other)
    const currentId = useStore.getState().project.id

    await openProject(other.id)

    expect(useStore.getState().project.id).toBe(other.id)
    expect(saved.has(currentId)).toBe(true) // nothing was lost by switching
    expect(useStore.getState().ui.selection).toEqual([])
    expect(useStore.getState().ui.playheadS).toBe(0)
  })

  it('refuses inside a collab room', async () => {
    roomSession = {}
    const other = newProject('Other')
    saved.set(other.id, other)
    const before = useStore.getState().project.id
    await openProject(other.id)
    expect(useStore.getState().project.id).toBe(before)
  })
})

describe('createProject', () => {
  it('banks the current project and starts a fresh one', async () => {
    const before = useStore.getState().project.id
    await createProject()
    const after = useStore.getState().project
    expect(after.id).not.toBe(before)
    expect(saved.has(before)).toBe(true)
    expect(saved.has(after.id)).toBe(true) // the new one exists immediately
  })
})

describe('removeProject', () => {
  // ⛔ THIS USED TO SAY 'never deletes the open project'. He asked for the
  // opposite on 2026-08-14: the delete button is on the open row now, and
  // having to open something else first purely to satisfy the app was the bug.
  // What must still hold is that the editor is never left holding a corpse.
  it('deletes the open project, landing on another one first', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)
    const other = newProject('Other')
    saved.set(other.id, other)

    await removeProject(current.id)

    expect(saved.has(current.id)).toBe(false)
    expect(useStore.getState().project.id).toBe(other.id)
  })

  it('deletes the open project when it is the last one, onto a fresh one', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)

    await removeProject(current.id)

    expect(saved.has(current.id)).toBe(false)
    // Somewhere real to be, not an empty editor.
    expect(useStore.getState().project.id).not.toBe(current.id)
    expect(saved.has(useStore.getState().project.id)).toBe(true)
  })

  it('⛔ deletes NOTHING when the switch away could not save', async () => {
    // The order is the whole safety property: a delete that went ahead here
    // would pull the file out from under an editor still showing it.
    const current = useStore.getState().project
    saved.set(current.id, current)
    const other = newProject('Other')
    saved.set(other.id, other)
    saveFails = true

    await removeProject(current.id)

    expect(saved.has(current.id)).toBe(true)
    expect(useStore.getState().project.id).toBe(current.id)
  })

  it('refuses inside a collab room, where switching would tear the doc away', async () => {
    const current = useStore.getState().project
    saved.set(current.id, current)
    roomSession = {}
    await removeProject(current.id)
    expect(saved.has(current.id)).toBe(true)
  })

  it('deletes another project', async () => {
    const other = newProject('Other')
    saved.set(other.id, other)
    await removeProject(other.id)
    expect(saved.has(other.id)).toBe(false)
  })
})

describe('a failed flush never costs the user their edits', () => {
  it('openProject aborts instead of adopting over unsaved work', async () => {
    const other = newProject('Other')
    saved.set(other.id, other)
    const currentId = useStore.getState().project.id
    saveFails = true

    await openProject(other.id)

    // Still on the project that could not be written, because switching would have
    // replaced the in-memory document and dropped every edit since the last
    // successful save.
    expect(useStore.getState().project.id).toBe(currentId)
  })

  it('createProject aborts too', async () => {
    const currentId = useStore.getState().project.id
    saveFails = true
    await createProject()
    expect(useStore.getState().project.id).toBe(currentId)
  })
})

describe('duplicateProject (Make a copy)', () => {
  /** A project with one clip of one piece of media, like his BC templates. */
  const template = (name: string): Project => {
    const p = newProject(name)
    const asset: MediaAsset = {
      id: 'asset-1',
      name: 'unit.png',
      kind: 'image',
      blobKey: 'asset/asset-1',
      thumbnailKey: 'thumb/asset-1',
      durationS: 0,
      hasAudio: false,
      hasVideo: true,
    }
    const seq = p.sequences[p.activeSequenceId]
    const tracks = seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [newClipFromAsset(asset, 0)] } : t))
    return { ...p, assets: { [asset.id]: asset }, sequences: { [seq.id]: { ...seq, tracks } }, laterAt: 5 }
  }

  it('makes a new project with the same clips and media, named the _1 way, and opens it', async () => {
    const source = template('BC template 4')
    saved.set(source.id, source)

    expect(await duplicateProject(source.id)).toBe(true)

    const copy = useStore.getState().project
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe('BC template 4_1')
    expect(saved.get(copy.id)).toBe(copy)
    // Fresh sequence ids, the same clips and the same byte keys: no footage copied.
    expect(Object.keys(copy.sequences)).toHaveLength(1)
    expect(Object.keys(copy.sequences)[0]).not.toBe(source.activeSequenceId)
    expect(copy.activeSequenceId).toBe(Object.keys(copy.sequences)[0])
    const clips = (p: Project) => Object.values(p.sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips))
    expect(clips(copy)).toEqual(clips(source))
    expect(copy.assets).toEqual(source.assets)
    // A new video is current work, not parked.
    expect(copy.laterAt).toBeUndefined()
    // The original is untouched.
    expect(saved.get(source.id)).toBe(source)
  })

  it('⛔ deleting the original keeps every byte the copy uses', async () => {
    const source = template('Green')
    saved.set(source.id, source)
    await duplicateProject(source.id)
    const copy = useStore.getState().project
    // What deleteProject would drop from the store with the copy still there.
    expect(blobKeysOnlyUsedBy(source, [copy])).toEqual([])
  })

  it('copies the open project as it is on screen, not the store copy a second behind', async () => {
    const source = template('GYM')
    saved.set(source.id, { ...source, name: 'GYM' })
    useStore.getState().setProject(source)
    useStore.getState().dispatch('Rename', (p) => ({ ...p, name: 'GYM final' }), 'name')

    await duplicateProject(source.id)

    // His rename landed in the copy, and the copy is told apart from the original.
    expect(useStore.getState().project.name).toBe('GYM final_1')
    expect(useStore.getState().project.id).not.toBe(source.id)
    expect(saved.get(source.id)?.name).toBe('GYM final')
  })

  it('makes nothing when the copy cannot be saved', async () => {
    const source = template('BC')
    saved.set(source.id, source)
    const before = useStore.getState().project.id
    const { saveProject } = await import('./persistence')
    vi.mocked(saveProject).mockRejectedValueOnce(new Error('disk full'))

    expect(await duplicateProject(source.id)).toBe(false)

    expect(useStore.getState().project.id).toBe(before)
    expect(saved.size).toBe(1)
  })
})

describe('⛔ deleting a project can be undone', () => {
  /** A project with media, so there are bytes for the delete to keep or let go. */
  const withMedia = (name: string): Project => ({
    ...newProject(name),
    assets: {
      a1: { id: 'a1', name: 'gym.mp4', kind: 'video', blobKey: 'asset/a1', thumbnailKey: 'thumb/a1', durationS: 4, hasAudio: true, hasVideo: true },
    },
  })
  const undoOf = (message: string) => toasts.find((t) => t.message === message)?.action

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Undo puts the same project back, and its media are never let go', async () => {
    const gym = withMedia('GYM')
    saved.set(gym.id, gym)

    await removeProject(gym.id)
    expect(saved.has(gym.id)).toBe(false)
    // The media stay while Undo is on offer.
    expect(vi.mocked(deleteProject)).toHaveBeenCalledWith(gym.id, { keepBytes: true })
    expect(undoOf('Project deleted')?.label).toBe('Undo')

    undoOf('Project deleted')!.onClick()
    await vi.advanceTimersByTimeAsync(UNDO_DELETE_MS + 2000)

    expect(saved.get(gym.id)).toEqual(gym)
    expect(vi.mocked(dropUnusedBlobs)).not.toHaveBeenCalled()
    expect(toasts.map((t) => t.message)).toContain('GYM is back')
  })

  it('without Undo, the media are let go once the toast is gone', async () => {
    const gym = withMedia('GYM')
    saved.set(gym.id, gym)

    await removeProject(gym.id)
    await vi.advanceTimersByTimeAsync(UNDO_DELETE_MS - 1)
    expect(vi.mocked(dropUnusedBlobs)).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)

    expect(vi.mocked(dropUnusedBlobs)).toHaveBeenCalledWith(['asset/a1', 'thumb/a1'])
  })

  it('Undo of the OPEN project puts it back and opens it again', async () => {
    const current = withMedia('Current edit')
    useStore.getState().setProject(current)
    saved.set(current.id, current)
    const other = newProject('Other')
    saved.set(other.id, other)

    await removeProject(current.id)
    expect(useStore.getState().project.id).toBe(other.id)

    undoOf('Project deleted')!.onClick()
    await vi.advanceTimersByTimeAsync(100)

    expect(saved.has(current.id)).toBe(true)
    expect(useStore.getState().project.id).toBe(current.id)
  })
})
