// App-level collab control: one active session, room-in-URL-hash, transport
// selection. On an origin with the relay deployed (the collab Vercel project)
// rooms sync across machines; anywhere else they fall back to same-machine
// tabs via BroadcastChannel — same UI, honest badge text either way.

import { create } from 'zustand'
import { useToasts } from '../state/toasts'
import { HttpRelayTransport, relayAvailable } from './httpTransport'
import { startCollabSession, type CollabSession } from './session'
import { BroadcastChannelTransport, type PeerPresence } from './transport'

interface CollabState {
  session: CollabSession | null
  roomId: string | null
  /** 'relay' = cross-machine via the Vercel relay; 'tabs' = this machine only. */
  mode: 'relay' | 'tabs' | null
  peers: PeerPresence[]
}

export const useCollab = create<CollabState>(() => ({
  session: null,
  roomId: null,
  mode: null,
  peers: [],
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
  const room = (roomId ?? newRoomId()).toLowerCase()
  if (state.roomId === room) return
  state.session?.leave()

  const useRelay = await relayAvailable()
  const transport = useRelay ? new HttpRelayTransport(room) : new BroadcastChannelTransport(room)
  const session = startCollabSession({ room, transport, name: `Editor ${Math.floor(Math.random() * 90 + 10)}` })
  session.subscribePeers((peers) => useCollab.setState({ peers }))
  useCollab.setState({ session, roomId: room, mode: useRelay ? 'relay' : 'tabs', peers: [] })

  window.location.hash = `room=${room}`
  try {
    await navigator.clipboard.writeText(window.location.href)
    show(useRelay ? 'Room link copied — anyone with it edits live' : 'Room link copied — works in tabs on THIS machine', 'success')
  } catch {
    show('Room created — share the URL to edit together', 'success')
  }
}

export function leaveRoom(): void {
  const { session } = useCollab.getState()
  session?.leave()
  useCollab.setState({ session: null, roomId: null, mode: null, peers: [] })
  // Drop only the room part of the hash.
  if (roomFromHash()) window.history.replaceState(null, '', window.location.pathname)
}

/** Boot hook: auto-join when the URL carries a room (a shared link). */
export function joinRoomFromUrl(): void {
  const room = roomFromHash()
  if (room) void enterRoom(room)
}
