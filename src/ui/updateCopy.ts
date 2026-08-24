// The words on the update card. Zero runtime dependencies, the same role bootCopy.ts
// plays and for the same reason: this page may not import state/updateStatus.ts,
// which builds a zustand store at its top level and would drag the editor's ledger
// into a page whose job is to be standalone.
//
// ⛔ IT DOES NOT RESTATE updateLine(). The toast and this card say different things
// because they are in different places: a toast appears once and has to carry the
// whole fact; a card has a heading, two rows, a bar and a figure to spread it over.
// The one sentence they share, the downloaded line, is copied from it verbatim.

import type { UpdateStatus } from '../../electron/ipc-types'
import type { BootStepState } from './bootProgress'

export interface UpdateRow {
  id: string
  label: string
  state: BootStepState
}

/**
 * The panel heading. `.groupTitle` uppercases it, so this is the loudest place the
 * incoming version appears and it costs no new markup.
 */
export function updateTitle(version: string): string {
  return version ? `Updating to ${version}` : 'Updating'
}

/**
 * TWO rows, and there are two because two things are true.
 *
 * The temptation is to pad, a "connecting", a "verifying", a "preparing", a
 * permanently pending "installs later", so the panel looks as busy as the boot
 * card's eleven. Every one of those is a row with no event behind it, and this
 * app's bar was rebuilt once already for measuring something other than what was
 * drawn under it.
 *
 * "Checked for updates" is word for word the boot card's own update row. The
 * sentence he read on the splash is the sentence he reads here. Neither row names
 * the version: the heading above them does, once.
 *
 * ⛔ NO ROW PROMISES A RESTART. The update applies at the next fresh launch, or the
 * moment he steps away, or on quit. A pending "Restart to install" row would be the
 * card narrating a policy that was replaced on 2026-08-17. What happens next is one
 * line in the footer, not a row.
 */
export function updateRows(s: UpdateStatus): UpdateRow[] {
  const checked: UpdateRow = { id: 'check', label: 'Checked for updates', state: 'done' }
  if (s.kind === 'error') return [checked, { id: 'download', label: 'Download failed', state: 'failed' }]
  const done = s.kind === 'downloaded'
  return [
    checked,
    { id: 'download', label: done ? 'Downloaded' : 'Downloading the update', state: done ? 'done' : 'active' },
  ]
}

/**
 * The line under the bar. It says what happens NEXT, because the rows already say
 * what is happening now and the same sentence twice on a 400px card is padding.
 */
export function updateStatusLine(s: UpdateStatus, version: string): string {
  if (s.kind === 'downloaded') return `Update ${version} downloaded. Restart to install`
  if (s.kind === 'error') return 'Could not download the update'
  // True of all three doors: the fresh-launch apply, the idle apply, and the quit
  // install. It never promises a click he has to make.
  return 'Installs the next time OL Premiere starts'
}

/**
 * ⛔ "112 of 240 MB", NOT "47%".
 *
 * The boot bar carries the same lesson in its own comment: both are the same
 * fraction, and only one of them says which. A bare percent in this slot is the
 * exact affordance that scar is about. electron-updater hands main `transferred`
 * and `total` on the same event it takes `percent` from, and they were being
 * discarded; carrying them costs two properties and buys the card a named
 * denominator.
 *
 * The fallback is the percent, for an older shell that sends neither. Ugly is
 * better than absent, and it is the only case where this card prints a bare
 * fraction.
 */
export function updateCount(doneMb: number, totalMb: number, percent: number): string {
  if (totalMb > 0) return `${doneMb} of ${totalMb} MB`
  return `${percent}%`
}
