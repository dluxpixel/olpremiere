// Convergence proof for the CRDT + entity-codec composition: two real Y.Docs
// exchange updates (as the transport would), both sides edit CONCURRENTLY, and
// the rebuilt projects come out identical, containing both sides' edits. The
// store bridge itself is exercised end-to-end by the two-tab e2e.

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { newClipFromAsset, newProject, type MediaAsset, type Project } from '../engine/types'
import { clipKey, entitiesToProject, projectToEntities, type EntityValue } from './entities'

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 4,
  hasAudio: true,
  hasVideo: true,
})

function baseProject(): Project {
  const p = newProject('Room')
  const a = asset('a1')
  p.assets[a.id] = a
  const seq = p.sequences[p.activeSequenceId]
  const video = seq.tracks.find((t) => t.kind === 'video')!
  video.clips.push({ ...newClipFromAsset(a, 0), id: 'c1' })
  seq.durationS = 4
  return p
}

function seed(doc: Y.Doc, p: Project): void {
  const em = doc.getMap<EntityValue>('entities')
  doc.transact(() => {
    for (const [k, v] of projectToEntities(p)) em.set(k, v)
  }, 'local')
}

function snapshot(doc: Y.Doc): Project | null {
  const em = doc.getMap<EntityValue>('entities')
  const out = new Map<string, EntityValue>()
  em.forEach((v, k) => out.set(k, v))
  return entitiesToProject(out)
}

/** Bidirectional sync (like the wire would, eventually). */
function syncBoth(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote')
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote')
}

describe('two-peer convergence', () => {
  it('a joiner adopts the seeded room state', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const p = baseProject()
    seed(a, p)
    syncBoth(a, b)
    expect(snapshot(b)).toEqual(snapshot(a))
    expect(snapshot(b)).toEqual(p)
  })

  it('concurrent edits on both peers merge and converge', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const p = baseProject()
    const seqId = p.activeSequenceId
    const trackId = p.sequences[seqId].tracks.find((t) => t.kind === 'video')!.id
    seed(a, p)
    syncBoth(a, b)

    // OFFLINE: A moves c1; B adds c2 — no exchange until both are done.
    const emA = a.getMap<EntityValue>('entities')
    const movedC1 = structuredClone((emA.get(clipKey(seqId, trackId, 'c1')) as { clip: { startS: number } }).clip)
    movedC1.startS = 7
    a.transact(() => emA.set(clipKey(seqId, trackId, 'c1'), { clip: movedC1 }), 'local')

    const emB = b.getMap<EntityValue>('entities')
    const c2 = { ...newClipFromAsset(asset('a1'), 2), id: 'c2' }
    b.transact(() => emB.set(clipKey(seqId, trackId, 'c2'), { clip: c2 }), 'local')

    syncBoth(a, b)

    const projA = snapshot(a)!
    const projB = snapshot(b)!
    expect(projA).toEqual(projB) // convergence
    const clips = projA.sequences[seqId].tracks.find((t) => t.id === trackId)!.clips
    expect(clips.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(clips.find((c) => c.id === 'c1')!.startS).toBe(7) // A's move survived
    expect(clips.map((c) => c.startS)).toEqual([2, 7]) // sorted invariant holds
  })

  it('concurrent edits to the SAME clip converge to ONE winner (no tearing)', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const p = baseProject()
    const seqId = p.activeSequenceId
    const trackId = p.sequences[seqId].tracks.find((t) => t.kind === 'video')!.id
    const key = clipKey(seqId, trackId, 'c1')
    seed(a, p)
    syncBoth(a, b)

    const emA = a.getMap<EntityValue>('entities')
    const mine = structuredClone((emA.get(key) as { clip: { opacity: number; startS: number } }).clip)
    mine.opacity = 0.25
    a.transact(() => emA.set(key, { clip: mine }), 'local')

    const emB = b.getMap<EntityValue>('entities')
    const theirs = structuredClone((emB.get(key) as { clip: { opacity: number; startS: number } }).clip)
    theirs.startS = 9
    b.transact(() => emB.set(key, { clip: theirs }), 'local')

    syncBoth(a, b)
    const projA = snapshot(a)!
    const projB = snapshot(b)!
    expect(projA).toEqual(projB)
    const c1A = projA.sequences[seqId].tracks.find((t) => t.id === trackId)!.clips.find((c) => c.id === 'c1')!
    // One whole-clip version won (LWW) — never a torn mix of both edits.
    const isMine = c1A.opacity === 0.25 && c1A.startS === 0
    const isTheirs = c1A.opacity === 1 && c1A.startS === 9
    expect(isMine || isTheirs).toBe(true)
  })
})
