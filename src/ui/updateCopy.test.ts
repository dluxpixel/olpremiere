// The words on the update card, and the one rule the bar cannot break.
//
// His ask, 2026-08-24: *"when its downloading it does a downloading screen similiar
// to the opening of the app screen."* So this file guards the two things that make
// it the same screen rather than a lookalike: it says what is true, and it never
// prints a fraction whose denominator it has not named.

import { describe, expect, it } from 'vitest'
import { UPDATE_BAR_SEGMENTS } from '../../electron/ipc-types'
import type { UpdateStatus } from '../../electron/ipc-types'
import { updateCount, updateRows, updateStatusLine, updateTitle } from './updateCopy'

const downloading = (percent: number, transferred?: number, total?: number): UpdateStatus => ({
  kind: 'downloading',
  version: '2.38.0',
  percent,
  transferred,
  total,
})

describe('the bar can actually reach the end', () => {
  // ⛔ If this ever fails, the last segment can never light and the bar reads full
  // while the download is still running: the boot bar's old lie in a new shape.
  it('has a segment count that divides 100', () => {
    expect(100 % UPDATE_BAR_SEGMENTS).toBe(0)
  })

  it('lights every segment at 100 and none at 0', () => {
    const filled = (p: number): number => Math.floor((p * UPDATE_BAR_SEGMENTS) / 100)
    expect(filled(0)).toBe(0)
    expect(filled(100)).toBe(UPDATE_BAR_SEGMENTS)
    expect(filled(50)).toBe(UPDATE_BAR_SEGMENTS / 2)
  })
})

describe('the figure names its denominator', () => {
  it('says how much of how much, never a bare percent', () => {
    expect(updateCount(112, 240, 47)).toBe('112 of 240 MB')
  })

  // The only case where a bare fraction is allowed: an older shell that sends no
  // byte counts at all. Ugly beats absent.
  it('falls back to the percent only when there is no total', () => {
    expect(updateCount(0, 0, 47)).toBe('47%')
  })
})

describe('the rows say what is true and nothing more', () => {
  it('shows the check done and the download running', () => {
    const rows = updateRows(downloading(40))
    expect(rows.map((r) => r.state)).toEqual(['done', 'active'])
    expect(rows[0].label).toBe('Checked for updates')
  })

  it('settles both rows when it has arrived', () => {
    expect(updateRows({ kind: 'downloaded', version: '2.38.0' }).map((r) => r.state)).toEqual(['done', 'done'])
  })

  it('marks the download failed without touching the check that did succeed', () => {
    const rows = updateRows({ kind: 'error', message: 'nope' })
    expect(rows.map((r) => r.state)).toEqual(['done', 'failed'])
  })

  // ⛔ NO ROW PROMISES A RESTART. The update applies at the next launch, on idle, or
  // on quit. A pending "Restart to install" row would narrate a policy he replaced.
  it('never adds a row for a restart', () => {
    for (const s of [downloading(10), { kind: 'downloaded' as const, version: '2.38.0' }]) {
      expect(updateRows(s)).toHaveLength(2)
      expect(JSON.stringify(updateRows(s))).not.toMatch(/restart/i)
    }
  })
})

describe('the line under the bar says what happens next', () => {
  it('promises no click while it downloads', () => {
    expect(updateStatusLine(downloading(30), '2.38.0')).toBe('Installs the next time OL Premiere starts')
  })

  it('explains the melon before it appears', () => {
    expect(updateStatusLine({ kind: 'downloaded', version: '2.38.0' }, '2.38.0')).toContain('Restart to install')
  })

  it('says the download failed, not that the check did', () => {
    expect(updateStatusLine({ kind: 'error', message: 'x' }, '2.38.0')).toBe('Could not download the update')
  })
})

describe('the heading carries the version, once', () => {
  it('names the version coming in', () => {
    expect(updateTitle('2.38.0')).toBe('Updating to 2.38.0')
  })

  it('still reads as a sentence before a version is known', () => {
    expect(updateTitle('')).toBe('Updating')
  })
})
