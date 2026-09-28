// The CutStudio client, driven end to end with a fake server and a fake spawn.
//
// What these hold down is the part he would feel: a server that is already up is
// used as it is and never touched, one that is not up gets started HIDDEN and
// waited on, and when there is no CutStudio at all the answer says so instead of
// hanging. Nothing here opens a port or starts a process.

import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  CUTSTUDIO_ORIGIN,
  START_TIMEOUT_MS,
  createCutstudio,
  cutstudioApiKey,
  cutstudioCandidates,
  serverCommand,
  type CutstudioDeps,
} from './cutstudio'

const DESKTOP = path.join('C:', 'Users', 'david', 'Desktop')
const DEV_EXE = path.join(DESKTOP, 'cutstudio', '.venv', 'Scripts', 'cutstudio.exe')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

class FakeChild extends EventEmitter {
  pid = 4242
  kill = vi.fn(() => true)
}

interface Rig {
  deps: CutstudioDeps
  spawned: { command: string; args: string[]; options: SpawnOptions }[]
  posts: FormData[]
  headers: (Record<string, string> | undefined)[]
  killed: number[]
  child: FakeChild
}

/**
 * A fake machine. `up` says whether CutStudio answers right now; `onSpawn` is
 * what starting it does (by default: it answers two polls later).
 */
function rig(opts: {
  up?: boolean
  installed?: string[]
  removebg?: () => Response
  onSpawn?: (r: Rig) => void
  env?: Record<string, string>
}): Rig {
  let up = opts.up ?? false
  let clock = 0
  let pollsUntilUp = -1
  const r: Rig = {
    spawned: [],
    posts: [],
    headers: [],
    killed: [],
    child: new FakeChild(),
    deps: {
      fetch: async (url, init) => {
        if (url === `${CUTSTUDIO_ORIGIN}/health`) {
          if (pollsUntilUp > 0 && --pollsUntilUp === 0) up = true
          if (!up) throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8787')
          return Response.json({ status: 'ok', version: '1.0.0' })
        }
        if (url === `${CUTSTUDIO_ORIGIN}/v1.0/removebg` && init?.method === 'POST') {
          r.posts.push(init.body as FormData)
          r.headers.push(init.headers as Record<string, string> | undefined)
          return opts.removebg ? opts.removebg() : new Response(PNG, { headers: { 'content-type': 'image/png' } })
        }
        return new Response('not found', { status: 404 })
      },
      spawn: (command, args, options) => {
        r.spawned.push({ command, args, options })
        if (opts.onSpawn) opts.onSpawn(r)
        else pollsUntilUp = 2
        return r.child
      },
      killTree: (pid) => r.killed.push(pid),
      exists: (file) => (opts.installed ?? [DEV_EXE]).includes(file),
      readText: () => Promise.reject(new Error('ENOENT')),
      env: opts.env ?? {},
      desktopDir: DESKTOP,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    },
  }
  return r
}

const picture = (): ArrayBuffer => new Uint8Array([1, 2, 3]).buffer

describe('a CutStudio that is already running', () => {
  it('is used as it is: one POST, full size PNG asked for, nothing started', async () => {
    const r = rig({ up: true })
    const cut = createCutstudio(r.deps)
    const out = await cut.removeBackground(picture(), 'image/png')
    expect(out.ok).toBe(true)
    if (out.ok) expect([...new Uint8Array(out.png)]).toEqual([...PNG])
    expect(r.spawned).toHaveLength(0)
    const form = r.posts[0]!
    expect(form.get('image_file')).toBeInstanceOf(Blob)
    expect(form.get('size')).toBe('full')
    expect(form.get('format')).toBe('png')
    expect(form.get('channels')).toBe('rgba')
  })

  it('is his, so quitting the app leaves it running', async () => {
    const r = rig({ up: true })
    const cut = createCutstudio(r.deps)
    await cut.removeBackground(picture(), 'image/png')
    cut.stop()
    expect(r.killed).toEqual([])
    expect(r.child.kill).not.toHaveBeenCalled()
  })

  it('says plainly when it has no model yet', async () => {
    const r = rig({
      up: true,
      removebg: () =>
        Response.json(
          { errors: [{ title: "model 'ISNet' is not downloaded yet.", code: 'model_not_downloaded' }] },
          { status: 503 },
        ),
    })
    const out = await createCutstudio(r.deps).removeBackground(picture(), 'image/png')
    expect(out).toMatchObject({ ok: false, reason: 'no-model' })
  })

  it('sends the key he set in CutStudio, so a locked server does not refuse the paste', async () => {
    const r = rig({ up: true, env: { CUTSTUDIO_API_KEY: 'his-key' } })
    await createCutstudio(r.deps).removeBackground(picture(), 'image/png')
    expect(r.headers[0]).toEqual({ 'X-Api-Key': 'his-key' })
  })
})

