// The ship script is the thing that ships everything else, and on 2026-08-12 it
// lost two finished builds to one dropped packet each. Its retry is unit tested
// for the same reason `_verify` is: a step that only runs during a 25 minute
// release cannot be "checked by eye" in any useful sense.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTransientFailure, runLoggedRetry } from './lib.mjs'

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
