// The auto-updater's rules, out of main.ts so they can be RUN in a test instead of read.
//
// Until 2026-10-06 these lived inline in main.ts and the only tests read its text: a
// `toContain` here, a `toMatch` there. A change that kept the strings and broke the
// order passed, and the dead feed that took 45 minutes to be said out loud was invisible
// to them. Everything that touches Electron (the windows, the card, the install and its
// close then wait) stays in main; this gets the updater, the clock and the answers it
// needs handed in, so fake timers can drive it through an afternoon in a millisecond.
//
// The rules, each one a scar (main.ts and the tests carry the stories):
//   - one check at start, then every fifteen minutes; never over a live download, and
//     not at all once a version is staged
//   - a release still being published says nothing and looks again at 2, 4 and 8 minutes
//   - a found update, or none, ends a quiet run
//   - "downloaded" is announced once per version, not every fifteen minutes
//   - a downloaded update applies itself only once he is away and nothing is busy
//   - ⛔ checkForUpdates, never checkForUpdatesAndNotify: that one also asks Windows for
//     a system notification on every download ("A new update is ready to install"),
//     about twice a day, on top of the app's own toast, card and top bar mark

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { UpdateStatus } from './ipc-types'
import { IDLE_POLL_MS, updateApplyDecision } from './updateApply'
import { planUpdateError, updateLogEntry } from './updateErrors'

/** How often an app left open looks for a release, so it gets one the same day. */
export const POLL_MS = 15 * 60_000

/** The parts of electron-updater's autoUpdater this uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (p: { percent: number; transferred: number; total: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
}

/** Where the start of a quiet run is kept, so it survives a restart (./updateErrors). */
export interface QuietStore {
  read(): number | null
  write(since: number | null): void
}

export interface UpdateFlowDeps {
  updater: UpdaterLike
  getStatus(): UpdateStatus
  setStatus(status: UpdateStatus): void
  /** To the editor page. */
  send(channel: 'update:error' | 'update:none' | 'update:ready' | 'update:autoApply', arg?: string): void
  /** Seconds since the last input anywhere on the machine. */
  idleSeconds(): number
  /** An export, a preview copy, a conversion or a take is in flight. */
  busy(): boolean
  /** One entry for logs/update-check.log. */
  log(entry: string): void
  quiet: QuietStore
  now?: () => number
}

export interface UpdateFlow {
  /** Look now. Used at start, by the poll, by a recheck, and by his reload button. */
  check(): void
  stop(): void
}

