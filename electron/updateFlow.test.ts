// The updater's rules RUN, with a fake updater and fake clocks, instead of read off
// main.ts's text. See ./updateFlow for why they moved out of main.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHttpError, newError } from 'builder-util-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from './ipc-types'
import { IDLE_APPLY_S, IDLE_POLL_MS } from './updateApply'
import { isKnownUpdateMessage, PUBLISHING_QUIET_MS, updateFailureMessage } from './updateErrors'
import { fileQuietStore, POLL_MS, startUpdateFlow, type QuietMark, type QuietStore, type UpdateFlow, type UpdaterLike } from './updateFlow'

const MIN = 60_000
const T0 = new Date('2026-10-06T12:00:00.000Z').getTime()

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  logger: UpdaterLike['logger'] = null
  checks = 0
  checkForUpdates = vi.fn<UpdaterLike['checkForUpdates']>(async () => {
    this.checks++
    return { downloadPromise: null }
  })
}

/** latest.yml not up yet on a release that is already listed: a release mid upload. */
const stillPublishing = (): Error =>
  newError('Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v9.9.9/latest.yml): HttpError: 404', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')

/** The releases feed itself is gone: a private, renamed or deleted repo. */
const deadFeed = (): Error =>
  createHttpError(
    { statusCode: 404, statusMessage: 'Not Found', headers: {} } as never,
    'method: GET url: https://github.com/o/r/releases.atom\n\nPlease double check that your authentication token is correct.',
  )

/** A quiet run kept in memory. A bare number is a run begun then and last heard then. */
function memoryQuiet(start: number | QuietMark | null = null): QuietStore & { value: QuietMark | null } {
  const q = {
    value: typeof start === 'number' ? { since: start, last: start } : start,
    read: () => q.value,
    write: (v: QuietMark | null) => {
      q.value = v
    },
  }
  return q
}

interface Rig {
  updater: FakeUpdater
  flow: UpdateFlow
  statuses: UpdateStatus[]
  sent: [string, string | undefined][]
  logs: string[]
  quiet: ReturnType<typeof memoryQuiet>
  idle: { s: number }
  busy: { on: boolean }
  status: () => UpdateStatus
}

function rig(quietStart: number | QuietMark | null = null): Rig {
  const updater = new FakeUpdater()
  let status: UpdateStatus = { kind: 'unsupported' }
  const statuses: UpdateStatus[] = []
  const sent: [string, string | undefined][] = []
  const logs: string[] = []
  const quiet = memoryQuiet(quietStart)
  const idle = { s: 0 }
  const busy = { on: false }
  const flow = startUpdateFlow({
    updater,
    getStatus: () => status,
    setStatus: (s) => {
      status = s
      statuses.push(s)
    },
    send: (channel, arg) => sent.push([channel, arg]),
    idleSeconds: () => idle.s,
    busy: () => busy.on,
    log: (e) => logs.push(e),
    quiet,
    now: () => Date.now(),
  })
  return { updater, flow, statuses, sent, logs, quiet, idle, busy, status: () => status }
}

let live: Rig | null = null
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  live?.flow.stop()
  live = null
  vi.useRealTimers()
})
const start = (quietStart: number | QuietMark | null = null): Rig => (live = rig(quietStart))

