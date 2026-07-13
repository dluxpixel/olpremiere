// Cross-machine transport: polls the Vercel relay (/api/room) for Yjs updates
// + presence. Yjs updates are commutative, so a dumb ordered mailbox is a
// correct transport — merge math stays in the clients. Poll cadence ~1.5s is
// the "reliable everywhere, no accounts" trade-off vs realtime sockets.

import type { CollabTransport, PeerPresence } from './transport'

/** Focus-aware poll cadence: snappy while the tab is active, gentle when hidden. */
const POLL_ACTIVE_MS = 1_000
const POLL_HIDDEN_MS = 4_000
/** Consecutive failures before the UI is told we're reconnecting. */
const FAILS_BEFORE_OFFLINE = 2
/** Join-time compaction threshold: above this many log blobs, post a snapshot. */
const COMPACT_AT = 200

const pollDelay = (): number =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_ACTIVE_MS

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
  private statusSubs = new Set<(connected: boolean) => void>()
  private syncProvider: (() => Uint8Array) | null = null
  private outbox: string[] = []
  private pendingPresence: PeerPresence | null = null
  private posting = false
  private firstPoll = true
  private failStreak = 0
  private connected = true

  private reportPoll(ok: boolean): void {
    this.failStreak = ok ? 0 : this.failStreak + 1
    const next = this.failStreak < FAILS_BEFORE_OFFLINE
    if (next !== this.connected) {
      this.connected = next
      for (const cb of this.statusSubs) cb(next)
    }
  }

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
      this.reportPoll(r.ok)
    } catch {
      // transient network failure — next poll retries
      this.reportPoll(false)
    }
    void this.flush()
    this.timer = setTimeout(() => void this.loop(), pollDelay())
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
      const r = await fetch(`/api/room?room=${encodeURIComponent(this.room)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates, ...(presence ? { presence } : {}) }),
      })
      // A failing POST means EDITS are not reaching the room — that must flip
      // the health badge just like a failing poll (silent drops are worse).
      if (!r.ok) {
        this.outbox.unshift(...updates)
        this.reportPoll(false)
      }
    } catch {
      this.outbox.unshift(...updates) // retry on the next tick
      this.reportPoll(false)
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

  subscribeStatus(cb: (connected: boolean) => void): () => void {
    this.statusSubs.add(cb)
    cb(this.connected)
    return () => this.statusSubs.delete(cb)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.updateSubs.clear()
    this.presenceSubs.clear()
  }
}
