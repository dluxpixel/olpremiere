// The cross machine collab transport: polls the relay (api/room.ts) for Yjs updates
// and posts its own. Nothing ran it before 2026-10-08 except by hand; collab.spec.ts
// drives two tabs over BroadcastChannel, never this. These drive it on fake timers
// against a fake relay with the real relay's answer shape, and prove it by what
// reaches the relay and what reaches the subscribers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpRelayTransport, relayAvailable } from './httpTransport'

const POLL_MS = 1_000

/** The relay: an ordered log of base64 blobs, the cursor is how many were read. */
interface Relay {
  log: string[]
  snapshots: string[]
  posts: number
  /** POSTs still to refuse (500) before the relay takes them again. */
  refusePosts: number
  gets: string[]
}
let relay: Relay

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeRelay(): void {
  relay = { log: [], snapshots: [], posts: 0, refusePosts: 0, gets: [] }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://relay.test')
    if ((init?.method ?? 'GET') === 'GET') {
      relay.gets.push(u.search)
      const since = Number(u.searchParams.get('since') || '0')
      const updates = relay.log.slice(since).map((b64, i) => ({ seq: String(since + i + 1), b64 }))
      return json({ updates, presence: [], cursor: String(relay.log.length), total: relay.log.length })
    }
    relay.posts++
    if (relay.refusePosts > 0) {
      relay.refusePosts--
      return json({ error: 'busy' }, 500)
    }
    const body = JSON.parse(String(init?.body)) as { updates?: string[]; snapshot?: string }
    if (body.snapshot) relay.snapshots.push(body.snapshot)
    for (const b of body.updates ?? []) relay.log.push(b)
    return json({ ok: true })
  })
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'))
const toB64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
/** Bytes that are not all one value, so a decode that drops or reorders any shows. */
const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff)
/** Let every pending promise and the given stretch of timers run. */
const run = (ms = 0): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined)

let open: HttpRelayTransport[] = []
const transport = (room = 'room-1'): HttpRelayTransport => {
  const t = new HttpRelayTransport(room)
  open.push(t)
  return t
}

beforeEach(() => {
  vi.useFakeTimers()
  fakeRelay()
})

afterEach(() => {
  for (const t of open) t.close()
  open = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('an edit goes out', () => {
  it('byte for byte', async () => {
    const t = transport()
    await run()
    const edit = bytes(500)
    t.send(edit)
    await run()
    expect(relay.log).toHaveLength(1)
    expect(fromB64(relay.log[0]!)).toEqual(edit)
  })

  // ⛔ FOUND 2026-10-08 BY THIS TEST. The encoder spread the whole update into
  // String.fromCharCode, and past about 125,000 arguments that throws "Maximum call
  // stack size exceeded". The first update of a room is the whole project (the
  // creator seeds the document with it), so a big enough project could not start a
  // cross machine session at all, and a big paste never reached the room.
  it('even when it is bigger than one call can take as arguments', async () => {
    const t = transport()
    await run()
    const project = bytes(400_000, 3)
    expect(() => t.send(project)).not.toThrow()
    await run()
    expect(relay.log).toHaveLength(1)
    expect(fromB64(relay.log[0]!)).toEqual(project)
  })

  it('in the order it was made, after the relay refused it twice, and the badge says so meanwhile', async () => {
    const t = transport()
    const status: boolean[] = []
    t.subscribeStatus((up) => status.push(up))
    await run()
    relay.refusePosts = 2
    t.send(bytes(10, 1))
    await run()
    t.send(bytes(10, 2))
    await run(POLL_MS)
    t.send(bytes(10, 3))
    await run(POLL_MS)
    // Two refused POSTs in a row: edits are not reaching the room, and he is told.
    expect(status).toContain(false)
    await run(POLL_MS)
    expect(relay.log.map((b) => fromB64(b)[0])).toEqual([bytes(10, 1)[0], bytes(10, 2)[0], bytes(10, 3)[0]])
    expect(status.at(-1)).toBe(true)
  })
})

describe('the room comes in', () => {
  it('every update, in order, to every subscriber, and the next poll asks only for what is new', async () => {
    relay.log.push(toB64(bytes(5, 1)), toB64(bytes(5, 2)))
    const t = transport()
    const a: number[] = []
    const b: number[] = []
    t.subscribe((u) => a.push(u[0]!))
    t.subscribe((u) => b.push(u[0]!))
    await run()
    expect(a).toEqual([bytes(5, 1)[0], bytes(5, 2)[0]])
    expect(b).toEqual(a)

    relay.log.push(toB64(bytes(5, 3)))
    await run(POLL_MS)
    expect(relay.gets.at(-1)).toContain('since=2')
    expect(a).toEqual([bytes(5, 1)[0], bytes(5, 2)[0], bytes(5, 3)[0]])
  })

  it('past one malformed blob, rather than stalling the room on it', async () => {
    relay.log.push(toB64(bytes(5, 1)), '%%% not base64 %%%', toB64(bytes(5, 2)))
    const t = transport()
    const got: number[] = []
    t.subscribe((u) => got.push(u[0]!))
    await run()
    expect(got).toEqual([bytes(5, 1)[0], bytes(5, 2)[0]])
  })
})

describe('joining a long room', () => {
  it('posts one snapshot of the whole state, once, however big the state is', async () => {
    for (let i = 0; i < 250; i++) relay.log.push(toB64(bytes(4, i)))
    const t = transport()
    const state = bytes(300_000, 9)
    t.onSyncRequest(() => state)
    await run()
    await run(POLL_MS * 3)
    expect(relay.snapshots).toHaveLength(1)
    expect(fromB64(relay.snapshots[0]!)).toEqual(state)
  })

  // Only at join. The relay drops every log entry older than the snapshot, so a
  // snapshot posted mid session could drop a peer's edit that it never contained.
  it('and never later, when a room it joined short grows long', async () => {
    const t = transport()
    t.onSyncRequest(() => bytes(100, 9))
    await run()
    for (let i = 0; i < 250; i++) relay.log.push(toB64(bytes(4, i)))
    await run(POLL_MS * 3)
    expect(relay.snapshots).toHaveLength(0)
  })
})

describe('closing', () => {
  it('stops polling', async () => {
    const t = transport()
    await run()
    const polls = relay.gets.length
    t.close()
    await run(POLL_MS * 5)
    expect(relay.gets.length).toBe(polls)
  })

  it('stops polling even when it closes while a poll is still on its way back', async () => {
    const t = transport()
    expect(relay.gets).toHaveLength(1)
    t.close()
    await run(POLL_MS * 5)
    expect(relay.gets).toHaveLength(1)
  })
})

describe('is there a relay here', () => {
  it('yes only for the relay\'s own JSON, not a dev server\'s HTML fallback or a 404', async () => {
    expect(await relayAvailable()).toBe(true)
    vi.stubGlobal('fetch', async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(await relayAvailable()).toBe(false)
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }))
    expect(await relayAvailable()).toBe(false)
  })
})
