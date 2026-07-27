import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../electron/ipc-types'
import { TIMED_OUT, bootDetailFor, updateLine } from './updateStatus'

// This is the honesty contract for the update line: every state the updater can be
// in must read as itself. The failure that started all of this was a check that
// said nothing at all, so "nothing to say" is allowed in exactly one case.
describe('updateLine', () => {
  it('says it is checking, and then says it checked', () => {
    expect(updateLine({ kind: 'checking' })).toBe('Checking for updates…')
    expect(updateLine({ kind: 'none' })).toBe('Up to date')
  })

  it('names the version it found and how far the download has got', () => {
    expect(updateLine({ kind: 'available', version: '0.1.15' })).toBe('Update 0.1.15 found, downloading now')
    expect(updateLine({ kind: 'downloading', version: '0.1.15', percent: 42 })).toBe(
      'Downloading update 0.1.15, 42%',
    )
    expect(updateLine({ kind: 'downloaded', version: '0.1.15' })).toBe(
      'Update 0.1.15 downloaded. Restart to install',
    )
  })

  it('tells "never answered" apart from "answered badly"', () => {
    expect(updateLine({ kind: 'error', message: TIMED_OUT })).toBe('Could not reach the update server')
    expect(updateLine({ kind: 'error', message: 'HttpError: 404' })).toBe('Could not check for updates')
  })

  // The card row and the splash line say the same thing at different lengths: the
  // row is narrow and a long reason was being cut off mid-word.
  it('has a short row detail for each failure that still tells them apart', () => {
    expect(bootDetailFor({ kind: 'error', message: TIMED_OUT })).toBe('no answer')
    expect(bootDetailFor({ kind: 'error', message: 'HttpError: 404' })).toBe('check failed')
    expect(bootDetailFor({ kind: 'none' })).toBe('up to date')
    expect(bootDetailFor({ kind: 'downloading', version: '0.1.15', percent: 7 })).toBe('downloading 0.1.15, 7%')
    for (const kind of ['error', 'none'] as const) {
      const detail = bootDetailFor(kind === 'none' ? { kind } : { kind, message: 'x' })
      expect(detail.length).toBeLessThanOrEqual(24) // fits the row without an ellipsis
    }
  })

  it('says nothing before there is anything to say, and nothing in a dev build', () => {
    expect(updateLine(null)).toBeNull()
    expect(updateLine({ kind: 'unsupported' })).toBeNull()
  })

  it('covers every kind the shell can report, so a new one must not fall through silently', () => {
    const kinds: UpdateStatus[] = [
      { kind: 'checking' },
      { kind: 'available', version: '1' },
      { kind: 'downloading', version: '1', percent: 0 },
      { kind: 'downloaded', version: '1' },
      { kind: 'none' },
      { kind: 'error', message: 'x' },
      { kind: 'unsupported' },
    ]
    for (const k of kinds) expect(updateLine(k)).not.toBeUndefined()
  })
})
