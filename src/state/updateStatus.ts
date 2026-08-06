// One source of truth for where the auto-updater stands, shared by the loading
// card's "Checking for updates" row and the line under the melon on the splash.
//
// It PULLS the current status as well as subscribing to changes. The check starts
// in the main process the moment the app is ready, which can be before this
// renderer has run a line of code, so subscribing alone would miss that answer and
// leave the row saying "Checking…" forever, which is the exact silence that let a
// dead update feed hide for weeks.

import { create } from 'zustand'
import type { UpdateStatus } from '../../electron/ipc-types'
import { displayVersion } from '../appVersion'

interface UpdateFeed {
  status: UpdateStatus | null
}

export const useUpdateFeed = create<UpdateFeed>(() => ({ status: null }))

/** How long to let "Checking…" stand before calling it unreachable. */
export const CHECK_TIMEOUT_MS = 15_000
/** Marks the "nothing ever answered" failure apart from a reported one. */
export const TIMED_OUT = 'timed out'

/** The plain-English line for the splash. Null when there is nothing honest to say. */
export function updateLine(status: UpdateStatus | null): string | null {
  if (!status) return null
  switch (status.kind) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update ${displayVersion(status.version)} found, downloading now`
    case 'downloading':
      return `Downloading update ${displayVersion(status.version)}, ${status.percent}%`
    case 'downloaded':
      return `Update ${displayVersion(status.version)} downloaded. Restart to install`
    case 'none':
      return 'Up to date'
    case 'error':
      // Silence that looks like progress is what misled him for weeks, so the two
      // failures read differently: no answer at all vs. an answer that failed.
      return status.message === TIMED_OUT ? 'Could not reach the update server' : 'Could not check for updates'
    case 'unsupported':
      return null // a dev build has no updater; saying anything would be theatre
  }
}

/**
 * The SHORT fact appended to the loading card's update row.
 *
 * Short on purpose: the row is one narrow line on a small card, and a long reason
 * gets cut off mid-word (it did, in the packaged build). It still has to tell the
 * failures apart, because a server that answered and failed is not the same as one
 * that never answered. The fuller sentence lives in `updateLine`, under the melon.
 */
export function bootDetailFor(status: UpdateStatus): string {
  switch (status.kind) {
    case 'checking':
      return ''
    case 'available':
      return `found ${displayVersion(status.version)}`
    case 'downloading':
      return `downloading ${displayVersion(status.version)}, ${status.percent}%`
    case 'downloaded':
      return `update ${displayVersion(status.version)} downloaded`
    case 'none':
      return 'up to date'
    case 'error':
      return status.message === TIMED_OUT ? 'no answer' : 'check failed'
    case 'unsupported':
      return 'dev build'
  }
}

/** True once the check has an answer that will not change again. */
function isSettledStatus(status: UpdateStatus): boolean {
  return status.kind !== 'checking' && status.kind !== 'available' && status.kind !== 'downloading'
}

/**
 * The update row's own wait, so the boot card can report it IN ITS TURN.
 *
 * `initUpdateFeed` starts the check the moment the renderer loads, which is what
 * gives it an answer by the time the card reaches this row. It used to write
 * straight into the ledger from that callback, and because the callback fires
 * before the project has even opened, the LAST row on the card went 'active'
 * while every row above it was still grey. Starting the work early and reporting
 * the row in order gets both.
 *
 * Always settles, and never rejects: `initUpdateFeed`'s own timeout calls an
 * updater that says nothing at all unreachable, and a build with no updater has
 * nothing to check, which is a row that is DONE rather than one that hangs.
 */
export function whenUpdateChecked(note: (detail: string) => void): Promise<{ ok: boolean; detail: string }> {
  const answer = (status: UpdateStatus): { ok: boolean; detail: string } => ({
    ok: status.kind !== 'error',
    detail: bootDetailFor(status),
  })
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.isElectron) return Promise.resolve({ ok: true, detail: 'no updater' })
  const current = useUpdateFeed.getState().status
  if (current && isSettledStatus(current)) return Promise.resolve(answer(current))
  return new Promise((resolve) => {
    const stop = useUpdateFeed.subscribe(({ status }) => {
      if (!status) return
      if (isSettledStatus(status)) {
        stop()
        resolve(answer(status))
      } else {
        // Keeps the row running but updates its fact (the download percentage).
        const detail = bootDetailFor(status)
        if (detail) note(detail)
      }
    })
  })
}

/** Start watching the desktop updater. A no-op on the web build. */
export function initUpdateFeed(): void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.isElectron) return

  const apply = (status: UpdateStatus): void => {
    useUpdateFeed.setState({ status })
  }

  // Assume a check is under way until told otherwise, so the row appears at once.
  apply({ kind: 'checking' })
  api.onUpdateStatus(apply)
  void api.getUpdateStatus().then(apply, () => {
    /* the shell is older than this renderer: leave the subscription to answer */
  })

  window.setTimeout(() => {
    if (useUpdateFeed.getState().status?.kind === 'checking') {
      apply({ kind: 'error', message: TIMED_OUT })
    }
  }, CHECK_TIMEOUT_MS)
}
