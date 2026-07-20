import { describe, expect, it } from 'vitest'

import { newProject, newSequence, newTrack, type Clip, type MediaAsset, type Project } from '../engine/types'
import { assetIdsUsedBy, planSequenceSplit, sequenceHasWork } from './sequenceSplit'

const clip = (assetId: string): Clip => ({
  id: `clip-${assetId}`,
  assetId,
  startS: 0,
  inS: 0,
  outS: 2,
  speed: 1,
  enabled: true,
  transform: {
    x: 0,
    y: 0,
    scale: 1,
    rotationDeg: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    crop: { t: 0, r: 0, b: 0, l: 0 },
  },
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
})

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  thumbnailKey: `thumb/${id}`,
  durationS: 10,
  hasAudio: true,
  hasVideo: true,
})

/** A project with the active sequence plus `extras`, each seeded with clips. */
function withExtras(extras: { name: string; assetIds: string[] }[]): Project {
  const p = newProject('My Video')
  p.assets = { a: asset('a'), b: asset('b'), unused: asset('unused') }
  for (const e of extras) {
    const seq = newSequence(e.name)
    seq.tracks = [newTrack('video', 'V1')]
    seq.tracks[0].clips = e.assetIds.map(clip)
    p.sequences[seq.id] = seq
  }
  return p
}

describe('planSequenceSplit', () => {
  it('a single-sequence project is returned untouched', () => {
    const p = newProject()
    const plan = planSequenceSplit(p)
    expect(plan.kept).toBe(p)
    expect(plan.spawned).toHaveLength(0)
    expect(plan.blobCopies).toHaveLength(0)
  })

  it('an extra sequence with work becomes its own project', () => {
    const p = withExtras([{ name: 'Sequence 2', assetIds: ['a'] }])
    const plan = planSequenceSplit(p, 123)
    expect(plan.spawned).toHaveLength(1)
    const spawn = plan.spawned[0]
    expect(spawn.id).not.toBe(p.id)
    expect(spawn.name).toBe('My Video (Sequence 2)')
    // Exactly one sequence, and it IS the extra one.
    expect(Object.keys(spawn.sequences)).toHaveLength(1)
    expect(spawn.sequences[spawn.activeSequenceId].name).toBe('Sequence 2')
    // The original keeps only its active sequence.
    expect(Object.keys(plan.kept.sequences)).toEqual([p.activeSequenceId])
  })

  it('copies ONLY the assets that sequence uses, onto FRESH blob keys', () => {
    const p = withExtras([{ name: 'Sequence 2', assetIds: ['a'] }])
    const plan = planSequenceSplit(p)
    const spawn = plan.spawned[0]
    expect(Object.keys(spawn.assets)).toEqual(['a'])
    // Fresh keys: deleteProject removes blobs by key, so a shared key would let
    // deleting one project destroy the other's media.
    expect(spawn.assets.a.blobKey).not.toBe(p.assets.a.blobKey)
    expect(spawn.assets.a.thumbnailKey).not.toBe(p.assets.a.thumbnailKey)
    expect(plan.blobCopies).toEqual([
      { from: 'asset/a', to: spawn.assets.a.blobKey },
      { from: 'thumb/a', to: spawn.assets.a.thumbnailKey },
    ])
  })

  it('drops EMPTY extra sequences instead of spawning junk projects', () => {
    const p = newProject()
    const empty = newSequence('Sequence 2')
    p.sequences[empty.id] = empty
    const plan = planSequenceSplit(p)
    expect(plan.spawned).toHaveLength(0)
    expect(plan.droppedEmpty).toBe(1)
    expect(Object.keys(plan.kept.sequences)).toEqual([p.activeSequenceId])
  })

  it('a named sequence keeps its own name as the project name', () => {
    const p = withExtras([{ name: 'B-roll pass', assetIds: ['b'] }])
    expect(planSequenceSplit(p).spawned[0].name).toBe('B-roll pass')
  })

  it('handles several extras at once', () => {
    const p = withExtras([
      { name: 'Sequence 2', assetIds: ['a'] },
      { name: 'Sequence 3', assetIds: ['b'] },
    ])
    const plan = planSequenceSplit(p)
    expect(plan.spawned).toHaveLength(2)
    expect(plan.spawned.map((s) => Object.keys(s.assets)[0])).toEqual(['a', 'b'])
  })
})

describe('sequenceHasWork / assetIdsUsedBy', () => {
  it('a sequence with no clips and no markers holds nothing', () => {
    expect(sequenceHasWork(newSequence())).toBe(false)
  })

  it('markers alone count as work', () => {
    const seq = newSequence()
    seq.markers = [{ id: 'm', t: 1, label: 'note', color: '#ffa946' }]
    expect(sequenceHasWork(seq)).toBe(true)
  })

  it('title clips carry no assetId and are skipped', () => {
    const seq = newSequence()
    seq.tracks = [newTrack('video', 'V1')]
    seq.tracks[0].clips = [clip('a'), { ...clip(''), id: 'title' }]
    expect([...assetIdsUsedBy(seq)]).toEqual(['a'])
  })
})
