// App-level collab control: one active session, room-in-URL-hash, transport
// selection. On an origin with the relay deployed (the collab Vercel project)
// rooms sync across machines; anywhere else they fall back to same-machine
// tabs via BroadcastChannel: same UI, honest badge text either way.

import { create } from 'zustand'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { HttpRelayTransport, relayAvailable } from './httpTransport'
import { startMediaSync } from './mediaSync'
import { rebasedHistoryStep, startCollabSession, type CollabSession } from './session'
import { BroadcastChannelTransport, type CollabTransport, type PeerPresence } from './transport'

let stopMediaSync: (() => void) | null = null

interface CollabState {
  session: CollabSession | null
  roomId: string | null
  /** 'relay' = cross-machine via the Vercel relay; 'tabs' = this machine only. */
  mode: 'relay' | 'tabs' | null
  peers: PeerPresence[]
  /** The project open BEFORE joining someone else's room. Leave restores it. */
  preJoinProjectId: string | null
  /** False while the relay is unreachable (badge shows reconnecting). */
  connected: boolean
}

export const useCollab = create<CollabState>(() => ({
  session: null,
  roomId: null,
  mode: null,
  peers: [],
  preJoinProjectId: null,
  connected: true,
}))

const ROOM_HASH_RE = /room=([a-z0-9-]{4,40})/i

export function roomFromHash(hash = window.location.hash): string | null {
  const m = ROOM_HASH_RE.exec(hash)
  return m ? m[1].toLowerCase() : null
}

const newRoomId = (): string =>
  `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`

/** Join a room (creating one when no id is given). Idempotent per room. */
export async function enterRoom(roomId?: string): Promise<void> {
  const show = useToasts.getState().show
  const state = useCollab.getState()
  // No id = we mint the room → creator (seeds it instantly). An id (from a
  // shared link or our own URL after a reload) means the room may already
  // have a document that must win → joiner.
  const role = roomId === undefined ? 'creator' : 'joiner'
  const room = (roomId ?? newRoomId()).toLowerCase()
  if (state.roomId === room) return
  ++lifecycleToken // cancel any in-flight leave-restore
  stopMediaSync?.()
  stopMediaSync = null
  state.session?.leave()

  const useRelay = await relayAvailable()
  const transport: CollabTransport = useRelay
    ? new HttpRelayTransport(room)
    : new BroadcastChannelTransport(room)
  const preJoinProjectId = useStore.getState().project.id
  const session = startCollabSession({ room, transport, name: displayName(), role })
  session.subscribePeers((peers) => useCollab.setState({ peers }))
  transport.subscribeStatus?.((connected) => useCollab.setState({ connected }))
  useCollab.setState({
    session,
    roomId: room,
    mode: useRelay ? 'relay' : 'tabs',
    peers: [],
    preJoinProjectId,
    connected: true,
  })
  // Media bytes travel only through the relay; tabs-mode rooms share IndexedDB.
  // Gated on session READY: starting before the room doc is adopted would
  // upload the joiner's PRIVATE project media to a foreign room's store.
  // (The previous room's sync was already stopped at the top of this function.)
  if (useRelay) {
    session.onReady(() => {
      if (useCollab.getState().session === session) stopMediaSync = startMediaSync(room)
    })
  }

  window.location.hash = `room=${room}`
  try {
    await navigator.clipboard.writeText(window.location.href)
    show(useRelay ? 'Room link copied, anyone with it edits live' : 'Room link copied, works in tabs on THIS machine', 'success')
  } catch {
    show('Room created, share the URL to edit together', 'success')
  }
}

// Bumped on every enter/leave so a slow async restore can't apply after the
// user already joined another room (it would broadcast the solo project in).
let lifecycleToken = 0

export function leaveRoom(): void {
  const { session, preJoinProjectId } = useCollab.getState()
  const token = ++lifecycleToken
  stopMediaSync?.()
  stopMediaSync = null
  session?.leave()
  useCollab.setState({ session: null, roomId: null, mode: null, peers: [], preJoinProjectId: null })
  // Drop only the room part of the hash.
  if (roomFromHash()) window.history.replaceState(null, '', window.location.pathname)

  // Joining someone else's room replaced the open project (the room's copy is
  // autosaved under ITS OWN id, so nothing was lost). Leave brings the user's
  // own project back. Room creators keep editing theirs; nothing to restore.
  const current = useStore.getState().project.id
  if (preJoinProjectId && preJoinProjectId !== current) {
    void (async () => {
      const { loadProjectById, saveNow, saveProject } = await import('../state/persistence')
      // Flush the ROOM project first: the debounced autosave may still hold the
      // last second of room edits, and the restore below would cancel it. If that
      // write fails, restoring would drop those edits, so stay in the room instead.
      try {
        await saveNow()
      } catch {
        useToasts
          .getState()
          .show('Could not save the room project. Staying here so nothing is lost', 'danger')
        return
      }
      const mine = await loadProjectById(preJoinProjectId)
      if (!mine || token !== lifecycleToken) return // re-entered a room meanwhile
      useStore.getState().setProject(mine)
      useStore.getState().setUI({ selection: [] })
      await saveProject(mine) // move the lastProjectId pointer back too
      useToasts.getState().show(`Back to your project "${mine.name}"`, 'info')
    })()
  }
}

// ---------------------------------------------------------------------------
// Display name (persisted; presence shows it to everyone in the room).

const NAME_KEY = 'olpremiere:collab:name'

export function displayName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY)
    if (saved && saved.trim()) return saved.trim().slice(0, 24)
  } catch {
    // storage unavailable: fall through to a generated name
  }
  const generated = `Editor ${Math.floor(Math.random() * 90 + 10)}`
  try {
    localStorage.setItem(NAME_KEY, generated)
  } catch {
    // fine, we regenerate next time
  }
  return generated
}

/** The stored name for prefilling the rename input ('' when storage is blocked). */
export function storedDisplayName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Rename yourself; takes effect on the next presence heartbeat (≤2s). */
export function setDisplayName(name: string): void {
  const clean = name.trim().slice(0, 24)
  if (!clean) return
  try {
    localStorage.setItem(NAME_KEY, clean)
  } catch {
    // storage unavailable, so the session keeps the old name
  }
  useCollab.getState().session?.setName(clean)
}

/** Boot hook: auto-join when the URL carries a room (a shared link). */
export function joinRoomFromUrl(): void {
  const room = roomFromHash()
  if (room) void enterRoom(room)
}

/**
 * Undo/redo entry point for the whole app. Solo: the plain snapshot undo. In a
 * room: the REBASED step (only your own command's delta reverts; everyone
 * else's edits since survive). Returns the command label for the toast.
 */
export function performHistoryStep(dir: 'undo' | 'redo'): string | null {
  const inRoom = useCollab.getState().session !== null
  if (inRoom) return rebasedHistoryStep(dir)
  const store = useStore.getState()
  return dir === 'undo' ? store.undo() : store.redo()
}
