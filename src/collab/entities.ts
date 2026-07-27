// Collab entity codec: Project ⇄ a FLAT map of small JSON entities. This is the
// granularity the CRDT merges at (one Yjs map key per entity, last-write-wins
// per key), chosen so the common collaborative actions compose instead of
// clobbering:
//   - two people editing DIFFERENT clips → both edits survive (different keys)
//   - two people ADDING clips, even on the same track → both clips survive
//     (clips are collected by key prefix, not stored in an order array)
//   - editing the SAME clip concurrently → last write wins on that clip only
// Track order rides on the sequence entity (LWW), but tracks that exist as
// entities without an order slot are APPENDED rather than dropped, so a
// concurrent add-track never deletes the other person's track.
//
// Pure data-in/data-out: no Yjs, no store, no DOM. structuredClone-safe.

import type { Clip, MediaAsset, Project, Sequence, Track } from '../engine/types'

export type EntityKey = string
export type EntityValue = Record<string, unknown>
export type Entities = Map<EntityKey, EntityValue>

export const META_KEY = 'meta'
export const seqKey = (seqId: string): string => `seq:${seqId}`
export const trackKey = (seqId: string, trackId: string): string => `track:${seqId}:${trackId}`
export const clipKey = (seqId: string, trackId: string, clipId: string): string =>
  `clip:${seqId}:${trackId}:${clipId}`
export const assetKey = (assetId: string): string => `asset:${assetId}`

interface MetaEntity extends EntityValue {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  activeSequenceId: string
  settings: Project['settings']
}

interface SeqEntity extends EntityValue {
  /** Sequence fields minus `tracks`; track order is explicit. */
  seq: Omit<Sequence, 'tracks'>
  trackOrder: string[]
}

interface TrackEntity extends EntityValue {
  /** Track fields minus `clips` (collected by key prefix + sorted by startS). */
  track: Omit<Track, 'clips'>
}

interface ClipEntity extends EntityValue {
  clip: Clip
}

interface AssetEntity extends EntityValue {
  asset: MediaAsset
}

const strip = <T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> => {
  const copy = { ...obj }
  delete copy[key]
  return copy
}

/** Flatten a project into merge-granular entities. */
export function projectToEntities(p: Project): Entities {
  const out: Entities = new Map()
  const meta: MetaEntity = {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    activeSequenceId: p.activeSequenceId,
    settings: p.settings,
  }
  out.set(META_KEY, meta)
  for (const asset of Object.values(p.assets)) {
    out.set(assetKey(asset.id), { asset } satisfies AssetEntity)
  }
  for (const seq of Object.values(p.sequences)) {
    out.set(seqKey(seq.id), {
      seq: strip(seq, 'tracks'),
      trackOrder: seq.tracks.map((t) => t.id),
    } satisfies SeqEntity)
    for (const track of seq.tracks) {
      out.set(trackKey(seq.id, track.id), { track: strip(track, 'clips') } satisfies TrackEntity)
      for (const clip of track.clips) {
        out.set(clipKey(seq.id, track.id, clip.id), { clip } satisfies ClipEntity)
      }
    }
  }
  return out
}

/**
 * Rebuild a Project from entities. Tolerant by construction: unknown keys are
 * ignored, tracks missing from the order are appended (video before audio so
 * the kind-blocks stay contiguous), clips sort by startS (the document
 * invariant), and a missing meta/sequence yields null so the caller keeps its
 * local document instead of applying a torn remote state.
 */
