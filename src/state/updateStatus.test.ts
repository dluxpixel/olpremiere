import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../electron/ipc-types'
import { UPDATE_FAILURES, updateFailureMessage } from '../../electron/updateErrors'
import { TIMED_OUT, bootDetailFor, updateErrorToast, updateLine, updateInHand } from './updateStatus'

// This is the honesty contract for the update line: every state the updater can be
// in must read as itself. The failure that started all of this was a check that
// said nothing at all, so "nothing to say" is allowed in exactly one case.
describe('updateLine', () => {
  it('says it is checking, and then says it checked', () => {
    expect(updateLine({ kind: 'checking' })).toBe('Checking for updates…')
    expect(updateLine({ kind: 'none' })).toBe('Up to date')
  })

  // Every version the user READS drops the pre-1.0 zero (his call: "make it just
  // 1.21"). The feed still compares the real semver; only the words change.
  it('names the version it found and how far the download has got', () => {
    expect(updateLine({ kind: 'available', version: '0.1.15' })).toBe('Update 1.15 found, downloading now')
    expect(updateLine({ kind: 'downloading', version: '0.1.15', percent: 42 })).toBe(
      'Downloading update 1.15, 42%',
    )
    expect(updateLine({ kind: 'downloaded', version: '0.1.15' })).toBe(
      'Update 1.15 downloaded. Restart to install',
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
    expect(bootDetailFor({ kind: 'downloading', version: '0.1.15', percent: 7 })).toBe('downloading 1.15, 7%')
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
      { kind: 'pending' },
      { kind: 'error', message: 'x' },
      { kind: 'unsupported' },
    ]
    for (const k of kinds) expect(updateLine(k)).not.toBeUndefined()
  })
})

// The melon shows a bite once an update is in hand. "In hand" is a fact about
// the feed, so it lives with the feed.
describe('updateInHand', () => {
  it('is true once there is something to install', () => {
    expect(updateInHand({ kind: 'available', version: '0.1.82' })).toBe(true)
    expect(updateInHand({ kind: 'downloading', version: '0.1.82', percent: 12 })).toBe(true)
    expect(updateInHand({ kind: 'downloaded', version: '0.1.82' })).toBe(true)
  })

  it('⛔ is FALSE while merely checking, or the melon would bite on every click', () => {
    expect(updateInHand({ kind: 'checking' })).toBe(false)
  })

  it('is false when there is nothing to say', () => {
    expect(updateInHand(null)).toBe(false)
    expect(updateInHand({ kind: 'none' })).toBe(false)
    expect(updateInHand({ kind: 'pending' })).toBe(false)
    expect(updateInHand({ kind: 'unsupported' })).toBe(false)
    expect(updateInHand({ kind: 'error', message: 'nope' })).toBe(false)
  })
})

// A release that is still being published is not an error and not "up to date". It
// reads as itself, quietly, and it must not look like a failure on the boot card.
describe('a release still being published', () => {
  it('says so plainly, in a line that is not an apology or a warning', () => {
    const line = updateLine({ kind: 'pending' })
    expect(line).toBe('An update is on its way, it will show up shortly')
    expect(line).not.toMatch(/fail|error|could not|[\u2013\u2014]/i)
  })

  it('has a short row detail that fits the boot card and does not read as a failure', () => {
    const detail = bootDetailFor({ kind: 'pending' })
    expect(detail).toBe('on its way')
    expect(detail.length).toBeLessThanOrEqual(24)
    expect(detail).not.toBe(bootDetailFor({ kind: 'error', message: 'x' }))
  })
})

// ⛔ The toast is the last place a raw updater message could reach his screen, as it did
// on 2026-10-04 (a URL, the response headers and a stack trace). It shows the fixed
// sentences main sends and nothing else.
describe('updateErrorToast', () => {
  it('passes through each sentence main sends, unchanged', () => {
    for (const k of UPDATE_FAILURES) {
      expect(updateErrorToast(updateFailureMessage(k))).toBe(updateFailureMessage(k))
    }
  })

  it('replaces anything else, however it got here, with the plain generic sentence', () => {
    const raw =
      'Cannot find latest.yml in the latest release artifacts (https://github.com/dluxpixel/olpremiere/releases/download/v3.22.0/latest.yml): HttpError: 404\nheaders: {}\n    at x (y.js:1:1)'
    expect(updateErrorToast(raw)).toBe(updateFailureMessage('other'))
    expect(updateErrorToast('')).toBe(updateFailureMessage('other'))
    expect(updateErrorToast(raw)).not.toMatch(/http|404|latest\.yml|headers|\n/i)
  })
})
