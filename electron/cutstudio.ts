// CutStudio, his own offline background remover, doing the "remove the
// background" half of a pasted picture.
//
// His words, 2026-09-28: *"maybe I can use my new app for the background
// removal. When I paste something, I can select, when pasting it, to remove the
// background automatically."*
//
// CutStudio (Desktop\cutstudio, Python) runs a local server that speaks
// remove.bg's API: `cutstudio.exe serve --port 8787`, then POST /v1.0/removebg.
// The request is made HERE, in main, because the editor page lives on
// app://olpremiere, and a POST from there to http://127.0.0.1:8787 is cross
// origin. CutStudio's server sends no CORS headers, so the page would be refused.
//
// No `electron` import, so the tests can drive all of it with a fake fetch and a
// fake spawn. main.ts hands in the real ones.

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CutoutFailure, CutoutResult } from './ipc-types'

export const CUTSTUDIO_PORT = 8787
export const CUTSTUDIO_ORIGIN = `http://127.0.0.1:${CUTSTUDIO_PORT}`
/** How long a server this app started gets to answer. The first start loads a model. */
export const START_TIMEOUT_MS = 30_000
export const POLL_MS = 400
/** A server that is up answers /health at once. Longer than this is nobody home. */
const HEALTH_TIMEOUT_MS = 2000
/**
 * One picture. Generous on purpose: the first cutout after a start loads the
 * model before it can begin, and a big picture on the CPU takes a while longer.
 */
const CUTOUT_TIMEOUT_MS = 180_000

/** The part of a child process this file uses, so a test can hand in a fake. */
export interface ServerChild {
  readonly pid?: number
  once(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(): boolean
}

export interface CutstudioDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  spawn: (command: string, args: string[], options: SpawnOptions) => ServerChild
  /** Ends a process AND everything it started. */
  killTree: (pid: number) => void
  exists: (file: string) => boolean
  readText: (file: string) => Promise<string>
  env: Record<string, string | undefined>
  /** His desktop, where the working copy of CutStudio lives. */
  desktopDir: string
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * Every place cutstudio.exe can be, in the order they are tried.
 *
 * 1. OLP_CUTSTUDIO, the override: the exe itself, or the folder it sits in.
 * 2. An installed copy. ⛔ CutStudio's installer folder was EMPTY on 2026-09-28,
 *    so there was no .iss to read the real install path from. These are where
 *    Inno Setup puts an app named CutStudio by default ({autopf}\CutStudio):
 *    %LOCALAPPDATA%\Programs for a per user install, Program Files for everyone.
 *    Check them against the .iss once it exists.
 * 3. His working copy on the desktop, run from its own virtual environment.
 *
 * An installed copy wins over the working copy, because once he installs it,
 * the installed one is the one he means.
 */
export function cutstudioCandidates(env: CutstudioDeps['env'], desktopDir: string): string[] {
  const exe = 'cutstudio.exe'
  const out: string[] = []
  const override = env.OLP_CUTSTUDIO?.trim()
  if (override) out.push(/\.exe$/i.test(override) ? override : path.join(override, exe))
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'CutStudio', exe))
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root) out.push(path.join(root, 'CutStudio', exe))
  }
  out.push(path.join(desktopDir, 'cutstudio', '.venv', 'Scripts', exe))
  return out
}

/**
 * How to start the server from a found cutstudio.exe.
 *
 * ⛔ A VIRTUAL ENVIRONMENT'S cutstudio.exe IS A LAUNCHER, NOT CUTSTUDIO. It is a
 * small console program that starts python.exe as a second process, and that
 * second process gets a console window of its own: windowsHide only reaches the
 * launcher. A black window over his editor, on a stream, is the exact thing he
 * asked to stop (2026-09-19). So when pythonw.exe, the windowless Python, sits
 * beside it, the server runs under that directly, one process, no console at all.
 * An installed CutStudio is started as it is.
 */
