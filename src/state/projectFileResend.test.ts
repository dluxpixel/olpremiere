// Sending a project between his PC and his phone, more than once (MD-10).
//
// A newer file may replace the copy here only when that copy is still exactly the
// save the file started from. That kept the PC's work safe, but a RESEND from the
// same device landed as a copy every time, beside a phone copy nobody had touched,
// and a file from before the update landed a fresh copy every time it was opened.
// Two devices in one test: each has its own store, and the file between them is a
// real file on disk, written the way the desktop app writes it.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { newProject, type Project } from '../engine/types'

const dev = vi.hoisted(() => ({
  /** The store of the device the test is on. */
  store: new Map<string, Project>(),
  shown: [] as string[],
}))

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string) => dev.shown.push(message) }) },
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))
vi.mock('./mediaMirror', () => ({ backfillMirror: async () => {} }))
vi.mock('./persistence', () => ({
  saveSettled: vi.fn(async () => {
    const { useStore } = await import('./store')
    dev.store.set(useStore.getState().project.id, useStore.getState().project)
  }),
  rememberOpenProject: vi.fn(async () => {}),
  settleAfterLoad: vi.fn(),
  saveProject: vi.fn(async (p: Project) => {
    dev.store.set(p.id, p)
  }),
  loadProjectById: vi.fn(async (id: string) => dev.store.get(id) ?? null),
  listProjects: vi.fn(async () =>
    [...dev.store.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt })),
  ),
  getBlob: vi.fn(async () => null),
  putBlob: vi.fn(async () => {}),
  deleteBlob: vi.fn(async () => {}),
}))

const { PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION, encodeHeader, exportProjectToFile, importProjectFromFile } =
  await import('./projectFile')
const { useStore } = await import('./store')

let dir = ''
const pc = new Map<string, Project>()
const phone = new Map<string, Project>()
/** What each device has open, so moving between them puts it back. */
const open = new Map<Map<string, Project>, Project>()

/** Move to a device: its store, and the edit it had open. */
function on(device: Map<string, Project>): void {
  if (dev.store === device) return
  open.set(dev.store, useStore.getState().project)
  dev.store = device
  useStore.getState().setProject(open.get(device) ?? newProject('Untitled Project'))
}

/** "Save a copy" on the desktop: the open edit, written to a real file in `name`. */
async function send(name: string): Promise<string> {
  const target = path.join(dir, name)
  const parts: Uint8Array[] = []
  vi.stubGlobal('window', {
    api: {
      isElectron: true,
      pickSavePath: async () => target,
      fileOpenWrite: async () => 1,
      fileWriteChunk: async (_id: number, chunk: ArrayBuffer) => {
        parts.push(new Uint8Array(chunk))
      },
      fileClose: async (_id: number, ok: boolean) => {
        if (ok) await writeFile(target, Buffer.concat(parts))
      },
    },
  })
  try {
    await exportProjectToFile()
  } finally {
    vi.unstubAllGlobals()
  }
  return target
}

/** Open a file from disk the way a drop or Open does. */
async function openFile(file: string): Promise<void> {
  await importProjectFromFile(new File([await readFile(file)], path.basename(file)))
}

/** A file from before the update: it never says where it started from. */
async function oldFile(p: Project, name: string): Promise<string> {
  const target = path.join(dir, name)
  await writeFile(target, encodeHeader({ format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project: p, blobs: [] }))
  return target
}

const named = (store: Map<string, Project>, name: string): Project[] => [...store.values()].filter((p) => p.name === name)
/** One edit, the way any edit bumps `updatedAt`. */
const edit = (): void => useStore.getState().dispatch('Rename', (p) => ({ ...p, name: p.name }), undefined)

// A clock a second apart on every reading, so no two edits on the two devices
// can ever share a stamp by landing in the same millisecond.
let clock = 1_800_000_000_000
let nowSpy: MockInstance<() => number>

beforeEach(async () => {
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000))
  dir = await mkdtemp(path.join(tmpdir(), 'olp-resend-'))
  pc.clear()
  phone.clear()
  open.clear()
  dev.store = pc
  dev.shown.length = 0
  useStore.getState().setProject(newProject('Untitled Project'))
})
afterEach(async () => {
  nowSpy.mockRestore()
  await rm(dir, { recursive: true, force: true })
})

