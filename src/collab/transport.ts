// Collab transports: how Yjs update bytes and presence heartbeats move between
// peers. The session is transport-agnostic — same bridge, swappable wire:
//   - BroadcastChannelTransport: tabs on ONE machine (and the e2e harness).
//   - HttpRelayTransport (httpTransport.ts): cross-machine via the Vercel relay.

export interface PeerPresence {
  clientId: string
  name: string
  color: string
  playheadS: number
  /** ms epoch of the last heartbeat (stale peers are dropped by the reader). */
  at: number
}

export interface CollabTransport {
  /** Broadcast a Yjs update (binary) to every other peer in the room. */
  send(update: Uint8Array): void
  /** Receive updates from other peers (and, on join, the room's history). */
  subscribe(onUpdate: (update: Uint8Array) => void): () => void
  /**
   * Ask the room for its current state; existing peers answer through the
   * normal update channel. Joiners call this once.
   */
  requestSync(): void
  /**
   * Register the provider of full-state answers (called with a fresh encoded
   * snapshot whenever some peer requests sync).
   */
  onSyncRequest(provide: () => Uint8Array): () => void
  sendPresence(state: PeerPresence): void
  subscribePresence(cb: (peers: PeerPresence[]) => void): () => void
  close(): void
}

/** How long a peer may go silent before it disappears from presence. */
export const PRESENCE_TTL_MS = 8_000

type BcMsg =
  | { kind: 'update'; bytes: number[] }
  | { kind: 'sync-request' }
  | { kind: 'presence'; peer: PeerPresence }

/**
 * Same-origin, same-machine transport over a BroadcastChannel. Presence is
 * kept per-sender and pruned by TTL on every read.
 */
export class BroadcastChannelTransport implements CollabTransport {
  private ch: BroadcastChannel
  private updateSubs = new Set<(u: Uint8Array) => void>()
  private presenceSubs = new Set<(p: PeerPresence[]) => void>()
  private syncProvider: (() => Uint8Array) | null = null
  private peers = new Map<string, PeerPresence>()

  constructor(room: string) {
    this.ch = new BroadcastChannel(`reel-collab:${room}`)
    this.ch.onmessage = (e: MessageEvent<BcMsg>) => {
      const msg = e.data
      if (msg.kind === 'update') {
        const bytes = new Uint8Array(msg.bytes)
        for (const cb of this.updateSubs) cb(bytes)
      } else if (msg.kind === 'sync-request') {
        // Any peer that has state answers; extra answers merge harmlessly (CRDT).
        if (this.syncProvider) this.post({ kind: 'update', bytes: [...this.syncProvider()] })
      } else if (msg.kind === 'presence') {
        this.peers.set(msg.peer.clientId, msg.peer)
        this.emitPresence()
      }
    }
  }

  private post(msg: BcMsg): void {
    this.ch.postMessage(msg)
  }

  private emitPresence(): void {
    const now = Date.now()
    for (const [id, p] of this.peers) if (now - p.at > PRESENCE_TTL_MS) this.peers.delete(id)
    const list = [...this.peers.values()]
    for (const cb of this.presenceSubs) cb(list)
  }

  send(update: Uint8Array): void {
    this.post({ kind: 'update', bytes: [...update] })
  }

  subscribe(onUpdate: (u: Uint8Array) => void): () => void {
    this.updateSubs.add(onUpdate)
    return () => this.updateSubs.delete(onUpdate)
  }

  requestSync(): void {
    this.post({ kind: 'sync-request' })
  }

  onSyncRequest(provide: () => Uint8Array): () => void {
    this.syncProvider = provide
    return () => {
      if (this.syncProvider === provide) this.syncProvider = null
    }
  }

  sendPresence(state: PeerPresence): void {
    this.post({ kind: 'presence', peer: state })
  }

  subscribePresence(cb: (peers: PeerPresence[]) => void): () => void {
    this.presenceSubs.add(cb)
    return () => this.presenceSubs.delete(cb)
  }

  close(): void {
    this.ch.close()
    this.updateSubs.clear()
    this.presenceSubs.clear()
  }
}
