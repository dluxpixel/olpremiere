// The join handshake, exercised against the real store. Regression for the
// 2026-07-14 blank-room flake: a joiner that blind-seeded its boot placeholder
// while the creator's answer was still in flight could win the `meta` LWW and
// lock every peer onto an empty sequence. The rules under test:
//   - creator: seeds the doc IMMEDIATELY (sync answers are real from t=0)
//   - joiner: never seeds while the room might still answer; re-requests sync;
//     adopts a late answer cleanly; seeds only after the dead-room fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { newClipFromAsset, newProject, type MediaAsset, type Project } from '../engine/types'
import { useStore } from '../state/store'
import { entitiesToProject, projectToEntities, type EntityValue } from './entities'
import { startCollabSession, type CollabSession } from './session'
import type { CollabTransport, PeerPresence } from './transport'

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 4,
  hasAudio: true,
  hasVideo: true,
})

/** A project with one clip: either the creator's, or the room's document. */
function projectWithClip(name: string): Project {
  const p = newProject(name)
  p.assets.a1 = asset('a1')
  const seq = p.sequences[p.activeSequenceId]
  seq.tracks.find((t) => t.kind === 'video')!.clips.push({ ...newClipFromAsset(asset('a1'), 0), id: 'c1' })
  seq.durationS = 4
  return p
}

class FakeTransport implements CollabTransport {
  sentUpdates: Uint8Array[] = []
  syncRequests = 0
  provider: (() => Uint8Array) | null = null
  private updateCb: ((u: Uint8Array) => void) | null = null
  send(u: Uint8Array): void {
    this.sentUpdates.push(u)
  }
  subscribe(cb: (u: Uint8Array) => void): () => void {
    this.updateCb = cb
    return () => {
      this.updateCb = null
    }
  }
  requestSync(): void {
    this.syncRequests++
  }
  onSyncRequest(p: () => Uint8Array): () => void {
    this.provider = p
    return () => {
      this.provider = null
    }
  }
  sendPresence(state: PeerPresence): void {
    void state
  }
  subscribePresence(cb: (peers: PeerPresence[]) => void): () => void {
    void cb
    return () => {}
  }
  close(): void {}
  /** Test helper: a remote peer's answer arrives on the wire. */
  deliver(u: Uint8Array): void {
    this.updateCb?.(u)
  }
}

/** Encode a full room document (what a live peer answers a sync request with). */
function roomAnswer(p: Project): Uint8Array {
  const doc = new Y.Doc()
  const em = doc.getMap<EntityValue>('entities')
  doc.transact(() => {
    for (const [k, v] of projectToEntities(p)) em.set(k, v)
  })
  return Y.encodeStateAsUpdate(doc)
}

const decodeToProject = (u: Uint8Array): Project | null => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, u)
  const em = doc.getMap<EntityValue>('entities')
  const out = new Map<string, EntityValue>()
  em.forEach((v, k) => out.set(k, v))
  return entitiesToProject(out)
}

let session: CollabSession | null = null

beforeEach(() => {
  vi.useFakeTimers()
  useStore.getState().setProject(newProject('Boot placeholder'))
  useStore.getState().setUI({ selection: [] })
})

afterEach(() => {
  session?.leave()
  session = null
  vi.useRealTimers()
})

describe('creator handshake', () => {
  it('seeds the room document immediately, so sync answers are real from t=0', () => {
    const mine = projectWithClip('Creator project')
    useStore.getState().setProject(mine)
    const t = new FakeTransport()
    let readyAt = -1
    session = startCollabSession({ room: 'r1', transport: t, name: 'A', role: 'creator' })
    session.onReady(() => (readyAt = t.sentUpdates.length))
    expect(readyAt).toBeGreaterThanOrEqual(0) // ready synchronously (cb ran at once)
    // The doc already holds the project: a sync request answered NOW returns it.
    const answered = decodeToProject(t.provider!())
    expect(answered?.id).toBe(mine.id)
    const clips = answered!.sequences[answered!.activeSequenceId].tracks.flatMap((tr) => tr.clips)
    expect(clips.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('joiner handshake', () => {
  it('never blind-seeds while the room might answer; adopts a LATE answer cleanly', () => {
    const t = new FakeTransport()
    let ready = false
    session = startCollabSession({ room: 'r1', transport: t, name: 'B', role: 'joiner' })
    session.onReady(() => (ready = true))

    // Well past the old 1.2s deadline: still asking, still NOT seeding.
    vi.advanceTimersByTime(3_000)
    expect(t.sentUpdates).toHaveLength(0) // the placeholder never hit the wire
    expect(t.syncRequests).toBeGreaterThan(3) // initial + retries
    expect(ready).toBe(false)

    // The creator's answer finally lands, and the room's document wins outright.
    const room = projectWithClip('Room project')
    t.deliver(roomAnswer(room))
    expect(ready).toBe(true)
    const adopted = useStore.getState().project
    expect(adopted.id).toBe(room.id)
    expect(adopted.sequences[adopted.activeSequenceId].tracks.flatMap((tr) => tr.clips)).toHaveLength(1)

    // Settled: no more sync requests, and adoption itself broadcast nothing.
    const requestsAtReady = t.syncRequests
    vi.advanceTimersByTime(3_000)
    expect(t.syncRequests).toBe(requestsAtReady)
    expect(t.sentUpdates).toHaveLength(0)
  })

  it('seeds its local project only after the dead-room fallback', () => {
    const t = new FakeTransport()
    let ready = false
    session = startCollabSession({ room: 'r1', transport: t, name: 'B', role: 'joiner' })
    session.onReady(() => (ready = true))

    vi.advanceTimersByTime(7_900)
    expect(t.sentUpdates).toHaveLength(0)
    expect(ready).toBe(false)

    vi.advanceTimersByTime(200) // cross SEED_FALLBACK_MS: room is dead
    expect(ready).toBe(true)
    expect(t.sentUpdates.length).toBeGreaterThan(0)
    const seeded = decodeToProject(t.sentUpdates[0])
    expect(seeded?.id).toBe(useStore.getState().project.id) // OUR project became the doc
  })
})
