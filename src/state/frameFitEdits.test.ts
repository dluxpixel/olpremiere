import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateProjectAppearance } from '../engine/anim/appearance'
import { migrateProjectEffects } from '../engine/effects/migrate'
import { frameFitOf, frameFitDims } from '../engine/frameFit'
import { resolveFrame } from '../engine/render/resolve'
import { addClipWithLinkedAudio } from '../engine/timeline'
import { activeSequence, migrateProject, newProject, type Clip, type MediaAsset } from '../engine/types'
import { serialize } from './backupFormat'
import { setFrameFitForClips } from './bulkEdits'
import { setClipFrameFit } from './clipEdits'
import { parseProjectFile } from './diskProjects'
import { updateActiveSequence, useStore } from './store'

// His ask, 2026-09-29: "make it so when i for example paste in a 4:3clip it
// stretches to 16:9 when i select to". These drive the two doors the way the
// Inspector and the clip menu do: one clip, or the whole selection, one undo
// step either way, and the choice survives a save and a reopen.

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const asset = (id: string, width: number, height: number): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: id,
  durationS: 10,
  width,
  height,
  hasAudio: true,
  hasVideo: true,
})

const seq = () => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** Put a clip of `a` on V1 with its sound on A1, the way an import lands it (filled). */
function place(a: MediaAsset, startS: number): { video: string; audio: string } {
  const p = useStore.getState().project
  useStore.getState().setProject({ ...p, assets: { ...p.assets, [a.id]: a } })
  let ids = { video: '', audio: '' }
  updateActiveSequence('seed', (sq) => {
    const v1 = sq.tracks.find((t) => t.kind === 'video')!.id
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    const r = addClipWithLinkedAudio(sq, v1, a1, a, startS, { exact: true })
    ids = { video: r.videoClipId, audio: r.audioClipId }
    return r.seq
  })
  return ids
}

const fitOf = (id: string): ReturnType<typeof frameFitOf> => {
  const c = clipById(id)
  return frameFitOf(c, frameFitDims(seq(), useStore.getState().project.assets[c.assetId]))
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('Stretch to fill on one clip', () => {
  it('a pasted 4:3 clip lands filled, as it always has, and stretches when he picks it', () => {
    const { video } = place(asset('tv', 640, 480), 0)
    expect(fitOf(video)).toBe('fill')
    expect(clipById(video).transform.scale).toBeCloseTo(4 / 3, 12)
    setClipFrameFit(video, 'stretch')
    expect(fitOf(video)).toBe('stretch')
    expect(clipById(video).transform).toMatchObject({ fit: 'stretch', scale: 1 })
  })

  it('is one undo step, and undo puts the filled clip back exactly', () => {
    const { video } = place(asset('tv', 640, 480), 0)
    const before = clipById(video)
    setClipFrameFit(video, 'stretch')
    useStore.getState().undo()
    expect(clipById(video)).toEqual(before)
  })

  it('picking what it already shows records nothing', () => {
    const { video } = place(asset('tv', 640, 480), 0)
    const project = useStore.getState().project
    setClipFrameFit(video, 'fill')
    expect(useStore.getState().project).toBe(project)
  })
})

describe('the whole selection at once, from the multi selection Inspector or the clip menu', () => {
  it('stretches every selected picture in ONE undo step, each against its own shape', () => {
    const a = place(asset('tv', 640, 480), 0)
    const b = place(asset('wide', 1920, 1080), 20)
    const c = place(asset('phone', 1080, 1920), 40)
    // The selection carries the linked sound too, exactly as a drag select does.
    setFrameFitForClips([a.video, a.audio, b.video, b.audio, c.video, c.audio], 'stretch')
    expect([a.video, b.video, c.video].map(fitOf)).toEqual(['stretch', 'stretch', 'stretch'])
    // Every one of them now rests on the frame's corners.
    for (const id of [a.video, b.video, c.video]) {
      const op = resolveFrame(seq(), clipById(id).startS + 1).ops[0]
      expect(op?.type === 'layer' && op.layer.transform.fit).toBe('stretch')
      expect(clipById(id).transform.scale).toBe(1)
    }
    // The sound has no picture and is left exactly as it was.
    expect('fit' in clipById(a.audio).transform).toBe(false)
    useStore.getState().undo()
    expect([a.video, b.video, c.video].map(fitOf)).toEqual(['fill', 'fill', 'fill'])
  })

  it('Fit inside on all of them shows every whole picture again', () => {
    const a = place(asset('tv', 640, 480), 0)
    const c = place(asset('phone', 1080, 1920), 20)
    setFrameFitForClips([a.video, c.video], 'fit')
    expect([a.video, c.video].map(fitOf)).toEqual(['fit', 'fit'])
    expect([a.video, c.video].map((id) => clipById(id).transform.scale)).toEqual([1, 1])
  })

  it('skips a locked track, the same as every other bulk edit', () => {
    const a = place(asset('tv', 640, 480), 0)
    updateActiveSequence('lock', (sq) => ({ ...sq, tracks: sq.tracks.map((t) => ({ ...t, locked: true })) }))
    setFrameFitForClips([a.video], 'stretch')
    expect(fitOf(a.video)).toBe('fill')
  })
})

describe('saved in the project, and reopened intact', () => {
  it('a stretched clip comes back stretched from the file on disk', () => {
    const { video } = place(asset('tv', 640, 480), 0)
    setClipFrameFit(video, 'stretch')
    const project = useStore.getState().project
    // The desktop app's own write and read, then the same migrations a load runs.
    const reopened = parseProjectFile(serialize(project, 'desktop'), project.id)
    expect(reopened).not.toBeNull()
    const loaded = migrateProjectAppearance(migrateProjectEffects(migrateProject(reopened!)))
    const back = activeSequence(loaded).tracks.flatMap((t) => t.clips).find((c) => c.id === video)!
    expect(back.transform).toEqual(clipById(video).transform)
    const op = resolveFrame(activeSequence(loaded), 1).ops[0]
    expect(op?.type === 'layer' && op.layer.transform.fit).toBe('stretch')
  })

  it('and a project made before stretch existed reopens with no fit on any clip', () => {
    const { video } = place(asset('tv', 640, 480), 0)
    const project = useStore.getState().project
    const raw = serialize(project, 'desktop')
    expect(raw).not.toContain('"fit"')
    const reopened = parseProjectFile(raw, project.id)!
    const back = activeSequence(reopened).tracks.flatMap((t) => t.clips).find((c) => c.id === video)!
    expect(back.transform).toEqual(clipById(video).transform)
  })
})
