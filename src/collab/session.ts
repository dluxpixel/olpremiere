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
// state). Media blobs are NOT synced: each peer keeps its own local files;
// missing media renders as placeholders.

import * as Y from 'yjs'
import { useStore } from '../state/store'
import {
  diffEntities,
  entitiesToProject,
  META_KEY,
  projectToEntities,
  type Entities,
  type EntityValue,
} from './entities'
import type { CollabTransport, PeerPresence } from './transport'

export interface CollabSession {
  room: string
  clientId: string
  /** Live list of the OTHER people in the room (self excluded). */
  peers: () => PeerPresence[]
  subscribePeers: (cb: (peers: PeerPresence[]) => void) => () => void
  /** Rename this editor; the next heartbeat (≤2s) carries it to everyone. */
  setName: (name: string) => void
  /**
   * Fires ONCE when the session knows which document the room holds. Either
   * we adopted the room's state, or the room was empty and we seeded it. Media
   * sync must not start earlier: before adoption the store still holds the
   * joiner's PRIVATE project, and uploading its media to a foreign room's
   * public store would leak it.
   */
  onReady: (cb: () => void) => () => void
  leave: () => void
}

const PRESENCE_INTERVAL_MS = 2_000
/**
 * Joiner: how often to re-ask a silent room for state. A ONE-SHOT request
 * loses to any main-thread stall on either side (dev-server module storms,
 * busy host), and the peer that answers re-answers full state, so repeats
 * are free (CRDT-idempotent).
 */
const RESYNC_INTERVAL_MS = 700
/**
 * Joiner: how long a room must stay completely silent before we conclude it's
 * dead and adopt the LOCAL project as its document. Deliberately long: seeding
 * while a live peer's answer is still in flight is how a joiner's blank
 * placeholder used to win the `meta` LWW and lock every timeline in the room
 * onto an empty sequence (the collab e2e flake of 2026-07-14).
 */
const SEED_FALLBACK_MS = 8_000
const PEER_COLORS = ['#ff6b6b', '#4ecdc4', '#ffd166', '#a78bfa', '#f472b6', '#34d399']

const randomId = (): string => crypto.randomUUID().slice(0, 8)

/** Read the shared map into a plain Entities snapshot. */
function snapshotOf(map: Y.Map<EntityValue>): Entities {
  const out: Entities = new Map()
  map.forEach((v, k) => out.set(k, v))
  return out
}

/**
 * Join (or seed) a collab room over the given transport.
 *
 * role 'creator': a freshly minted room id. Nobody else can hold state, so
 * the local project IS the document, immediately. Seeding right away also
 * means sync requests are answered with REAL state from t=0 (the old deferred
 * seed answered early joiners with an empty doc).
 *
 * role 'joiner' (room id came from a URL): the room's document wins, so ask for
 * it, keep asking, and adopt what answers. The local project seeds the room
 * only after a long silence, which means the room is genuinely dead (tabs
 * mode with the creator's tab closed).
 */