export function serverCommand(exe: string, exists: (file: string) => boolean): { command: string; args: string[] } {
  const serve = ['serve', '--port', String(CUTSTUDIO_PORT)]
  const pythonw = path.join(path.dirname(exe), 'pythonw.exe')
  if (exists(pythonw)) return { command: pythonw, args: ['-m', 'cutstudio', ...serve] }
  return { command: exe, args: serve }
}

/** The first cutstudio.exe that is really there, or null. */
export function findCutstudio(d: Pick<CutstudioDeps, 'env' | 'desktopDir' | 'exists'>): string | null {
  return cutstudioCandidates(d.env, d.desktopDir).find((p) => d.exists(p)) ?? null
}

/**
 * The key CutStudio would demand, when he has set one in its Settings ("Required
 * X-Api-Key"). A server he started from there checks it, and without it every
 * paste would be refused. Empty when none is set, and CutStudio then ignores the
 * header. Same places CutStudio itself reads: CUTSTUDIO_API_KEY first, then
 * config.json in its data folder.
 */
export async function cutstudioApiKey(d: Pick<CutstudioDeps, 'env' | 'readText'>): Promise<string> {
  if (d.env.CUTSTUDIO_API_KEY) return d.env.CUTSTUDIO_API_KEY
  const home = d.env.CUTSTUDIO_HOME || (d.env.LOCALAPPDATA ? path.join(d.env.LOCALAPPDATA, 'CutStudio') : '')
  if (!home) return ''
  try {
    const cfg = JSON.parse(await d.readText(path.join(home, 'config.json'))) as { api_key?: unknown }
    return typeof cfg.api_key === 'string' ? cfg.api_key : ''
  } catch {
    return ''
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const isPng = (bytes: ArrayBuffer): boolean => {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength))
  return head.length === 8 && PNG_SIGNATURE.every((b, i) => head[i] === b)
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const fail = (reason: CutoutFailure, detail: string): { ok: false; reason: CutoutFailure; detail: string } => ({
  ok: false,
  reason,
  detail,
})

/** A server this app started, and why it went away if it did. */
interface Started {
  child: ServerChild
  gone: string | null
}

export function createCutstudio(d: CutstudioDeps) {
  // ⛔ ONLY A SERVER THIS APP STARTED IS EVER STOPPED. One he runs himself, from
  // CutStudio's own Settings, is his and outlives this app.
  let ours: Started | null = null
  let starting: Promise<{ ok: true } | ReturnType<typeof fail>> | null = null

  async function probe(): Promise<'cutstudio' | 'other' | 'none'> {
    let res: Response
    try {
      res = await d.fetch(`${CUTSTUDIO_ORIGIN}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    } catch {
      return 'none'
    }
    if (!res.ok) return 'other'
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null
    return body?.status === 'ok' ? 'cutstudio' : 'other'
  }

  async function start(): Promise<{ ok: true } | ReturnType<typeof fail>> {
    // A server of ours that is still loading is waited on again, never joined by
    // a second one: a retry after "still starting" must not start two.
    if (!ours || ours.gone !== null) {
      const exe = findCutstudio(d)
      if (!exe) return fail('not-found', `no cutstudio.exe in ${cutstudioCandidates(d.env, d.desktopDir).join(', ')}`)
      let child: ServerChild
      try {
        // ⛔ windowsHide, like every child this app starts: CutStudio's server is
        // a console program, and without it a black window would open over his
        // editor for as long as the server runs.
        const { command, args } = serverCommand(exe, d.exists)
        child = d.spawn(command, args, { stdio: 'ignore', windowsHide: true })
      } catch (err) {
        return fail('no-start', messageOf(err))
      }
      const started: Started = { child, gone: null }
      // `on`, not `once`: a child process with no 'error' listener left takes
      // the whole main process down with it on a second error.
      child.on('error', (err) => {
        started.gone ??= err.message
      })
      child.once('exit', (code) => {
        started.gone ??= `CutStudio quit with code ${code}`
      })
      ours = started
    }
    const watching = ours
    const deadline = d.now() + START_TIMEOUT_MS
    for (;;) {
      // Asked first: if he started CutStudio himself meanwhile, ours loses the
      // port and quits, and his answers. Either way there is a server.
      if ((await probe()) === 'cutstudio') return { ok: true }
      const gone = watching.gone
      if (gone !== null) return fail('no-start', gone)
      if (d.now() >= deadline) return fail('slow-start', `no answer from ${CUTSTUDIO_ORIGIN} in ${START_TIMEOUT_MS / 1000} s`)
      await d.sleep(POLL_MS)
    }
  }

  /** A CutStudio server answering on its port, started here if nothing was. */
  async function ready(): Promise<{ ok: true } | ReturnType<typeof fail>> {
    const seen = await probe()
    if (seen === 'cutstudio') return { ok: true }
    if (seen === 'other') return fail('port-taken', `something that is not CutStudio answers on ${CUTSTUDIO_ORIGIN}`)
    starting ??= start().finally(() => {
      starting = null
    })
    return starting
  }

  /** Cut one picture out. Never throws: every failure comes back with its reason. */
  async function removeBackground(bytes: ArrayBuffer | ArrayBufferView, mime: string): Promise<CutoutResult> {
    const up = await ready()
    if (!up.ok) return up
    const form = new FormData()
    const ext = (mime.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
    const data = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes)
    form.append('image_file', new Blob([data], { type: mime }), `picture.${ext}`)
    // remove.bg's own field names (CutStudio core/apiparams.py). "full" keeps his
    // picture at its own size (CutStudio caps it at 25 megapixels), PNG keeps the
    // see-through background, and rgba keeps the colour with it.
    form.append('size', 'full')
    form.append('format', 'png')
    form.append('channels', 'rgba')
    const key = await cutstudioApiKey(d)
    try {
      const res = await d.fetch(`${CUTSTUDIO_ORIGIN}/v1.0/removebg`, {
        method: 'POST',
        body: form,
        headers: key ? { 'X-Api-Key': key } : undefined,
        signal: AbortSignal.timeout(CUTOUT_TIMEOUT_MS),
      })
      if (!res.ok) {
        // remove.bg's error shape: { errors: [{ title, code }] }.
        const body = (await res.json().catch(() => null)) as { errors?: { title?: string; code?: string }[] } | null
        const first = body?.errors?.[0]
        const reason = first?.code === 'model_not_downloaded' ? 'no-model' : 'failed'
        return fail(reason, first?.title ?? `CutStudio answered ${res.status}`)
      }
      const png = await res.arrayBuffer()
      if (!isPng(png)) return fail('failed', 'CutStudio sent back something that is not a PNG')
      return { ok: true, png }
    } catch (err) {
      return fail('failed', messageOf(err))
    }
  }

  /** On quit: stop the server this app started, and nothing else. */
  function stop(): void {
    const s = ours
    ours = null
    if (!s || s.gone !== null) return
    if (s.child.pid !== undefined) d.killTree(s.child.pid)
    else s.child.kill()
  }

  return { removeBackground, stop }
}

/**
 * The whole tree, not just the exe. His working copy's cutstudio.exe is a
 * launcher that runs python.exe underneath it, and killing only the launcher
 * could leave the server holding the port after the app has gone. before-quit
 * cannot wait, so this is synchronous, and hidden like every other child.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return
  }
  try {
    process.kill(pid)
  } catch {
    // Already gone.
  }
}

export function realCutstudioDeps(desktopDir: string): CutstudioDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    spawn: (command, args, options) => spawn(command, args, options),
    killTree,
    exists: (file) => existsSync(file),
    readText: (file) => readFile(file, 'utf8'),
    env: process.env,
    desktopDir,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
