import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sfxAssetName, sfxById } from '../engine/sfx/sfx'
import { activeSequence, audioTracks, newProject } from '../engine/types'
import { insertSfxAtPlayhead } from './sfxActions'
import { useStore } from './store'

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
vi.mock('./persistence', () => ({
  putBlob: vi.fn(async () => {}),
}))

// Serve the real committed WAV bytes, as the dev server / Vercel would.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const file = String(url).split('/').pop()!
      const bytes = readFileSync(join(__dirname, '..', '..', 'public', 'sfx', file))
      return { ok: true, blob: async () => new Blob([bytes], { type: 'audio/wav' }) }
    }),
  )
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 2 })
})

const seq = () => activeSequence(useStore.getState().project)
const assets = () => Object.values(useStore.getState().project.assets)

describe('insertSfxAtPlayhead', () => {
  it('first use imports the bytes and drops a clip at the playhead in one undo step', async () => {
    await insertSfxAtPlayhead('boom')

    const boom = sfxById('boom')!
    expect(assets()).toHaveLength(1)
    expect(assets()[0].name).toBe(sfxAssetName(boom))
    expect(assets()[0].kind).toBe('audio')

    const track = audioTracks(seq())[0]
    expect(track.clips).toHaveLength(1)
    expect(track.clips[0].startS).toBeCloseTo(2, 6)
    expect(track.clips[0].outS).toBeCloseTo(boom.durationS, 6)
    expect(useStore.getState().ui.selection).toEqual([track.clips[0].id])

    // asset + clip arrived together, so they leave together
    useStore.getState().undo()
    expect(assets()).toHaveLength(0)
    expect(audioTracks(seq())[0].clips).toHaveLength(0)
  })

  it('reuses the existing asset on later inserts', async () => {
    await insertSfxAtPlayhead('hit')
    useStore.getState().setUI({ playheadS: 5 })
    await insertSfxAtPlayhead('hit')

    expect(assets()).toHaveLength(1)
    const clips = audioTracks(seq())[0].clips
    expect(clips).toHaveLength(2)
    expect(clips[1].startS).toBeCloseTo(5, 6)
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
  })

  it('does nothing when every audio track is locked', async () => {
    useStore.getState().dispatch('lock', (p) => {
      const sq = p.sequences[p.activeSequenceId]
      const tracks = sq.tracks.map((t) => (t.kind === 'audio' ? { ...t, locked: true } : t))
      return { ...p, sequences: { ...p.sequences, [sq.id]: { ...sq, tracks } } }
    })
    await insertSfxAtPlayhead('boom')
    expect(assets()).toHaveLength(0)
    expect(seq().tracks.flatMap((t) => t.clips)).toHaveLength(0)
  })

  it('unknown ids and failed fetches leave the project untouched', async () => {
    await insertSfxAtPlayhead('does-not-exist')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob() })))
    await insertSfxAtPlayhead('boom')
    expect(assets()).toHaveLength(0)
  })
})