export function startCollabSession(opts: {
  room: string
  transport: CollabTransport
  name: string
  role: 'creator' | 'joiner'
}): CollabSession {
  const { room, transport, name, role } = opts
  const clientId = randomId()
  const color = PEER_COLORS[Math.abs([...clientId].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % PEER_COLORS.length]

  const doc = new Y.Doc()
  const em = doc.getMap<EntityValue>('entities')
  let applyingRemote = false
  let lastEntities: Entities = projectToEntities(useStore.getState().project)

  // Ready = the room's document identity is settled (adopted or seeded).
  const readyCbs = new Set<() => void>()
  let ready = false
  let seedTimer: ReturnType<typeof setTimeout> | null = null
  let resyncTimer: ReturnType<typeof setInterval> | null = null
  const fireReady = (): void => {
    if (ready) return
    ready = true
    if (seedTimer) clearTimeout(seedTimer)
    if (resyncTimer) clearInterval(resyncTimer)
    seedTimer = null
    resyncTimer = null
    for (const cb of readyCbs) cb()
    readyCbs.clear()
  }

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
    if (!rebuilt) return // torn/partial remote state, so keep the local doc
    applyingRemote = true
    try {
      useStore.getState().applyRemoteProject(rebuilt)
      lastEntities = projectToEntities(rebuilt)
    } finally {
      applyingRemote = false
    }
    fireReady() // adopted the room's document
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
  // NOT symmetric, on purpose. Entities mostly merge by disjoint ids, but
  // `meta` is ONE shared key: when a joiner blind-seeds its local placeholder
  // concurrently with the room's real state, the meta LWW is a client-id coin
  // flip: lose it and activeSequenceId points at the placeholder's empty
  // sequence on EVERY peer. So only a creator seeds eagerly; a joiner adopts.
  const seedFromLocal = (): void => {
    doc.transact(() => {
      for (const [key, value] of lastEntities) em.set(key, value)
    }, 'local')
    fireReady() // OUR project is the room's document
  }
  if (role === 'creator') {
    seedFromLocal()
  } else {
    transport.requestSync()
    resyncTimer = setInterval(() => transport.requestSync(), RESYNC_INTERVAL_MS)
    seedTimer = setTimeout(() => {
      // Silence this long = dead room. em.size > 0 without ready means SOME
      // state arrived but never rebuilt into a valid project, so keep asking
      // rather than merge a second identity into a live-but-torn room.
      if (!ready && em.size === 0) seedFromLocal()
    }, SEED_FALLBACK_MS)
  }

  // --- presence ---------------------------------------------------------------
  let peers: PeerPresence[] = []
  const peerSubs = new Set<(p: PeerPresence[]) => void>()
  const unsubscribePresence = transport.subscribePresence((all) => {
    peers = all.filter((p) => p.clientId !== clientId)
    for (const cb of peerSubs) cb(peers)
  })
  let currentName = name
  const beat = (): void => {
    const s = useStore.getState()
    transport.sendPresence({
      clientId,
      name: currentName,
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
    setName: (n) => {
      currentName = n
      beat()
    },
    onReady: (cb) => {
      if (ready) {
        cb()
        return () => undefined
      }
      readyCbs.add(cb)
      return () => readyCbs.delete(cb)
    },
    leave: () => {
      if (seedTimer) clearTimeout(seedTimer)
      if (resyncTimer) clearInterval(resyncTimer)
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

/**
 * REBASED undo/redo for rooms. Plain undo restores a whole-project snapshot, and
 * in a room that snapshot predates everyone else's recent edits, so applying
 * it would silently wipe them. Instead: pop the user's own top command, take
 * ONLY that command's entity delta, and apply its inverse onto the CURRENT
 * shared state. Other people's work survives; your last edit reverts; the
 * change broadcasts like any local edit. Returns the command label, or null
 * when the stack is empty.
 */
export function rebasedHistoryStep(dir: 'undo' | 'redo'): string | null {
  const store = useStore.getState()
  const cmd = store.popHistory(dir)
  if (!cmd) return null
  // A command recorded against a DIFFERENT project (before a room adoption
  // slipped in) must never rebase into this one. Discard it outright.
  if (cmd.before.id !== store.project.id) return null
  // Undo applies after→before; redo applies before→after.
  const src = dir === 'undo' ? cmd.after : cmd.before
  const dst = dir === 'undo' ? cmd.before : cmd.after
  const from = projectToEntities(src)
  const to = projectToEntities(dst)
  const { changed, removed } = diffEntities(from, to)

  const current = projectToEntities(store.project)
  for (const [key, value] of changed) {
    if (key === META_KEY) {
      // dispatch() bumps updatedAt, so META differs on virtually EVERY command,
      // and writing it wholesale would revert other people's project rename /
      // aspect switch / active-sequence on any unrelated undo. Merge only the
      // meta fields THIS command genuinely changed onto the current meta.
      const cur = current.get(META_KEY)
      if (!cur) continue
      const merged: EntityValue = { ...cur }
      let touched = false
      for (const field of ['name', 'settings', 'activeSequenceId'] as const) {
        if (JSON.stringify(src[field]) !== JSON.stringify(dst[field])) {
          merged[field] = dst[field] as never
          touched = true
        }
      }
      if (touched) current.set(META_KEY, merged)
      continue
    }
    current.set(key, value)
  }
  for (const key of removed) current.delete(key)
  const rebuilt = entitiesToProject(current)
  if (!rebuilt) return cmd.label // degenerate (e.g. undoing the seed itself), so drop the step
  // Goes through the normal store path WITHOUT a history push; the session's
  // store subscription sees it as a local change and broadcasts the delta.
  store.applyRemoteProject(rebuilt)
  return cmd.label
}
