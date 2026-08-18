// The ship script is the thing that ships everything else, and on 2026-08-12 it
// lost two finished builds to one dropped packet each. Its retry is unit tested
// for the same reason `_verify` is: a step that only runs during a 25 minute
// release cannot be "checked by eye" in any useful sense.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBigUpdate, isTransientFailure, releaseWork, runLoggedRetry } from './lib.mjs'

/**
 * A command that fails `failures` times and then succeeds, printing `message`
 * each time it fails. A real child process, because the thing being tested is
 * how this reacts to a real exit code and a real stream.
 */
function flakyCommand(failures, message) {
  const dir = mkdtempSync(join(tmpdir(), 'olp-retry-'))
  const counter = join(dir, 'n')
  const script = join(dir, 'run.mjs')
  writeFileSync(counter, '0')
  writeFileSync(
    script,
    [
      `import { readFileSync, writeFileSync } from 'node:fs'`,
      `const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1`,
      `writeFileSync(${JSON.stringify(counter)}, String(n))`,
      `if (n <= ${failures}) { console.error(${JSON.stringify(message)}); process.exit(1) }`,
      `console.log('ok')`,
    ].join('\n'),
  )
  return { cmd: `node "${script}"`, attempts: () => Number(readFileSync(counter, 'utf8')) }
}

// Silent and instant: this suite must not print a wall of banners or spend
// real seconds sleeping between attempts.
const QUIET = { tries: 3, baseDelayMs: 0 }

describe('isTransientFailure', () => {
  it('knows the drop that cost two ships', () => {
    expect(isTransientFailure('⨯ socket hang up  failedTask=build')).toBe(true)
  })

  it('knows the other shapes of a bad wire', () => {
    for (const s of ['read ECONNRESET', 'ETIMEDOUT', 'getaddrinfo ENOTFOUND github.com', 'HTTP 503', 'RequestError: x']) {
      expect(isTransientFailure(s), s).toBe(true)
    }
  })

  // ⛔ The point of the list. A build that is genuinely broken must fail once.
  it('does NOT call a broken build transient', () => {
    for (const s of ['error TS2345: Argument of type', 'ELIFECYCLE', '1 failed', 'Module not found', '']) {
      expect(isTransientFailure(s), s).toBe(false)
    }
    expect(isTransientFailure(undefined)).toBe(false)
  })

  /**
   * ⛔ AND A PUSH THAT WAS REFUSED IS NOT A DROPPED WIRE EITHER, which matters more
   * since 2026-08-17, when the push learned to retry. It died on `socket hang up`
   * that night after a nine minute gate, and the version was bumped and committed
   * with nothing on the remote and nothing released.
   *
   * ⛔ THE RETRY MUST NOT SWALLOW THE 2026-08-12 SCAR. That day the push died on
   * "could not read Username", and a bare credential failure retried three times is
   * 45 seconds of waiting for the same certain no, with the real reason pushed three
   * screens up the log. Both of these have to fail on the FIRST attempt.
   */
  it('does NOT call a refused push transient', () => {
    for (const s of [
      "fatal: could not read Username for 'https://github.com': No such device or address",
      '! [rejected] main -> main (fetch first)',
      'Updates were rejected because the remote contains work that you do not have',
      'fatal: Authentication failed',
      'remote: Permission to dluxpixel/olpremiere.git denied',
    ]) {
      expect(isTransientFailure(s), s).toBe(false)
    }
  })
})

describe('runLoggedRetry', () => {
  it('rides out a dropped connection and succeeds', async () => {
    const { cmd, attempts } = flakyCommand(2, 'socket hang up')
    await expect(runLoggedRetry(cmd, 'package', null, QUIET)).resolves.toBeUndefined()
    expect(attempts()).toBe(3)
  })

  // ⛔ THE ONE THAT MATTERS MOST. Retrying a real failure turns something
  // repeatable into something that looks intermittent, and wastes the time
  // twice over.
  it('does NOT retry a real failure, it fails the first time', async () => {
    const { cmd, attempts } = flakyCommand(99, 'error TS2345: Argument of type')
    await expect(runLoggedRetry(cmd, 'package', null, QUIET)).rejects.toThrow(/exited 1/)
    expect(attempts()).toBe(1)
  })

  it('gives up after the last try rather than looping forever', async () => {
    const { cmd, attempts } = flakyCommand(99, 'socket hang up')
    await expect(runLoggedRetry(cmd, 'package', null, QUIET)).rejects.toThrow(/exited 1/)
    expect(attempts()).toBe(3)
  })

  it('carries what the command said, so the caller can tell why', async () => {
    const { cmd } = flakyCommand(99, 'error TS2345: Argument of type')
    await expect(runLoggedRetry(cmd, 'package', null, QUIET)).rejects.toMatchObject({
      output: expect.stringContaining('TS2345'),
    })
  })
})

// ⛔ THE CASE THAT MATTERS HERE IS THE THIRD ONE. On 2026-08-17 five commits of
// finished work were stranded on main because the ship script asked "is anything
// uncommitted or unpushed" instead of "is anything unreleased", so it answered
// "nothing to release" while his app stayed a version behind. A script that can
// refuse to publish finished work needs the refusal pinned, not eyeballed.
describe('releaseWork', () => {
  it('ships an uncommitted tree', () => {
    expect(releaseWork({ dirty: ' M src/App.tsx', unpushed: '0', unreleased: '0' })).toMatch(/uncommitted/)
  })

  it('ships commits that never got pushed', () => {
    expect(releaseWork({ dirty: '', unpushed: '2', unreleased: '2' })).toMatch(/not yet pushed/)
  })

  it('ships commits that are pushed but were never released', () => {
    expect(releaseWork({ dirty: '', unpushed: '0', unreleased: '5' })).toMatch(/above the last released tag/)
  })

  it('does nothing when the last tag is HEAD', () => {
    expect(releaseWork({ dirty: '', unpushed: '0', unreleased: '0' })).toBeNull()
  })

  it('treats whitespace from git as a clean tree', () => {
    expect(releaseWork({ dirty: '\n', unpushed: '0', unreleased: '0' })).toBeNull()
  })
})

// This one decides whether a window appears on his screen during a ship, so the
// boundary is worth pinning rather than eyeballing.
describe('isBigUpdate', () => {
  it('a patch is not big', () => {
    expect(isBigUpdate('v2.0.3', '2.0.4')).toBe(false)
    expect(isBigUpdate('v2.0.9', '2.0.10')).toBe(false)
  })

  it('a minor or a major is big', () => {
    expect(isBigUpdate('v2.0.4', '2.1.0')).toBe(true)
    expect(isBigUpdate('v2.9.9', '3.0.0')).toBe(true)
  })

  it('going BACKWARDS is still big, because something odd happened', () => {
    expect(isBigUpdate('v3.0.0', '2.9.0')).toBe(true)
  })

  it('no previous tag at all counts as big, so the stronger check runs', () => {
    expect(isBigUpdate('', '1.0.0')).toBe(true)
    expect(isBigUpdate(null, '1.0.0')).toBe(true)
    expect(isBigUpdate('not-a-version', '1.0.0')).toBe(true)
  })
})
