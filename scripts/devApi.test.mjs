// The dev server must never compile api/*.ts for the browser (vite.devApi.ts). It sits in
// scripts/ for the same reason quietBox.test.mjs does: Playwright takes every *.test.ts
// under e2e/ for one of its own specs, and this one is about the dev server's own config.
//
// ⛔ 2026-10-11, the release gate: the app probes `/api/room` when a room starts, Vite took
// that extensionless URL for a module, compiled api/room.ts, and found `@vercel/blob` in it.
// On a cold dependency cache that re-optimized and RELOADED every open page in the middle of
// collab.spec.ts. These tests run a real Vite dev server, because what has to hold is what
// Vite does with the request, not what our middleware says it does.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, normalizePath } from 'vite'
import { devApiNotFound } from '../vite.devApi.ts'

const roots = []
const closers = []

afterAll(async () => {
  for (const close of closers) await close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A throwaway project with a serverless function that imports a server only package. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'olp-dev-api-'))
  roots.push(root)
  mkdirSync(join(root, 'api'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules', 'relay-only-dep'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'relay-only-dep', 'package.json'),
    JSON.stringify({ name: 'relay-only-dep', type: 'module', main: 'index.js' }),
  )
  writeFileSync(join(root, 'node_modules', 'relay-only-dep', 'index.js'), 'export const put = () => 1\n')
  writeFileSync(join(root, 'api', 'room.ts'), "import { put } from 'relay-only-dep'\nexport default () => put()\n")
  writeFileSync(join(root, 'api', 'media.ts'), "import { put } from 'relay-only-dep'\nexport default () => put()\n")
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1\n')
  return root
}

/** A real Vite dev server (with or without the guard) behind a real HTTP port. */
async function serve(root, plugins) {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    cacheDir: join(root, '.cache'),
    plugins,
    // No scan and no watcher: the question is the response to one request, and a background
    // optimizer run would only make this slower.
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false, watch: null },
  })
  const http = createHttpServer(vite.middlewares)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await vite.close()
  })
  const base = `http://127.0.0.1:${http.address().port}`
  const compiled = (file) => (vite.environments.client.moduleGraph.getModulesByFile(normalizePath(file))?.size ?? 0) > 0
  return { base, compiled }
}

describe('dev server and api/*', () => {
  it('THE PREMISE: with no guard, Vite compiles api/room.ts and sends it as a module', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { base, compiled } = await serve(root, [])
    const res = await fetch(`${base}/api/room?room=probe-room`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(compiled(join(root, 'api', 'room.ts'))).toBe(true)
  })

  it('THE FIX: /api/room is a 404 and api/room.ts is never compiled', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { base, compiled } = await serve(root, [devApiNotFound()])
    const res = await fetch(`${base}/api/room?room=probe-room`)
    expect(res.status).toBe(404)
    // A 404 is the probe's own answer for "no relay, use tabs", not a JSON body.
    expect(res.headers.get('content-type') ?? '').not.toContain('json')
    expect(compiled(join(root, 'api', 'room.ts'))).toBe(false)
  })

  it('every api path and verb is a 404, and none of them is compiled', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { base, compiled } = await serve(root, [devApiNotFound()])
    for (const [method, path] of [
      ['GET', '/api/room?room=x&since=3'],
      ['POST', '/api/room?room=x'],
      ['GET', '/api/media'],
      ['POST', '/api/media'],
    ]) {
      const res = await fetch(`${base}${path}`, { method })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(compiled(join(root, 'api', 'room.ts'))).toBe(false)
    expect(compiled(join(root, 'api', 'media.ts'))).toBe(false)
  })

  it('the app\'s own modules are still served', { timeout: 30_000 }, async () => {
    const root = makeRoot()
    const { base } = await serve(root, [devApiNotFound()])
    const res = await fetch(`${base}/src/app.ts`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('export const app')
  })
})
