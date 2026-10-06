// The page's half of the 7 day spare copy cleanup: it must tell main EVERYTHING
// the store uses, and never ask at all while media is coming in or going out.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newClipFromAsset, newProject, type MediaAsset, type Project } from '../engine/types'

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  importing: 0,
  exportStage: null as null | { kind: string },
}))
vi.mock('./persistence', () => ({ db: async () => ({ getAll: async () => state.projects }) }))
vi.mock('./mediaActions', () => ({ useImportProgress: { getState: () => ({ total: state.importing }) } }))
vi.mock('./exportJob', () => ({
  useExportJob: { getState: () => ({ job: state.exportStage ? { stage: state.exportStage } : null }) },
  isExportActive: (s: { kind: string }) => s.kind === 'starting' || s.kind === 'running',
}))

const { assetIdsUsedBy, sweepSpareCopies } = await import('./spareCopySweep')
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

function shell() {
  const calls: { projects: number; ids: string[] }[] = []
  return {
    calls,
    api: {
      mediaSweepUnused: async (projects: number, ids: string[]) => {
        calls.push({ projects, ids: [...ids].sort() })
        return { removed: [], freedBytes: 0, waiting: 0 }
      },
    },
  }
}

beforeEach(() => {
  state.projects = []
  state.importing = 0
  state.exportStage = null
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

  it('the web build, which has no spare copies', async () => {
    state.projects = [withAssets('a')]
    expect(await sweepSpareCopies(null)).toBeNull()
  })
})
