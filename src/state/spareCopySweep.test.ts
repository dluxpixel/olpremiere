// The page's half of the 7 day spare copy cleanup: it must tell main EVERYTHING
// the store uses, and never ask at all while media is coming in or going out.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newClipFromAsset, newProject, type MediaAsset, type Project } from '../engine/types'

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  importing: 0,
  exportStage: null as null | { kind: string },
  held: null as string | null,
}))
vi.mock('./persistence', () => ({
  db: async () => ({ getAll: async () => state.projects }),
  // What switching edit tabs reaches for: every edit is saved already.
  saveSettled: async () => {},
  settleAfterLoad: () => {},
  rememberOpenProject: async () => {},
  loadProjectById: async (id: string) => state.projects.find((p) => p.id === id) ?? null,
  listProjects: async () => [],
}))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))
vi.mock('./transcribeActions', () => ({ useTranscribe: { getState: () => ({ status: 'idle' }) } }))
vi.mock('./voiceRecorder', () => ({
  useRecorder: { getState: () => ({ recording: false, pendingTake: null, keeping: false }) },
}))
vi.mock('./mediaActions', () => ({ useImportProgress: { getState: () => ({ total: state.importing }) } }))
vi.mock('./exportJob', () => ({
  useExportJob: { getState: () => ({ job: state.exportStage ? { stage: state.exportStage } : null }) },
  isExportActive: (s: { kind: string }) => s.kind === 'starting' || s.kind === 'running',
}))
vi.mock('./spareCopyHold', () => ({ spareCopyCleanupHeld: () => state.held }))

const { assetIdsUsedBy, sweepSpareCopies } = await import('./spareCopySweep')
const { switchTo } = await import('./editTabs')
const { copySelection } = await import('./clipboard')
const { usage } = await import('./usageLog')
const { useStore } = await import('./store')

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 4,
  hasAudio: true,
  hasVideo: true,
})
const withAssets = (...ids: string[]): Project => ({
  ...newProject('P'),
  assets: Object.fromEntries(ids.map((id) => [id, asset(id)])),
})

type Outcome = { removed: string[]; freedBytes: number; waiting: number; refused?: string; code?: string; busy?: boolean }

function shell(answer: Outcome = { removed: [], freedBytes: 0, waiting: 0 }) {
  const calls: { projects: number; ids: string[] }[] = []
  const projectIds: string[][] = []
  return {
    calls,
    projectIds,
    api: {
      mediaSweepUnused: async (projects: string[], ids: string[]) => {
        calls.push({ projects: projects.length, ids: [...ids].sort() })
        projectIds.push(projects)
        return answer
      },
    },
  }
}

beforeEach(() => {
  state.projects = []
  state.importing = 0
  state.exportStage = null
  state.held = null
  useStore.getState().setProject(newProject('Open'))
})

