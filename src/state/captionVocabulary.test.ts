import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, newTitleClip, type Clip, type Project } from '../engine/types'

// His saved projects, as the persistence layer would hand them over.
const saved = new Map<string, Project>()
vi.mock('./persistence', () => ({
  listProjects: vi.fn(async () => [...saved.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))),
  loadProjectById: vi.fn(async (id: string) => saved.get(id) ?? null),
}))

const { useStore } = await import('./store')
const { currentVocabulary } = await import('./captionVocabulary')
const persistence = await import('./persistence')

/** A project whose only track holds captions: [what the machine wrote, what he left]. */
function projectWith(id: string, pairs: [string, string][], updatedAt = 1): Project {
  const base = useStore.getState().project
  const seqId = Object.keys(base.sequences)[0]
  const seq = base.sequences[seqId]
  const clips: Clip[] = pairs.map(([m, h], i) => ({
    ...newTitleClip(defaultTitleDef(h), i * 0.5, 0.4),
    captionOrigin: { text: m, model: 'm' },
  }))
  return {
    ...base,
    id,
    name: id,
    updatedAt,
    sequences: { [seqId]: { ...seq, tracks: [{ ...seq.tracks[0], clips }] } },
  }
}

describe('currentVocabulary', () => {
  beforeEach(() => {
    saved.clear()
    vi.mocked(persistence.loadProjectById).mockClear()
  })

  it('learns from every saved project, finished or not, and from the open edit', async () => {
    // Once in a saved project and once in the edit he has open: twice, so it applies.
    saved.set('a', projectWith('a', [['Third is', 'third is'], ['Bamban.', 'bun bun']]))
    useStore.setState({ project: projectWith('open', [['Fourth is', 'fourth is'], ['Bamban,', 'bun bun'], ['he has', 'he has']]) })
    const v = await currentVocabulary()
    expect(v.rewrites).toEqual([{ heard: ['bamban'], his: 'bun bun', seen: 2 }])
  })

  it('reads a saved project again only when it has changed', async () => {
    saved.set('b', projectWith('b', [['and', 'and'], ['Cerraral', 'sir rel']], 5))
    await currentVocabulary()
    await currentVocabulary()
    expect(persistence.loadProjectById).toHaveBeenCalledTimes(1)
    saved.set('b', projectWith('b', [['and', 'and'], ['Cerraral', 'sir rel']], 6))
    await currentVocabulary()
    expect(persistence.loadProjectById).toHaveBeenCalledTimes(2)
  })

  it('never stops a caption run: a store that will not read means no vocabulary, not an error', async () => {
    vi.mocked(persistence.listProjects).mockRejectedValueOnce(new Error('the database went away'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(currentVocabulary()).resolves.toEqual({ rewrites: [] })
    warn.mockRestore()
  })
})