describe('a CutStudio that is not running', () => {
  it('is started hidden, waited on, then used', async () => {
    const r = rig({ up: false })
    const cut = createCutstudio(r.deps)
    const out = await cut.removeBackground(picture(), 'image/jpeg')
    expect(out.ok).toBe(true)
    expect(r.spawned).toHaveLength(1)
    expect(r.spawned[0]!.command).toBe(DEV_EXE)
    expect(r.spawned[0]!.args).toEqual(['serve', '--port', '8787'])
    // ⛔ Never a console window over his editor.
    expect(r.spawned[0]!.options.windowsHide).toBe(true)
    expect(r.posts).toHaveLength(1)
  })

  it('is started once, and the next paste reuses it', async () => {
    const r = rig({ up: false })
    const cut = createCutstudio(r.deps)
    await cut.removeBackground(picture(), 'image/png')
    await cut.removeBackground(picture(), 'image/png')
    expect(r.spawned).toHaveLength(1)
    expect(r.posts).toHaveLength(2)
  })

  it('is stopped, with everything under it, when the app quits', async () => {
    const r = rig({ up: false })
    const cut = createCutstudio(r.deps)
    await cut.removeBackground(picture(), 'image/png')
    cut.stop()
    expect(r.killed).toEqual([4242])
  })

  it('reports a server that quits before answering, and does not stop what is gone', async () => {
    const r = rig({ up: false, onSpawn: (rr) => queueMicrotask(() => rr.child.emit('exit', 1)) })
    const cut = createCutstudio(r.deps)
    const out = await cut.removeBackground(picture(), 'image/png')
    expect(out).toMatchObject({ ok: false, reason: 'no-start' })
    cut.stop()
    expect(r.killed).toEqual([])
  })

  it('gives up after about thirty seconds instead of hanging, and a retry waits on the same server', async () => {
    const r = rig({ up: false, onSpawn: () => undefined })
    const cut = createCutstudio(r.deps)
    const out = await cut.removeBackground(picture(), 'image/png')
    expect(out).toMatchObject({ ok: false, reason: 'slow-start' })
    expect(r.deps.now()).toBeGreaterThanOrEqual(START_TIMEOUT_MS)
    await cut.removeBackground(picture(), 'image/png')
    // Still loading is not dead: no second server on the same port.
    expect(r.spawned).toHaveLength(1)
  })
})

describe('no CutStudio on this computer', () => {
  it('says so, and starts nothing', async () => {
    const r = rig({ up: false, installed: [] })
    const out = await createCutstudio(r.deps).removeBackground(picture(), 'image/png')
    expect(out).toMatchObject({ ok: false, reason: 'not-found' })
    expect(r.spawned).toHaveLength(0)
    expect(r.posts).toHaveLength(0)
  })
})

describe('where cutstudio.exe is looked for', () => {
  it('tries the override, then an installed copy, then his working copy', () => {
    const env = {
      OLP_CUTSTUDIO: 'D:\\Tools\\CutStudio',
      LOCALAPPDATA: 'C:\\Users\\david\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    }
    expect(cutstudioCandidates(env, DESKTOP)).toEqual([
      path.join('D:\\Tools\\CutStudio', 'cutstudio.exe'),
      path.join('C:\\Users\\david\\AppData\\Local', 'Programs', 'CutStudio', 'cutstudio.exe'),
      path.join('C:\\Program Files', 'CutStudio', 'cutstudio.exe'),
      DEV_EXE,
    ])
  })

  it('takes an override that names the exe itself as it is', () => {
    expect(cutstudioCandidates({ OLP_CUTSTUDIO: 'D:\\cs\\CutStudio.exe' }, DESKTOP)[0]).toBe('D:\\cs\\CutStudio.exe')
  })

  it('starts the installed copy over the working copy once he has installed it', async () => {
    const installed = path.join('C:\\Users\\david\\AppData\\Local', 'Programs', 'CutStudio', 'cutstudio.exe')
    const r = rig({ up: false, installed: [installed, DEV_EXE], env: { LOCALAPPDATA: 'C:\\Users\\david\\AppData\\Local' } })
    await createCutstudio(r.deps).removeBackground(picture(), 'image/png')
    expect(r.spawned[0]!.command).toBe(installed)
  })
})

describe('cutstudioApiKey', () => {
  it('reads the key from CutStudio’s own settings file', async () => {
    const key = await cutstudioApiKey({
      env: { LOCALAPPDATA: 'C:\\L' },
      readText: (file) =>
        file === path.join('C:\\L', 'CutStudio', 'config.json')
          ? Promise.resolve(JSON.stringify({ api_key: 'abc' }))
          : Promise.reject(new Error('ENOENT')),
    })
    expect(key).toBe('abc')
  })

  it('is empty when none is set', async () => {
    expect(await cutstudioApiKey({ env: {}, readText: () => Promise.reject(new Error('ENOENT')) })).toBe('')
  })
})

describe('serverCommand', () => {
  const PYTHONW = path.join(DESKTOP, 'cutstudio', '.venv', 'Scripts', 'pythonw.exe')

  it('runs his working copy under the windowless Python, so no console window can open', () => {
    expect(serverCommand(DEV_EXE, (f) => f === PYTHONW)).toEqual({
      command: PYTHONW,
      args: ['-m', 'cutstudio', 'serve', '--port', '8787'],
    })
  })

  it('starts an installed CutStudio as it is', () => {
    const installed = path.join('C:', 'Program Files', 'CutStudio', 'cutstudio.exe')
    expect(serverCommand(installed, () => false)).toEqual({ command: installed, args: ['serve', '--port', '8787'] })
  })
})
