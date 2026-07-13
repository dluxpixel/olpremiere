import { describe, expect, it } from 'vitest'
import {
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  newTrack,
  type MediaAsset,
  type Project,
} from '../engine/types'
import { clipKey, diffEntities, entitiesToProject, projectToEntities, trackKey } from './entities'

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 4,
  hasAudio: true,
  hasVideo: true,
})

/** A representative project: assets, titles, effects, fades, multiple tracks. */
function richProject(): Project {
  const p = newProject('Collab Test')
  const seq = p.sequences[p.activeSequenceId]
  const a = asset('a1')
  p.assets[a.id] = a
  const video = seq.tracks.find((t) => t.kind === 'video')!
  const c1 = { ...newClipFromAsset(a, 0), id: 'c1' }
  const c2 = { ...newClipFromAsset(a, 5), id: 'c2', fadeInS: 0.5 }
  video.clips.push(c1, c2)
  const title = { ...newTitleClip(defaultTitleDef('Hello'), 2, 3), id: 'c3' }
  seq.tracks.find((t) => t.kind === 'video' && t.id !== video.id)!.clips.push(title)
  seq.durationS = 9
  return p
}

describe('entity codec round-trip', () => {
  it('project → entities → project is lossless (modulo clip sort order)', () => {
    const p = richProject()
    const rebuilt = entitiesToProject(projectToEntities(p))
    expect(rebuilt).not.toBeNull()
    expect(rebuilt).toEqual(p)
  })

  it('rejects a torn snapshot (no meta / no sequences)', () => {
    const p = richProject()
    const entities = projectToEntities(p)
    entities.delete('meta')
    expect(entitiesToProject(entities)).toBeNull()
    const only = projectToEntities(p)
    for (const k of [...only.keys()]) if (k.startsWith('seq:')) only.delete(k)
    expect(entitiesToProject(only)).toBeNull()
  })
})

describe('merge semantics (the collab guarantees)', () => {
  it('concurrent clip adds on the SAME track both survive', () => {
    const base = richProject()
    const seqId = base.activeSequenceId
    const trackId = base.sequences[seqId].tracks.find((t) => t.kind === 'video')!.id

    // Two peers start from the same snapshot and each add a different clip.
    const mine = projectToEntities(base)
    const theirs = projectToEntities(base)
    const myClip = { ...newClipFromAsset(asset('a1'), 10), id: 'mine' }
    const theirClip = { ...newClipFromAsset(asset('a1'), 12), id: 'theirs' }
    mine.set(clipKey(seqId, trackId, 'mine'), { clip: myClip })
    theirs.set(clipKey(seqId, trackId, 'theirs'), { clip: theirClip })

    // LWW-per-key merge (what the CRDT map does): union of both edits.
    const merged = new Map([...mine, ...theirs])
    const rebuilt = entitiesToProject(merged)!
    const clips = rebuilt.sequences[seqId].tracks.find((t) => t.id === trackId)!.clips
    expect(clips.map((c) => c.id)).toContain('mine')
    expect(clips.map((c) => c.id)).toContain('theirs')
    // Sorted by startS — the document invariant.
    const starts = clips.map((c) => c.startS)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  it('a track added concurrently is appended, never dropped', () => {
    const base = richProject()
    const seqId = base.activeSequenceId
    const entities = projectToEntities(base)
    // A peer added V3, but OUR seq entity (trackOrder) won the LWW race and
    // doesn't list it. The rebuild must still include the track.
    const v3 = newTrack('video', 'V3')
    entities.set(trackKey(seqId, v3.id), { track: { ...v3, clips: undefined } as never })
    const rebuilt = entitiesToProject(entities)!
    const tracks = rebuilt.sequences[seqId].tracks
    expect(tracks.some((t) => t.name === 'V3')).toBe(true)
    // Video tracks stay in the video block (before the audio block).
    const kinds = tracks.map((t) => t.kind)
    expect(kinds.lastIndexOf('video')).toBeLessThan(kinds.indexOf('audio'))
  })

  it('editing different clips concurrently keeps both edits', () => {
    // Model what the bridge ACTUALLY writes into the shared map: each peer
    // writes only its own DIFF against the base, never its full snapshot —
    // so a peer's stale copy of an untouched clip can't clobber the other's edit.
    const base = richProject()
    const baseEntities = projectToEntities(base)
    const seqId = base.activeSequenceId
    const trackId = base.sequences[seqId].tracks.find((t) => t.clips.length === 2)!.id

    const mine = projectToEntities(base)
    const c1 = structuredClone((mine.get(clipKey(seqId, trackId, 'c1')) as { clip: { opacity: number } }).clip)
    c1.opacity = 0.5
    mine.set(clipKey(seqId, trackId, 'c1'), { clip: c1 })

    const theirs = projectToEntities(base)
    const c2 = structuredClone((theirs.get(clipKey(seqId, trackId, 'c2')) as { clip: { fadeInS: number } }).clip)
    c2.fadeInS = 2
    theirs.set(clipKey(seqId, trackId, 'c2'), { clip: c2 })

    const merged = new Map(baseEntities)
    for (const [k, v] of diffEntities(baseEntities, mine).changed) merged.set(k, v)
    for (const [k, v] of diffEntities(baseEntities, theirs).changed) merged.set(k, v)

    const rebuilt = entitiesToProject(merged)!
    const clips = rebuilt.sequences[seqId].tracks.find((t) => t.id === trackId)!.clips
    expect(clips.find((c) => c.id === 'c1')!.opacity).toBe(0.5)
    expect(clips.find((c) => c.id === 'c2')!.fadeInS).toBe(2)
  })
})

describe('diffEntities', () => {
  it('reports only what changed, plus removals', () => {
    const p = richProject()
    const before = projectToEntities(p)

    const edited = structuredClone(p)
    const seq = edited.sequences[edited.activeSequenceId]
    const track = seq.tracks.find((t) => t.clips.length === 2)!
    track.clips[0] = { ...track.clips[0], opacity: 0.7 } // change one clip
    track.clips.splice(1, 1) // delete the other
    const after = projectToEntities(edited)

    const { changed, removed } = diffEntities(before, after)
    const changedKeys = changed.map(([k]) => k)
    expect(changedKeys).toContain(clipKey(seq.id, track.id, 'c1'))
    expect(changedKeys.filter((k) => k.startsWith('clip:'))).toHaveLength(1)
    expect(removed).toEqual([clipKey(seq.id, track.id, 'c2')])
  })

  it('is empty for identical snapshots', () => {
    const p = richProject()
    const d = diffEntities(projectToEntities(p), projectToEntities(structuredClone(p)))
    expect(d.changed).toHaveLength(0)
    expect(d.removed).toHaveLength(0)
  })
})