describe('checking', () => {
  it('hands the updater the main log, so its own account is kept', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const updater = new FakeUpdater()
    const flow = startUpdateFlow({
      updater,
      getStatus: () => ({ kind: 'none' }),
      setStatus: () => undefined,
      send: () => undefined,
      idleSeconds: () => IDLE_APPLY_S,
      busy: () => false,
      log: () => undefined,
      quiet: memoryQuiet(),
      logger,
    })
    try {
      expect(updater.logger).toBe(logger)
      updater.emit('update-downloaded', { version: '9.9.9' })
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('9.9.9 downloaded while he is away'))
    } finally {
      flow.stop()
    }
  })

  it('turns on download and install on quit, and checks once at start', () => {
    const r = start()
    expect(r.updater.autoDownload).toBe(true)
    expect(r.updater.autoInstallOnAppQuit).toBe(true)
    expect(r.updater.checks).toBe(1)
    expect(r.status()).toEqual({ kind: 'checking' })
  })

  it('⛔ never asks for the Windows notification: checkForUpdates, not ...AndNotify', () => {
    const r = start()
    const notify = vi.fn()
    ;(r.updater as unknown as { checkForUpdatesAndNotify: unknown }).checkForUpdatesAndNotify = notify
    r.flow.check()
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(notify).not.toHaveBeenCalled()
    expect(r.updater.checkForUpdates).toHaveBeenCalled()
  })

  it('does not leave a rejected check, or a failed download, unhandled', async () => {
    vi.useRealTimers() // Node reports an unhandled rejection on a real turn of the loop
    const r = start()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      r.updater.checkForUpdates.mockImplementationOnce(async () => ({ downloadPromise: Promise.reject(new Error('download failed')) }))
      r.updater.checkForUpdates.mockImplementationOnce(() => Promise.reject(new Error('check failed')))
      r.flow.check()
      r.flow.check()
      await new Promise((res) => setTimeout(res, 20))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('sends the page only a fixed sentence, never the updater\'s own text', () => {
    const r = start()
    r.updater.emit(
      'error',
      new Error('Cannot download "https://github.com/o/r/releases/download/v1/x.exe", status 500: Server Error\nheaders: {"server":"github.com"}'),
    )
    const [[channel, message]] = r.sent
    expect(channel).toBe('update:error')
    expect(isKnownUpdateMessage(message ?? '')).toBe(true)
    expect(r.logs[0]).toContain('headers')
  })

  it('looks again every fifteen minutes', () => {
    const r = start()
    r.updater.emit('update-not-available')
    vi.advanceTimersByTime(POLL_MS)
    expect(r.updater.checks).toBe(2)
    r.updater.emit('update-not-available')
    vi.advanceTimersByTime(POLL_MS)
    expect(r.updater.checks).toBe(3)
  })

  it('⛔ never checks over a live download', () => {
    const r = start()
    r.updater.emit('update-available', { version: '9.9.9' })
    r.updater.emit('download-progress', { percent: 41.6, transferred: 100e6, total: 240e6 })
    vi.advanceTimersByTime(POLL_MS * 2)
    expect(r.updater.checks).toBe(1)
    expect(r.status()).toEqual({ kind: 'downloading', version: '9.9.9', percent: 42, transferred: 100e6, total: 240e6 })
  })

  it('stops looking once a version is staged', () => {
    const r = start()
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    vi.advanceTimersByTime(POLL_MS * 4)
    expect(r.updater.checks).toBe(1)
  })
})

describe('a release still being published', () => {
  it('says nothing and looks again at 2, 4 and 8 minutes', async () => {
    const r = start()
    const at: number[] = []
    r.updater.checkForUpdates.mockImplementation(async () => {
      at.push(Date.now() - T0)
      queueMicrotask(() => r.updater.emit('error', stillPublishing()))
      return null
    })
    r.updater.emit('error', stillPublishing())
    for (let i = 0; i < 16; i++) await vi.advanceTimersByTimeAsync(MIN)
    expect(r.sent.filter(([c]) => c === 'update:error')).toEqual([])
    expect(r.status()).toEqual({ kind: 'pending' })
    // The first recheck at 2, the next 4 after it, the next 8 after that.
    expect(at.slice(0, 3)).toEqual([2 * MIN, 6 * MIN, 14 * MIN])
    expect(r.logs.length).toBeGreaterThanOrEqual(3)
    expect(r.logs[0]).toContain('quiet, a release still publishing, checking again in 120s')
  })

  it('a recheck stands down when something else already moved the status on', () => {
    const r = start()
    r.updater.emit('error', stillPublishing())
    r.updater.emit('update-available', { version: '9.9.9' })
    vi.advanceTimersByTime(3 * MIN)
    expect(r.updater.checks).toBe(1)
  })

  it('⛔ is said out loud once the quiet run is an hour old', () => {
    const r = start()
    r.updater.emit('error', stillPublishing())
    expect(r.quiet.value?.since).toBe(T0)
    vi.setSystemTime(T0 + PUBLISHING_QUIET_MS)
    r.updater.emit('error', stillPublishing())
    expect(r.sent).toContainEqual(['update:error', updateFailureMessage('publishing')])
    expect(r.status()).toEqual({ kind: 'error', message: updateFailureMessage('publishing') })
  })

  it('⛔ a quiet run that began 61 minutes ago, in an earlier launch, is said on the FIRST answer', () => {
    const r = start(T0 - 61 * MIN)
    r.updater.emit('error', stillPublishing())
    expect(r.sent).toEqual([['update:error', updateFailureMessage('publishing')]])
  })

  // ⛔ An app closed inside the two minute recheck left its run on disk, and days later
  // the first answer of a launch, a real release minutes into its upload, was said out loud.
  it('⛔ a quiet run left on disk days ago is over: the first answer of a launch starts a new one', () => {
    const r = start(T0 - 3 * 24 * 60 * MIN)
    r.updater.emit('error', stillPublishing())
    expect(r.sent).toEqual([])
    expect(r.status()).toEqual({ kind: 'pending' })
    expect(r.quiet.value).toEqual({ since: T0, last: T0 })
  })

  it('every quiet answer is noted as the last one heard, so a run that is still heard carries on', () => {
    const r = start()
    r.updater.emit('error', stillPublishing())
    vi.setSystemTime(T0 + 2 * MIN)
    r.updater.emit('error', stillPublishing())
    expect(r.quiet.value).toEqual({ since: T0, last: T0 + 2 * MIN })
    r.flow.stop()
    // Begun yesterday afternoon and last heard last night, in launches since closed.
    const later = start({ since: T0 - 20 * 60 * MIN, last: T0 - 14 * 60 * MIN })
    later.updater.emit('error', stillPublishing())
    expect(later.sent).toEqual([['update:error', updateFailureMessage('publishing')]])
  })

  it('a found update, or none, ends the quiet run on disk too', () => {
    const r = start()
    r.updater.emit('error', stillPublishing())
    expect(r.quiet.value?.since).toBe(T0)
    r.updater.emit('update-not-available')
    expect(r.quiet.value).toBeNull()
    r.updater.emit('error', stillPublishing())
    r.updater.emit('update-available', { version: '9.9.9' })
    expect(r.quiet.value).toBeNull()
  })
})

