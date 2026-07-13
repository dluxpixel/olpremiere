// Cross-machine transport: polls the Vercel relay (/api/room) for Yjs updates
// + presence. Yjs updates are commutative, so a dumb ordered mailbox is a
// correct transport — merge math stays in the clients. Poll cadence ~1.5s is
// the "reliable everywhere, no accounts" trade-off vs realtime sockets.

import type { CollabTransport, PeerPresence } from './transport'

const POLL_MS = 1_500
/** Join-time compaction threshold: above this many log blobs, post a snapshot. */
const COMPACT_AT = 200

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Does this origin have a working relay? Demands a JSON response with the
 * relay's shape — a dev server's SPA fallback answers 200 with HTML for
 * /api/room, and a static deploy 404s; both mean "no relay, use tabs".
 */
export async function relayAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/api/room?room=probe-room', { method: 'GET' })
    if (!r.ok) return false
    if (!(r.headers.get('content-type') ?? '').includes('application/json')) return false
    const data = (await r.json()) as { updates?: unknown }
    return Array.isArray(data.updates)
  } catch {
    return false
  }
}

export class HttpRelayTransport implements CollabTransport {
  private room: string
  private cursor = ''
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private updateSubs = new Set<(u: Uint8Array) => void>()
  private presenceSubs = new Set<(p: PeerPresence[]) => void>()
  private syncProvider: (() => Uint8Array) | null = null
  private outbox: string[] = []
  private pendingPresence: PeerPresence | null = null
  private posting = false
  private firstPoll = true

  constructor(room: string) {
    this.room = room
    this.loop()
  }

  private async loop(): Promise<void> {
    if (this.closed) return
    try {
      const r = await fetch(`/api/room?room=${encodeURIComponent(this.room)}&since=${encodeURIComponent(this.cursor)}`)
      if (r.ok) {
        const data = (await r.json()) as {
          updates: { seq: string; b64: string }[]
          presence: PeerPresence[]
          cursor: string
          total: number
        }
        for (const u of data.updates) {
          try {
            const bytes = fromB64(u.b64)
            for (const cb of this.updateSubs) cb(bytes)
          } catch {
            // skip one malformed blob rather than stall the room
          }
        }
        this.cursor = data.cursor || this.cursor
        for (const cb of this.presenceSubs) cb(data.presence)

        // Long room log + we have full state → compact it to one snapshot.
        if (this.firstPoll && data.total > COMPACT_AT && this.syncProvider) {
          this.firstPoll = false
          void fetch(`/api/room?room=${encodeURIComponent(this.room)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ snapshot: b64(this.syncProvider()) }),
          }).catch(() => undefined)
        }
        this.firstPoll = false
      }
    } catch {
      // transient network failure — next poll retries
    }
    void this.flush()
    this.timer = setTimeout(() => void this.loop(), POLL_MS)
  }

  /** Push queued updates + presence in one POST (serialized). */
  private async flush(): Promise<void> {
    if (this.posting || this.closed) return
    if (this.outbox.length === 0 && !this.pendingPresence) return
    this.posting = true
    const updates = this.outbox.splice(0, this.outbox.length)
    const presence = this.pendingPresence
    this.pendingPresence = null
    try {
      await fetch(`/api/room?room=${encodeURIComponent(this.room)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates, ...(presence ? { presence } : {}) }),
      })
    } catch {
      this.outbox.unshift(...updates) // retry on the next tick
    } finally {
      this.posting = false
    }
  }

  send(update: Uint8Array): void {
    this.outbox.push(b64(update))
    void this.flush()
  }

  subscribe(onUpdate: (u: Uint8Array) => void): () => void {
    this.updateSubs.add(onUpdate)
    return () => this.updateSubs.delete(onUpdate)
  }

  requestSync(): void {
    // The relay IS the history: polling from cursor '' replays the whole log,
    // so a joiner needs no live peer to answer. Nothing to send.
  }

  onSyncRequest(provide: () => Uint8Array): () => void {
    this.syncProvider = provide
    return () => {
      if (this.syncProvider === provide) this.syncProvider = null
    }
  }

  sendPresence(state: PeerPresence): void {
    this.pendingPresence = state
  }

  subscribePresence(cb: (peers: PeerPresence[]) => void): () => void {
    this.presenceSubs.add(cb)
    return () => this.presenceSubs.delete(cb)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.updateSubs.clear()
    this.presenceSubs.clear()
  }
}