export function entitiesToProject(entities: Entities): Project | null {
  const meta = entities.get(META_KEY) as MetaEntity | undefined
  if (!meta || typeof meta.id !== 'string' || typeof meta.activeSequenceId !== 'string') return null

  const assets: Record<string, MediaAsset> = {}
  const seqEntities = new Map<string, SeqEntity>()
  const trackEntities = new Map<string, Map<string, TrackEntity>>() // seqId → trackId → entity
  const clipEntities = new Map<string, Map<string, ClipEntity[]>>() // seqId → trackId → clips

  for (const [key, value] of entities) {
    const parts = key.split(':')
    if (parts[0] === 'asset' && parts.length === 2) {
      const a = (value as AssetEntity).asset
      if (a && typeof a.id === 'string') assets[a.id] = a
    } else if (parts[0] === 'seq' && parts.length === 2) {
      const e = value as SeqEntity
      if (e?.seq && typeof e.seq.id === 'string') seqEntities.set(parts[1], e)
    } else if (parts[0] === 'track' && parts.length === 3) {
      const e = value as TrackEntity
      if (e?.track && typeof e.track.id === 'string') {
        let m = trackEntities.get(parts[1])
        if (!m) trackEntities.set(parts[1], (m = new Map()))
        m.set(parts[2], e)
      }
    } else if (parts[0] === 'clip' && parts.length === 4) {
      const e = value as ClipEntity
      if (e?.clip && typeof e.clip.id === 'string') {
        let bySeq = clipEntities.get(parts[1])
        if (!bySeq) clipEntities.set(parts[1], (bySeq = new Map()))
        let list = bySeq.get(parts[2])
        if (!list) bySeq.set(parts[2], (list = []))
        list.push(e)
      }
    }
  }

  const sequences: Record<string, Sequence> = {}
  for (const [seqId, se] of seqEntities) {
    const trackMap = trackEntities.get(seqId) ?? new Map<string, TrackEntity>()
    const ordered: string[] = []
    const seen = new Set<string>()
    for (const id of Array.isArray(se.trackOrder) ? se.trackOrder : []) {
      if (trackMap.has(id) && !seen.has(id)) {
        ordered.push(id)
        seen.add(id)
      }
    }
    // Tracks added concurrently elsewhere: never drop them. Video tracks join
    // the video block (before the first audio track), audio appends at the end.
    for (const [id, te] of trackMap) {
      if (seen.has(id)) continue
      if (te.track.kind === 'video') {
        const firstAudio = ordered.findIndex((tid) => trackMap.get(tid)?.track.kind === 'audio')
        ordered.splice(firstAudio === -1 ? ordered.length : firstAudio, 0, id)
      } else {
        ordered.push(id)
      }
      seen.add(id)
    }

    const clipsByTrack = clipEntities.get(seqId)
    const tracks: Track[] = ordered.map((trackId) => {
      const te = trackMap.get(trackId)!
      const clips = (clipsByTrack?.get(trackId) ?? [])
        .map((e) => e.clip)
        .sort((a, b) => a.startS - b.startS || a.id.localeCompare(b.id))
      return { ...te.track, clips }
    })
    sequences[seqId] = { ...se.seq, tracks }
  }

  if (Object.keys(sequences).length === 0) return null
  const activeSequenceId = sequences[meta.activeSequenceId]
    ? meta.activeSequenceId
    : Object.keys(sequences)[0]

  return {
    id: meta.id,
    name: meta.name ?? 'Untitled Project',
    createdAt: meta.createdAt ?? 0,
    updatedAt: meta.updatedAt ?? meta.createdAt ?? 0,
    assets,
    sequences,
    activeSequenceId,
    settings: meta.settings ?? { fps: 30, width: 1920, height: 1080, sampleRate: 48000 },
  }
}

/**
 * Keys whose values differ between two entity snapshots (JSON-compare, cheap
 * at entity granularity thanks to the store's structural sharing) plus keys
 * removed in `next`. This is what a local edit writes into the shared doc.
 */
export function diffEntities(
  prev: Entities,
  next: Entities,
): { changed: [EntityKey, EntityValue][]; removed: EntityKey[] } {
  const changed: [EntityKey, EntityValue][] = []
  const removed: EntityKey[] = []
  for (const [key, value] of next) {
    const old = prev.get(key)
    if (old === undefined || (old !== value && JSON.stringify(old) !== JSON.stringify(value))) {
      changed.push([key, value])
    }
  }
  for (const key of prev.keys()) {
    if (!next.has(key)) removed.push(key)
  }
  return { changed, removed }
}
