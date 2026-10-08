// The ship script is the thing that ships everything else, and on 2026-08-12 it
// lost two finished builds to one dropped packet each. Its retry is unit tested
// for the same reason `_verify` is: a step that only runs during a 25 minute
// release cannot be "checked by eye" in any useful sense.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isBigUpdate,
  isTransientFailure,
  MAY_BE_LIVE,
  mayBeLive,
  mayBeLiveReport,
  MINOR_ROLLOVER,
  nextVersion,
  planShip,
  releaseWork,
  runLoggedRetry,
} from './lib.mjs'

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

  // ⛔ A release that may already be live only ever fails on a dead wire, so its output
  // always carries a network signature. Running again starts by deleting it.
  it('does NOT call a release that may already be live transient, whatever the wire said', () => {
    expect(isTransientFailure(`v9.9.9 MAY ALREADY BE PUBLISHED: fetch failed\n   ${MAY_BE_LIVE}\n[cause]: Error: read ECONNRESET`)).toBe(false)
    expect(isTransientFailure(`getaddrinfo ENOTFOUND api.github.com\n${MAY_BE_LIVE}`)).toBe(false)
  })
})

describe('mayBeLiveReport', () => {
  it('tells him to look before running anything, and ends on the line that stops a caller too', () => {
    const lines = mayBeLiveReport('9.9.9', `noise\n${MAY_BE_LIVE}\nmore`)
    expect(lines.join('\n')).toContain('v9.9.9 MAY ALREADY BE LIVE')
    expect(lines.join('\n')).toContain('nothing was retried and nothing was deleted')
    expect(lines.join('\n')).not.toMatch(/Run the same command again/)
    expect(mayBeLive(lines.at(-1))).toBe(true)
  })

  it('says nothing for any other failure', () => {
    expect(mayBeLiveReport('9.9.9', 'read ECONNRESET')).toBeNull()
    expect(mayBeLiveReport('9.9.9', undefined)).toBeNull()
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

  // ⛔ release.mjs runs publish.mjs under this retry. Here the REAL publishRelease runs
  // the way publish.mjs runs it (top level, its error left for Node to print), against a
  // stubbed GitHub: the publish call lands, then the wire drops and stays down. Node
  // prints the error's cause chain, ECONNRESET included, which is a dropped connection
  // by every signature. Retrying it would start by deleting the release that is live.
  it('⛔ never runs a publish again that may already be live, and says so', async () => {
    const { cmd, attempts, github } = publishWhoseAnswerIsLost()
    const err = await runLoggedRetry(cmd, 'upload to GitHub', null, QUIET).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(attempts()).toBe(1)
    expect(err.output).toContain('MAY ALREADY BE PUBLISHED')
    expect(err.output).toContain(MAY_BE_LIVE)
    // Not a vacuous pass: the output does look like a dropped wire.
    expect(err.output).toContain('ECONNRESET')
    // The one run published it, and no run came back to delete it.
    expect(github()).toEqual({ releases: [{ id: 7, tag_name: 'v9.9.9', draft: false }], releaseDeletes: 0, nextId: 8 })
  })
})

/**
 * publish.mjs in miniature: the real publishRelease against a stubbed GitHub whose
 * publish call is applied and whose answer, and every call after it, is lost the way
 * fetch loses it (TypeError: fetch failed, caused by ECONNRESET). The stubbed GitHub
 * lives in a file, so a second run would find the first run's release (and delete it,
 * as every run starts by doing). Each run counts itself.
 */
function publishWhoseAnswerIsLost() {
  const dir = mkdtempSync(join(tmpdir(), 'olp-publish-'))
  const counter = join(dir, 'n')
  const state = join(dir, 'github.json')
  const script = join(dir, 'publish.mjs')
  writeFileSync(counter, '0')
  writeFileSync(state, JSON.stringify({ releases: [], releaseDeletes: 0, nextId: 7 }))
  const lib = new URL('./githubRelease.mjs', import.meta.url).href
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from 'node:fs'
import { githubApi, publishRelease } from ${JSON.stringify(lib)}
writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1))
const gh = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'))
const save = () => writeFileSync(${JSON.stringify(state)}, JSON.stringify(gh))
const assets = []
let down = false
const wire = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
const answer = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body ?? {}) })
const fetchImpl = async (url, opts = {}) => {
  const method = opts.method ?? 'GET'
  const path = new URL(url).pathname.replace('/repos/o/r', '')
  if (down) throw wire()
  const id = Number((/^\\/releases\\/(\\d+)/.exec(path) ?? [])[1])
  if (method === 'GET' && path === '/releases') return answer(200, gh.releases)
  if (method === 'DELETE' && path === '/releases/' + id) {
    gh.releases = gh.releases.filter((r) => r.id !== id)
    gh.releaseDeletes++
    save()
    return answer(204)
  }
  if (method === 'DELETE') return answer(204)
  if (method === 'GET' && path === '/git/ref/heads/main') return answer(200, { object: { sha: 'abc' } })
  if (method === 'POST' && path === '/git/refs') return answer(201, {})
  if (method === 'POST' && path === '/releases') {
    const r = { id: gh.nextId++, tag_name: 'v9.9.9', draft: true }
    gh.releases.push(r)
    save()
    return answer(201, r)
  }
  if (method === 'GET' && path === '/releases/' + id + '/assets') return answer(200, assets)
  if (method === 'PATCH' && path === '/releases/' + id) {
    gh.releases.find((r) => r.id === id).draft = false
    save()
    // Applied on GitHub's side, and then the wire goes and stays gone.
    down = true
    throw wire()
  }
  return answer(404, { message: 'no ' + method + ' ' + path })
}
await publishRelease({
  api: githubApi({ token: 't', fetchImpl }),
  repoPath: '/repos/o/r',
  tag: 'v9.9.9',
  assets: [{ name: 'latest.yml', file: 'x', type: 'text/yaml', bytes: 3 }],
  postAsset: async ({ name }) => { assets.push({ id: 1, name, state: 'uploaded', size: 3 }) },
  tagLocal: () => {},
  log: () => {},
  warn: () => {},
})
`,
  )
  return {
    cmd: `node "${script}"`,
    attempts: () => Number(readFileSync(counter, 'utf8')),
    github: () => JSON.parse(readFileSync(state, 'utf8')),
  }
}

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

// "when you upload to GitHub, it always takes a ton, a ton, and a ton of time"
// (2026-09-25). A ship now runs only the steps that are still owed.
describe('planShip', () => {
  const steps = (p) => p && { gate: p.gate, bump: p.bump, push: p.push, release: p.release }

  it('an ordinary change runs everything', () => {
    const p = planShip({ dirty: ' M src/App.tsx', unpushed: '0', unreleased: '0', headIsRelease: true, verified: false })
    expect(steps(p)).toEqual({ gate: true, bump: true, push: true, release: true })
  })

  it('code that already passed every check on this exact tree skips the gate, nothing else', () => {
    const p = planShip({ dirty: ' M src/App.tsx', unpushed: '0', unreleased: '0', headIsRelease: false, verified: true })
    expect(steps(p)).toEqual({ gate: false, bump: true, push: true, release: true })
  })

  it('THE v3.8.0 CASE: a release commit stranded by a dropped push only pushes and publishes', () => {
    const p = planShip({ dirty: '', unpushed: '1', unreleased: '1', headIsRelease: true, verified: false })
    expect(steps(p)).toEqual({ gate: false, bump: false, push: true, release: true })
  })

  it('a pushed release commit that never published only publishes', () => {
    const p = planShip({ dirty: '', unpushed: '0', unreleased: '1', headIsRelease: true, verified: false })
    expect(steps(p)).toEqual({ gate: false, bump: false, push: false, release: true })
  })

  it('commits made by hand are still gated and get a version of their own', () => {
    const p = planShip({ dirty: '', unpushed: '2', unreleased: '2', headIsRelease: false, verified: false })
    expect(steps(p)).toEqual({ gate: true, bump: true, push: true, release: true })
  })

  it('a dirty tree over a stranded release commit is new work, gated as usual', () => {
    const p = planShip({ dirty: ' M src/App.tsx', unpushed: '1', unreleased: '1', headIsRelease: true, verified: false })
    expect(steps(p)).toEqual({ gate: true, bump: true, push: true, release: true })
  })

  it('nothing to do is still nothing to do', () => {
    expect(planShip({ dirty: '', unpushed: '0', unreleased: '0', headIsRelease: true, verified: true })).toBeNull()
  })
})

// This one decides whether a window appears on his screen during a ship, so the
// boundary is worth pinning rather than eyeballing.
describe('isBigUpdate', () => {
  it('a fix on top of a release is not big', () => {
    expect(isBigUpdate('v2.0.3', '2.0.4')).toBe(false)
    expect(isBigUpdate('v2.0.9', '2.0.10')).toBe(false)
    expect(isBigUpdate('v2.17.0', '2.17.1')).toBe(false)
  })

  // Under his numbering (2026-08-19) the ORDINARY ship moves the minor by one, so
  // this is the case that must stay quiet. Pinned because the old rule answered
  // yes to it, which would have meant a window on his screen at every release.
  it('one ordinary step forward is not big', () => {
    expect(isBigUpdate('v2.17.0', '2.18.0')).toBe(false)
    expect(isBigUpdate('v2.0.4', '2.1.0')).toBe(false)
  })

  it('a jump of more than one, or any major move, is big', () => {
    expect(isBigUpdate('v2.0.18', '2.17.0')).toBe(true)
    expect(isBigUpdate('v2.17.0', '2.19.0')).toBe(true)
    expect(isBigUpdate('v2.9.9', '3.0.0')).toBe(true)
  })

  // The rollover IS the ordinary ship, so it must not open a window on his
  // screen. 2.50 is where his app actually stood when the rule arrived.
  it('the rollover to a new front number is one ordinary step, not big', () => {
    expect(isBigUpdate('v2.39.0', '3.0.0')).toBe(false)
    expect(isBigUpdate('v2.50.0', '3.0.0')).toBe(false)
    expect(isBigUpdate('v3.39.2', '4.0.0')).toBe(false)
    // A major move that is NOT the rollover is still a big thing.
    expect(isBigUpdate('v2.38.0', '3.0.0')).toBe(true)
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

// His rule, 2026-09-14: "let's say the version is 2.39, the second it hits 2.40,
// it doesn't say 2.40, and it just goes to 3.0. Okay? same with 3.40 and so on."
describe('nextVersion', () => {
  it('an ordinary ship moves the middle number', () => {
    expect(nextVersion('2.17.0', 'minor')).toBe('2.18.0')
    expect(nextVersion('2.17.3', 'minor')).toBe('2.18.0')
    expect(nextVersion('2.38.0', 'minor')).toBe('2.39.0')
  })

  it('⛔ 2.39 is followed by 3.0, never 2.40', () => {
    expect(nextVersion('2.39.0', 'minor')).toBe('3.0.0')
    expect(nextVersion('2.39.4', 'minor')).toBe('3.0.0')
    expect(nextVersion('3.39.0', 'minor')).toBe('4.0.0')
    expect(MINOR_ROLLOVER).toBe(40)
  })

  it('a version already past the line rolls over on its next ship, so 2.50 goes to 3.0', () => {
    expect(nextVersion('2.50.0', 'minor')).toBe('3.0.0')
  })

  it('a fix moves the last number only and never rolls anything', () => {
    expect(nextVersion('2.17.0', 'fix')).toBe('2.17.1')
    expect(nextVersion('2.39.9', 'fix')).toBe('2.39.10')
    expect(nextVersion('2.50.0', 'fix')).toBe('2.50.1')
  })

  it('refuses what it cannot read rather than inventing a number', () => {
    expect(() => nextVersion('banana', 'minor')).toThrow()
    expect(() => nextVersion('2.17.0', 'major')).toThrow()
  })
})
