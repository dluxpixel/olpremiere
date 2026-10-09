// The phone's offline copy (sw.template.js). Nothing ran it before 2026-10-06: it
// is built into the web bundle only, and main.tsx registers it only over https,
// so neither the dev server the end to end suite drives nor any unit test ever
// loaded it. A wrong rule in it leaves his phone on an old version, or with no
// editor on the bus, and nothing on this machine would say so.
//
// These load the real template, filled in the way vite.config.ts fills it, into
// a fake service worker scope with a fake Cache Storage and a network that can
// be cut, and prove the rules by what the phone would be served.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TEMPLATE = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
const ORIGIN = 'https://olp.example'

interface Res {
  ok: boolean
  type: string
  body: string
  clone: () => Res
}
const res = (body: string, ok = true): Res => ({ ok, type: 'basic', body, clone: () => res(body, ok) })

type Handler = (event: Record<string, unknown>) => void

/** A browser with one origin, its Cache Storage, and a network that serves `files`. */
function phone() {
  const stores = new Map<string, Map<string, Res>>()
  const served = new Map<string, string>()
  let online = true
  const fetched: string[] = []
  const pathOf = (r: string | { url: string }): string => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname

  async function net(req: string | { url: string }): Promise<Res> {
    const path = pathOf(req)
    fetched.push(path)
    const body = served.get(path)
    if (!online || body === undefined) throw new TypeError('Failed to fetch')
    return res(body)
  }

  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const m = stores.get(name)!
      return {
        add: async (req: { url: string }) => {
          m.set(pathOf(req), await net(req))
        },
        put: async (req: string | { url: string }, r: Res) => void m.set(pathOf(req), r),
        match: async (req: string | { url: string }) => m.get(pathOf(req)),
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  }

  class FakeRequest {
    url: string
    method: string
    mode: string
    constructor(url: string, init?: { method?: string; mode?: string }) {
      this.url = new URL(url, ORIGIN).href
      this.method = init?.method ?? 'GET'
      this.mode = init?.mode ?? 'cors'
    }
  }

  return {
    stores,
    fetched,
    /** The deployed build: these paths answer, with these bodies. */
    serve(files: Record<string, string>) {
      served.clear()
      for (const [p, b] of Object.entries(files)) served.set(p, b)
    },
    offline() {
      online = false
    },
    /** One build's worker, filled in the way vite.config.ts fills the template. */
    worker(version: string, files: string[]) {
      const handlers: Record<string, Handler> = {}
      const scope = {
        location: { origin: ORIGIN },
        addEventListener: (type: string, fn: Handler) => void (handlers[type] = fn),
        skipWaiting: async () => undefined,
        clients: { claim: async () => undefined },
      }
      const code = TEMPLATE.replace('__OLP_VERSION__', JSON.stringify(version)).replace('__OLP_FILES__', JSON.stringify(files))
      new Function('self', 'caches', 'fetch', 'Request', 'Response', code)(scope, caches, net, FakeRequest, { error: () => res('', false) })
      const lifecycle = (type: 'install' | 'activate'): Promise<unknown> => {
        let done: Promise<unknown> = Promise.resolve()
        handlers[type]!({ waitUntil: (p: Promise<unknown>) => void (done = p) })
        return done
      }
      return {
        install: () => lifecycle('install'),
        activate: () => lifecycle('activate'),
        /** What the page is given for a request, or null when the worker lets it go to the network itself. */
        async get(path: string, init?: { method?: string; mode?: string; origin?: string }): Promise<string | null> {
          let answer: Promise<Res> | null = null
          handlers.fetch!({
            request: new FakeRequest(new URL(path, init?.origin ?? ORIGIN).href, init),
            respondWith: (p: Promise<Res>) => void (answer = p),
          })
          if (!answer) return null
          const r = await (answer as Promise<Res>)
          return r.ok ? r.body : 'NETWORK ERROR'
        },
      }
    },
  }
}

const BUILD_1 = { '/': 'page v1', '/index.html': 'page v1', '/assets/app-1.js': 'app v1', '/fonts/x.woff2': 'font' }

describe('the offline copy', () => {
  it('keeps every file the build lists, so the editor opens with no signal', async () => {
    const p = phone()
    p.serve(BUILD_1)
    const w = p.worker('v1', Object.keys(BUILD_1))
    await w.install()
    await w.activate()
    p.offline()
    expect(await w.get('/', { mode: 'navigate' })).toBe('page v1')
    expect(await w.get('/assets/app-1.js')).toBe('app v1')
    expect(await w.get('/fonts/x.woff2')).toBe('font')
  })

  it('asks the network for the page first, so a new version arrives whenever there is signal', async () => {
    const p = phone()
    p.serve(BUILD_1)
    const w = p.worker('v1', Object.keys(BUILD_1))
    await w.install()
    await w.activate()
    p.serve({ ...BUILD_1, '/': 'page v2' })
    expect(await w.get('/', { mode: 'navigate' })).toBe('page v2')
    // And the copy it falls back to is now that newer page.
    p.offline()
    expect(await w.get('/', { mode: 'navigate' })).toBe('page v2')
  })

  it('answers a content named file from the copy without asking the network', async () => {
    const p = phone()
    p.serve(BUILD_1)
    const w = p.worker('v1', Object.keys(BUILD_1))
    await w.install()
    await w.activate()
    p.fetched.length = 0
    expect(await w.get('/assets/app-1.js?v=3')).toBe('app v1')
    expect(p.fetched).toEqual([])
  })

  it('a file the install missed is fetched on first use and kept from then on', async () => {
    const p = phone()
    p.serve({ '/': 'page v1', '/assets/app-1.js': 'app v1' })
    const w = p.worker('v1', ['/', '/assets/app-1.js', '/assets/late-1.js'])
    await w.install()
    await w.activate()
    p.serve({ '/': 'page v1', '/assets/app-1.js': 'app v1', '/assets/late-1.js': 'late v1' })
    expect(await w.get('/assets/late-1.js')).toBe('late v1')
    p.offline()
    expect(await w.get('/assets/late-1.js')).toBe('late v1')
  })

  it('a new build replaces the old copy once it is in, and leaves other caches alone', async () => {
    const p = phone()
    p.serve(BUILD_1)
    const v1 = p.worker('v1', Object.keys(BUILD_1))
    await v1.install()
    await v1.activate()
    // transformers.js keeps the speech model in a cache of its own.
    p.stores.set('transformers-cache', new Map())

    const build2 = { '/': 'page v2', '/index.html': 'page v2', '/assets/app-2.js': 'app v2', '/fonts/x.woff2': 'font' }
    p.serve(build2)
    const v2 = p.worker('v2', Object.keys(build2))
    await v2.install()
    await v2.activate()
    expect([...p.stores.keys()].sort()).toEqual(['olp-app-v2', 'transformers-cache'])
    p.offline()
    expect(await v2.get('/', { mode: 'navigate' })).toBe('page v2')
    expect(await v2.get('/assets/app-2.js')).toBe('app v2')
  })

  it('never touches another site, and never a request that changes something', async () => {
    const p = phone()
    p.serve(BUILD_1)
    const w = p.worker('v1', Object.keys(BUILD_1))
    await w.install()
    await w.activate()
    expect(await w.get('/model.onnx', { origin: 'https://huggingface.co' })).toBeNull()
    expect(await w.get('/assets/app-1.js', { method: 'POST' })).toBeNull()
  })
})
