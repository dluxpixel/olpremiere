// The collab session: binds the zustand project to a Yjs doc over a transport.
//
//   local edit  → store.subscribe fires → diffEntities → Y.transact('local')
//               → doc update event (origin 'local') → transport.send
//   remote edit → transport update → Y.applyUpdate(origin 'remote')
//               → entities observer → entitiesToProject → applyRemoteProject
//
// Loop safety: remote applies set `applyingRemote`, so the store subscription
// refreshes its snapshot WITHOUT writing back into the doc; local Y.transacts
// carry origin 'local', so the observer skips them (the store already has that
// state). Media blobs are NOT synced — each peer keeps its own local files;
// missing media renders as placeholders.

import * as Y from 'yjs'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'
import { diffEntities, entitiesToProject, projectToEntities, type Entities, type EntityValue } from './entities'
import type { CollabTransport, PeerPresence } from './transport'

export interface CollabSession {
  room: string
  clientId: string
  /** Live list of the OTHER people in the room (self excluded). */
  peers: () => PeerPresence[]
  subscribePeers: (cb: (peers: PeerPresence[]) => void) => () => void
  leave: () => void
}

const PRESENCE_INTERVAL_MS = 2_000
const PEER_COLORS = ['#ff6b6b', '#4ecdc4', '#ffd166', '#a78bfa', '#f472b6', '#34d399']

const randomId = (): string => crypto.randomUUID().slice(0, 8)

/** Read the shared map into a plain Entities snapshot. */
function snapshotOf(map: Y.Map<EntityValue>): Entities {
  const out: Entities = new Map()
  map.forEach((v, k) => out.set(k, v))
  return out
}

/**
 * Join (or seed) a collab room over the given transport. If the room already
 * has a document, it replaces the local project (the joiner adopts the room);
 * if the room is empty, the local project seeds it.
 */
export function startCollabSession(opts: {
  room: string
  transport: CollabTransport
  name: string
}): CollabSession {
  const { room, transport, name } = opts
  const clientId = randomId()
  const color = PEER_COLORS[Math.abs([...clientId].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % PEER_COLORS.length]

  const doc = new Y.Doc()
  const em = doc.getMap<EntityValue>('entities')
  let applyingRemote = false
  let lastEntities: Entities = projectToEntities(useStore.getState().project)

  // --- outbound: doc updates with local origin go to the wire ---------------
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'local') transport.send(update)
  })

  // --- inbound: wire updates apply with remote origin -----------------------
  const unsubscribeWire = transport.subscribe((update) => {
    try {
      Y.applyUpdate(doc, update, 'remote')
    } catch (err) {
      console.error('collab: dropped malformed update', err)
    }
  })

  // Answer sync requests with the full doc state (new joiners catch up).
  const offSync = transport.onSyncRequest(() => Y.encodeStateAsUpdate(doc))

  // --- doc → store -----------------------------------------------------------
  const observer = (_events: unknown, tx: Y.Transaction): void => {
    if (tx.origin === 'local') return
    const rebuilt = entitiesToProject(snapshotOf(em))
    if (!rebuilt) return // torn/partial remote state — keep the local doc
    applyingRemote = true
    try {
      useStore.getState().applyRemoteProject(rebuilt)
      lastEntities = projectToEntities(rebuilt)
    } finally {
      applyingRemote = false
    }
  }
  em.observeDeep(observer)

  // --- store → doc -----------------------------------------------------------
  const unsubscribeStore = useStore.subscribe(
    (s) => s.project,
    (project) => {
      if (applyingRemote) return
      const next = projectToEntities(project)
      const { changed, removed } = diffEntities(lastEntities, next)
      lastEntities = next
      if (changed.length === 0 && removed.length === 0) return
      doc.transact(() => {
        for (const [key, value] of changed) em.set(key, value)
        for (const key of removed) em.delete(key)
      }, 'local')
    },
  )

  // --- initial sync ----------------------------------------------------------
  // Ask the room for state. If nothing arrives shortly, we're first: seed the
  // doc from the local project. If state DOES arrive, the observer above adopts
  // it (any interim seed merges by CRDT rules — ids differ, so no clobbering).
  transport.requestSync()
  const seedTimer = setTimeout(() => {
    if (em.size === 0) {
      doc.transact(() => {
        for (const [key, value] of lastEntities) em.set(key, value)
      }, 'local')
    }
  }, 1_200)

  // --- presence ---------------------------------------------------------------
  let peers: PeerPresence[] = []
  const peerSubs = new Set<(p: PeerPresence[]) => void>()
  const unsubscribePresence = transport.subscribePresence((all) => {
    peers = all.filter((p) => p.clientId !== clientId)
    for (const cb of peerSubs) cb(peers)
  })
  const beat = (): void => {
    const s = useStore.getState()
    transport.sendPresence({
      clientId,
      name,
      color,
      playheadS: s.ui.playheadS,
      at: Date.now(),
    })
  }
  beat()
  const beatTimer = setInterval(beat, PRESENCE_INTERVAL_MS)

  return {
    room,
    clientId,
    peers: () => peers,
    subscribePeers: (cb) => {
      peerSubs.add(cb)
      return () => peerSubs.delete(cb)
    },
    leave: () => {
      clearTimeout(seedTimer)
      clearInterval(beatTimer)
      unsubscribeStore()
      unsubscribePresence()
      unsubscribeWire()
      offSync()
      em.unobserveDeep(observer)
      doc.destroy()
      transport.close()
    },
  }
}

/** The clip ids under every remote peer's playhead — for future cursor UI. */
export function remotePlayheads(session: CollabSession): { color: string; name: string; playheadS: number }[] {
  const seq = activeSequence(useStore.getState().project)
  return session
    .peers()
    .filter((p) => p.playheadS >= 0 && p.playheadS <= seq.durationS + 60)
    .map((p) => ({ color: p.color, name: p.name, playheadS: p.playheadS }))
}