describe('⛔ a resend from the same device replaces an untouched copy in place', () => {
  it('PC sends GYM, the phone opens it, the PC edits and sends again: the phone GYM is replaced, no copy', async () => {
    const gym: Project = { ...newProject('GYM'), id: 'gym-1', updatedAt: 1000 }
    pc.set(gym.id, gym)
    useStore.getState().setProject(gym)
    const first = await send('GYM.olstudio')

    on(phone)
    await openFile(first)
    expect(phone.get('gym-1')?.updatedAt).toBe(1000)

    on(pc)
    edit()
    const v2 = useStore.getState().project.updatedAt
    expect(v2).toBeGreaterThan(1000)
    const second = await send('GYM_1.olstudio')

    on(phone)
    await openFile(second)
    // Replaced in place: the phone had done nothing to its GYM since it opened it.
    expect(phone.get('gym-1')?.updatedAt).toBe(v2)
    expect(named(phone, 'GYM (copy)')).toEqual([])
    expect(dev.shown).not.toContainEqual(expect.stringContaining('both were kept'))
  })

  it('and a third send lands in place too', async () => {
    const gym: Project = { ...newProject('GYM'), id: 'gym-1', updatedAt: 1000 }
    pc.set(gym.id, gym)
    useStore.getState().setProject(gym)
    for (let n = 0; n < 3; n++) {
      on(pc)
      if (n > 0) edit()
      const file = await send(`GYM_${n}.olstudio`)
      on(phone)
      await openFile(file)
    }
    expect([...phone.values()].filter((p) => p.name.startsWith('GYM'))).toHaveLength(1)
  })

  it('the phone edit sent back still never writes over PC work done since the PC sent it', async () => {
    const gym: Project = { ...newProject('GYM'), id: 'gym-1', updatedAt: 1000 }
    pc.set(gym.id, gym)
    useStore.getState().setProject(gym)
    const first = await send('GYM.olstudio')
    on(phone)
    await openFile(first)
    edit()
    const back = await send('GYM from phone.olstudio')

    on(pc)
    edit() // the PC carried on after sending
    const pcWork = useStore.getState().project.updatedAt
    await openFile(back)
    expect(pc.get('gym-1')?.updatedAt).toBe(pcWork)
    expect(named(pc, 'GYM (copy)')).toHaveLength(1)
  })

  it('an Undo after sending does not forget which save went out', async () => {
    const gym: Project = { ...newProject('GYM'), id: 'gym-1', updatedAt: 1000 }
    pc.set(gym.id, gym)
    useStore.getState().setProject(gym)
    edit()
    const sent = useStore.getState().project.updatedAt
    await send('GYM.olstudio')
    expect(useStore.getState().project.fileBaseUpdatedAt).toBe(sent)
    useStore.getState().undo()
    expect(useStore.getState().project.fileBaseUpdatedAt).toBe(sent)
  })
})

describe('⛔ a file from before the update never floods him with copies', () => {
  const gymAt = (updatedAt: number): Project => ({ ...newProject('GYM'), id: 'gym-1', createdAt: 500, updatedAt })

  it('a newer one opened three times lands ONE copy, then opens it', async () => {
    pc.set('gym-1', gymAt(19))
    const file = await oldFile(gymAt(20), 'GYM old.olstudio')
    await openFile(file)
    await openFile(file)
    await openFile(file)
    expect(pc.get('gym-1')?.updatedAt).toBe(19)
    expect(named(pc, 'GYM (copy)')).toHaveLength(1)
    expect([...pc.values()].filter((p) => p.name.startsWith('GYM (copy)'))).toHaveLength(1)
    expect(useStore.getState().project.name).toBe('GYM (copy)')
  })

  it('an older one of his own, opened twice, lands one copy too', async () => {
    pc.set('gym-1', gymAt(30))
    const file = await oldFile(gymAt(20), 'GYM last week.olstudio')
    await openFile(file)
    await openFile(file)
    expect([...pc.values()].filter((p) => p.name.startsWith('GYM (copy)'))).toHaveLength(1)
  })

  it('two different saves land two copies, each with a name of its own', async () => {
    pc.set('gym-1', gymAt(19))
    await openFile(await oldFile(gymAt(20), 'a.olstudio'))
    await openFile(await oldFile(gymAt(21), 'b.olstudio'))
    expect(named(pc, 'GYM (copy)')).toHaveLength(1)
    expect(named(pc, 'GYM (copy)_1')).toHaveLength(1)
  })

  it('a copy he has edited since is his work: the file lands a new copy rather than opening over it', async () => {
    pc.set('gym-1', gymAt(19))
    const file = await oldFile(gymAt(20), 'GYM old.olstudio')
    await openFile(file)
    edit()
    await openFile(file)
    expect([...pc.values()].filter((p) => p.name.startsWith('GYM (copy)'))).toHaveLength(2)
  })
})