describe('a dead feed', () => {
  it('⛔ is said at once, on the first answer, not 45 minutes in', () => {
    const r = start()
    r.updater.emit('error', deadFeed())
    expect(r.sent).toEqual([['update:error', updateFailureMessage('missing')]])
    expect(r.status()).toEqual({ kind: 'error', message: updateFailureMessage('missing') })
    expect(r.logs[0]).toContain('releases.atom')
  })
})

describe('a downloaded update', () => {
  it('⛔ is announced once per version, not every fifteen minutes', () => {
    const r = start()
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    expect(r.sent.filter(([c]) => c === 'update:ready')).toEqual([['update:ready', '9.9.9']])
  })

  it('applies itself at once when he is already away and nothing is busy', () => {
    const r = start()
    r.idle.s = IDLE_APPLY_S
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    expect(r.sent).toEqual([['update:autoApply', '9.9.9']])
  })

  it('otherwise offers the restart, and applies itself once he steps away', () => {
    const r = start()
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    expect(r.sent).toEqual([['update:ready', '9.9.9']])
    vi.advanceTimersByTime(IDLE_POLL_MS * 3)
    expect(r.sent).toHaveLength(1)
    r.idle.s = IDLE_APPLY_S + 10
    vi.advanceTimersByTime(IDLE_POLL_MS)
    expect(r.sent).toEqual([
      ['update:ready', '9.9.9'],
      ['update:autoApply', '9.9.9'],
    ])
    vi.advanceTimersByTime(IDLE_POLL_MS * 5)
    expect(r.sent).toHaveLength(2) // once, not every thirty seconds
  })

  it('⛔ never applies itself through an export, however long he is away', () => {
    const r = start()
    r.busy.on = true
    r.idle.s = 4000
    r.updater.emit('update-downloaded', { version: '9.9.9' })
    vi.advanceTimersByTime(IDLE_POLL_MS * 20)
    expect(r.sent).toEqual([['update:ready', '9.9.9']])
    r.busy.on = false
    vi.advanceTimersByTime(IDLE_POLL_MS)
    expect(r.sent.at(-1)).toEqual(['update:autoApply', '9.9.9'])
  })
})

describe('fileQuietStore', () => {
  it('keeps the start of a quiet run across a restart, and forgets it when told', () => {
    vi.useRealTimers()
    const dir = mkdtempSync(path.join(tmpdir(), 'olp-quiet-'))
    try {
      const file = path.join(dir, 'update-quiet-since.json')
      expect(fileQuietStore(file).read()).toBeNull()
      fileQuietStore(file).write({ since: T0, last: T0 + MIN })
      expect(fileQuietStore(file).read()).toEqual({ since: T0, last: T0 + MIN })
      // Kept by the version before this one: no last answer, so its start stands in.
      writeFileSync(file, JSON.stringify({ since: T0 }))
      expect(fileQuietStore(file).read()).toEqual({ since: T0, last: T0 })
      fileQuietStore(file).write(null)
      expect(fileQuietStore(file).read()).toBeNull()
      expect(() => fileQuietStore(file).write(null)).not.toThrow()
      expect(fileQuietStore(path.join(dir, 'no', 'such', 'dir.json')).read()).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
