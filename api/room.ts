// Collab relay: a Vercel serverless function that moves Yjs update blobs and
// presence heartbeats between peers in a room. Deliberately dumb — CRDT merge
// math lives entirely in the clients; this is just an append-only mailbox on
// Vercel Blob storage. Requires a connected Blob store (BLOB_READ_WRITE_TOKEN);
// without one every request 500s and the app falls back to same-machine tabs.
//
//   GET  /api/room?room=X&since=<cursor>   → { updates: [{ seq, b64 }], presence: [...], cursor }
//   POST /api/room?room=X                  → body { updates?: b64[], presence?: PeerPresence, snapshot?: b64 }
//        `snapshot` replaces the room's log with one merged blob (compaction).

import { del, list, put } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const ROOM_RE = /^[a-z0-9-]{4,40}$/i
/** Presence entries older than this are dead peers. Generous: hidden tabs get
 * their timers browser-throttled, and flapping is worse than lingering. */
const PRESENCE_TTL_MS = 25_000
/** Hard cap per response so a huge room log can't blow the function. */
const MAX_UPDATES_PER_GET = 500

const prefix = (room: string): string => `reel-rooms/${room}/log/`
const presencePrefix = (room: string): string => `reel-rooms/${room}/presence/`
const mediaPrefix = (room: string): string => `reel-rooms/${room}/media/`

/** Monotonic-enough cursor: ms epoch + random suffix orders lexicographically. */
const newSeq = (): string => `${Date.now().toString().padStart(14, '0')}-${Math.random().toString(36).slice(2, 8)}`

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const room = String(req.query.room ?? '')
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ error: 'bad room id' })
    return
  }

  try {
    if (req.method === 'GET') {
      // Lightweight media-manifest poll (no log/presence work).
      if (req.query.mediaOnly !== undefined) {
        const media = await list({ prefix: mediaPrefix(room), limit: 500 })
        res.setHeader('cache-control', 'no-store')
        res.status(200).json({
          media: media.blobs.map((b) => ({
            key: decodeURIComponent(b.pathname.slice(mediaPrefix(room).length)),
            url: b.url,
            size: b.size,
          })),
        })
        return
      }

      const since = String(req.query.since ?? '')
      const [log, presence] = await Promise.all([
        list({ prefix: prefix(room), limit: 1000 }),
        list({ prefix: presencePrefix(room), limit: 100 }),
      ])

      const fresh = log.blobs
        .map((b) => ({ seq: b.pathname.slice(prefix(room).length).replace(/\.bin$/, ''), url: b.url }))
        .filter((b) => b.seq > since)
        .sort((a, b) => (a.seq < b.seq ? -1 : 1))
        .slice(0, MAX_UPDATES_PER_GET)

      const updates = await Promise.all(
        fresh.map(async (b) => ({
          seq: b.seq,
          b64: Buffer.from(await (await fetch(b.url)).arrayBuffer()).toString('base64'),
        })),
      )

      const now = Date.now()
      const peers = (
        await Promise.all(
          presence.blobs
            .filter((b) => now - new Date(b.uploadedAt).getTime() < PRESENCE_TTL_MS)
            .map(async (b) => {
              try {
                return (await (await fetch(b.url)).json()) as unknown
              } catch {
                return null
              }
            }),
        )
      ).filter(Boolean)

      const cursor = updates.length > 0 ? updates[updates.length - 1].seq : since
      res.setHeader('cache-control', 'no-store')
      res.status(200).json({ updates, presence: peers, cursor, total: log.blobs.length })
      return
    }

    if (req.method === 'POST') {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
        updates?: string[]
        presence?: Record<string, unknown> & { clientId?: string }
        snapshot?: string
      }

      if (body.snapshot) {
        // Compaction: write the merged state as one blob, then drop older ones.
        const seq = newSeq()
        await put(`${prefix(room)}${seq}.bin`, Buffer.from(body.snapshot, 'base64'), {
          access: 'public',
          addRandomSuffix: false,
        })
        const log = await list({ prefix: prefix(room), limit: 1000 })
        const stale = log.blobs.filter((b) => b.pathname.slice(prefix(room).length).replace(/\.bin$/, '') < seq)
        if (stale.length > 0) await del(stale.map((b) => b.url))
        res.status(200).json({ ok: true, seq })
        return
      }

      const seqs: string[] = []
      for (const b64 of body.updates ?? []) {
        const seq = newSeq()
        seqs.push(seq)
        await put(`${prefix(room)}${seq}.bin`, Buffer.from(b64, 'base64'), {
          access: 'public',
          addRandomSuffix: false,
        })
      }
      if (body.presence && typeof body.presence.clientId === 'string' && /^[a-z0-9-]{1,40}$/i.test(body.presence.clientId)) {
        await put(`${presencePrefix(room)}${body.presence.clientId}.json`, JSON.stringify(body.presence), {
          access: 'public',
          addRandomSuffix: false,
          allowOverwrite: true,
        })
      }
      res.status(200).json({ ok: true, seqs })
      return
    }

    res.status(405).json({ error: 'method not allowed' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'relay error' })
  }
}