export function startUpdateFlow(d: UpdateFlowDeps): UpdateFlow {
  const now = d.now ?? Date.now
  let pendingVersion = ''
  /** The version he has already been told is ready. Empty until one is. */
  let announcedVersion = ''
  let idleApplyTimer: ReturnType<typeof setInterval> | null = null
  /** "Still publishing" answers in a row in this session. The start time is on disk. */
  let publishingStreak = 0
  let recheckTimer: ReturnType<typeof setTimeout> | null = null

  const check = (): void => {
    d.setStatus({ kind: 'checking' })
    // A failure is answered by the 'error' listener; these catches only stop the same
    // failure also landing as an unhandled rejection in main.
    d.updater.checkForUpdates().then(
      (r) => void r?.downloadPromise?.catch(() => undefined),
      () => undefined,
    )
  }

  const recheckSoon = (ms: number): void => {
    if (recheckTimer) clearTimeout(recheckTimer)
    recheckTimer = setTimeout(() => {
      recheckTimer = null
      // Only if nothing has moved on since: his click or the fifteen minute poll may
      // already have asked, and a second check over a live one helps no one.
      if (d.getStatus().kind !== 'pending') return
      check()
    }, ms)
  }

  const endQuietRun = (): void => {
    publishingStreak = 0
    if (d.quiet.read() !== null) d.quiet.write(null)
  }

  d.updater.autoDownload = true
  d.updater.autoInstallOnAppQuit = true // a pending update also installs on any quit

  d.updater.on('error', (e) => {
    // ⛔ NEVER SWALLOW THIS. Every failure is kept, in full, in the log; what reaches
    // HIS screen is one plain sentence, or nothing for a release still being published.
    const before = d.quiet.read()
    const plan = planUpdateError(e, { streak: publishingStreak, quietSince: before, now: now() })
    publishingStreak = plan.streak
    if (plan.quietSince !== before) d.quiet.write(plan.quietSince)
    d.log(updateLogEntry(new Date(now()), plan, e))
    if (plan.message === null) {
      d.setStatus({ kind: 'pending' })
      if (plan.retryInMs !== null) recheckSoon(plan.retryInMs)
      return
    }
    d.send('update:error', plan.message)
    d.setStatus({ kind: 'error', message: plan.message })
  })

  d.updater.on('update-not-available', () => {
    endQuietRun()
    d.send('update:none')
    d.setStatus({ kind: 'none' })
  })

  // Found one, and the download starts itself (autoDownload), so say so, and then say
  // how far it has got.
  d.updater.on('update-available', (info) => {
    endQuietRun()
    pendingVersion = info.version
    d.setStatus({ kind: 'available', version: info.version })
  })

  d.updater.on('download-progress', (p) => {
    // transferred/total ride along so the card can print "112 of 240 MB".
    d.setStatus({
      kind: 'downloading',
      version: pendingVersion,
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    })
  })

  d.updater.on('update-downloaded', (info) => {
    // ⛔ ONCE PER VERSION. A staged update stays on disk, so every later check finds it
    // there and says "downloaded" again, and the toast came back four times an hour.
    if (announcedVersion === info.version) return
    announcedVersion = info.version
    d.setStatus({ kind: 'downloaded', version: info.version })
    // The renderer decides: it flushes a save and restarts only if nothing critical is
    // in flight, else it falls back to the "Restart to update" toast.
    const decide = (): 'now' | 'when-idle' | 'never' => updateApplyDecision({ idleSeconds: d.idleSeconds(), busy: d.busy() })
    if (decide() === 'now') {
      d.send('update:autoApply', info.version)
      return
    }
    d.send('update:ready', info.version)
    if (idleApplyTimer) clearInterval(idleApplyTimer)
    idleApplyTimer = setInterval(() => {
      if (decide() !== 'now') return
      if (idleApplyTimer) clearInterval(idleApplyTimer)
      idleApplyTimer = null
      d.send('update:autoApply', info.version)
    }, IDLE_POLL_MS)
  })

  check()
  const poll = setInterval(() => {
    const kind = d.getStatus().kind
    // Once a version is staged the answer cannot improve: it installs on the next
    // restart either way. The reload button still forces a check.
    if (kind === 'downloaded') {
      clearInterval(poll)
      return
    }
    // ⛔ AND NEVER OVER A LIVE DOWNLOAD: it wrote {checking} across the percent.
    if (kind === 'downloading') return
    check()
  }, POLL_MS)

  return {
    check,
    stop() {
      clearInterval(poll)
      if (recheckTimer) clearTimeout(recheckTimer)
      if (idleApplyTimer) clearInterval(idleApplyTimer)
      recheckTimer = null
      idleApplyTimer = null
    },
  }
}

/** The quiet run's start in one small file in userData. Never throws. */
export function fileQuietStore(file: string): QuietStore {
  return {
    read() {
      try {
        const at = (JSON.parse(readFileSync(file, 'utf8')) as { since?: unknown }).since
        return typeof at === 'number' && Number.isFinite(at) ? at : null
      } catch {
        return null
      }
    },
    write(since) {
      try {
        if (since === null) unlinkSync(file)
        else writeFileSync(file, JSON.stringify({ since }))
      } catch {
        // a lost note only means the hour starts again
      }
    },
  }
}