describe('what the page tells main the store uses', () => {
  it('every project, the open edit, and every undo step, so an Undo never finds its copy gone', async () => {
    state.projects = [withAssets('a'), withAssets('b')]
    useStore.getState().setProject(withAssets('open'))
    // A file removed from the bin: only the undo history still has it.
    useStore.getState().dispatch('Import', (p) => ({ ...p, assets: { ...p.assets, removed: asset('removed') } }))
    useStore.getState().dispatch('Remove', (p) => {
      const assets = { ...p.assets }
      delete assets.removed
      return { ...p, assets }
    })
    const { api, calls } = shell()
    await sweepSpareCopies(api)
    expect(calls).toEqual([{ projects: 2, ids: ['a', 'b', 'open', 'removed'] }])
  })

  it('every undo step of a sleeping edit tab, so waking it and pressing Undo never finds its copy gone', async () => {
    const left = withAssets('kept')
    state.projects = [left]
    useStore.getState().setProject(left)
    // A file removed from the bin: only that edit's undo history still has it.
    useStore.getState().dispatch('Import', (p) => ({ ...p, assets: { ...p.assets, removed: asset('removed') } }))
    useStore.getState().dispatch('Remove', (p) => {
      const assets = { ...p.assets }
      delete assets.removed
      return { ...p, assets }
    })
    // He moves to another edit tab: that one sleeps, its history kept for Undo.
    expect(await switchTo(withAssets('other'))).toBe('ok')
    const { api, calls } = shell()
    await sweepSpareCopies(api)
    expect(calls[0]?.ids).toContain('removed')
  })

  it('every clip on the clip clipboard, so a paste never brings back a clip whose copy went', async () => {
    state.projects = [withAssets('a')]
    const p = withAssets('copied')
    const seq = p.sequences[p.activeSequenceId]!
    const clip = newClipFromAsset(asset('copied'), 0)
    const tracks = seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t))
    useStore.getState().setProject({ ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } })
    useStore.getState().setUI({ selection: [clip.id] })
    expect(copySelection()).toBe(true)
    // The edit it came from goes, undo history and all: only the clipboard has it.
    useStore.getState().setProject(withAssets('open'))
    const { api, calls } = shell()
    await sweepSpareCopies(api)
    expect(calls[0]?.ids).toContain('copied')
  })

  it('tells main WHICH projects the store holds, so it can check the Projects folder holds them', async () => {
    const a = withAssets('a')
    const b = withAssets('b')
    state.projects = [a, b]
    const { api, projectIds } = shell()
    await sweepSpareCopies(api)
    expect(projectIds).toEqual([[a.id, b.id]])
  })

  it('counts a clip whose media record is gone as still using its id', () => {
    const p = newProject('P')
    const seq = p.sequences[p.activeSequenceId]!
    const tracks = seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [newClipFromAsset(asset('orphan'), 0)] } : t))
    expect(assetIdsUsedBy({ ...p, sequences: { [seq.id]: { ...seq, tracks } } })).toEqual(['orphan'])
  })
})

describe('⛔ when it does not ask at all', () => {
  it('a store that reads empty, the morning it was wiped', async () => {
    const { api, calls } = shell()
    expect(await sweepSpareCopies(api)).toBeNull()
    expect(calls).toEqual([])
  })

  it('while media is being imported', async () => {
    state.projects = [withAssets('a')]
    state.importing = 3
    const { api, calls } = shell()
    expect(await sweepSpareCopies(api)).toBe('busy')
    expect(calls).toEqual([])
  })

  it('while a video is exporting', async () => {
    state.projects = [withAssets('a')]
    state.exportStage = { kind: 'running' }
    const { api, calls } = shell()
    expect(await sweepSpareCopies(api)).toBe('busy')
    expect(calls).toEqual([])
  })

  it('⛔ a start that showed a loss (an empty store, projects put back, a recovery)', async () => {
    state.projects = [withAssets('a')]
    state.held = 'the store had no project to open at start'
    const { api, calls } = shell()
    expect(await sweepSpareCopies(api)).toBeNull()
    expect(calls).toEqual([])
  })

  it('the web build, which has no spare copies', async () => {
    state.projects = [withAssets('a')]
    expect(await sweepSpareCopies(null)).toBeNull()
  })
})

describe('what main answers', () => {
  it('a copy being written is "not now", so the page tries again later instead of giving up for the start', async () => {
    state.projects = [withAssets('a')]
    const { api } = shell({ removed: [], freedBytes: 0, waiting: 0, refused: 'a copy is being written', busy: true })
    expect(await sweepSpareCopies(api)).toBe('busy')
  })

  it('a refusal is written to his usage log as its fixed word, one per reason, never a file name', async () => {
    state.projects = [withAssets('a')]
    const record = vi.spyOn(usage, 'record').mockImplementation(() => {})
    try {
      // Two folder reasons whose text starts the same: the log must tell them apart.
      for (const [code, why] of [
        ['no-media-list', 'could not read every project file: Green_ab9fe413.olpbak does not say what media it uses'],
        ['trash-missing', 'could not read every project file: the Trash folder is not there'],
      ]) {
        const { api } = shell({ removed: [], freedBytes: 0, waiting: 0, refused: why, code })
        await sweepSpareCopies(api)
      }
      const logged = record.mock.calls.filter((c) => c[1] === 'spare-copies')
      expect(logged).toEqual([
        ['session', 'spare-copies', { removed: 0, mb: 0, waiting: 0, refused: 'no-media-list' }],
        ['session', 'spare-copies', { removed: 0, mb: 0, waiting: 0, refused: 'trash-missing' }],
      ])
      expect(JSON.stringify(logged)).not.toContain('Green')
    } finally {
      record.mockRestore()
    }
  })
})
