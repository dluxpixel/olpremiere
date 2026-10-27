// The ship script is the thing that ships everything else, and on 2026-08-12 it
// lost two finished builds to one dropped packet each. Its retry is unit tested
// for the same reason `_verify` is: a step that only runs during a 25 minute
// release cannot be "checked by eye" in any useful sense.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  changedBetween,
  codeFiles,
  commitExactTree,
  enterGate,
  fastRefusal,
  flakyTests,
  GATE_TEST_TIMEOUT_MS,
  gateLanes,
  keepEvidence,
  manifestsBeyondVersion,
  manifestsMoved,
  runLogged,
  isBigUpdate,
  isDocsPath,
  isTransientFailure,
  MAY_BE_LIVE,
  mayBeLive,
  mayBeLiveReport,
  MINOR_ROLLOVER,
  nextVersion,
  planShip,
  recordFlaky,
  refusedAdds,
  refusedInPush,
  refusedUntracked,
  releaseWork,
  runLanes,
  runLoggedRetry,
  timedTestFiles,
  treeHash,
  treeWith,
  unitTestPlan,
  versionInTree,
  withEnv,
} from './lib.mjs'

// ⛔ EVERY FOLDER THIS FILE MAKES IS REMOVED WHEN IT ENDS (2026-10-08). Each run left
// eleven behind in %TEMP% (olp-gate-*, olp-evidence-*, olp-retry-*), a scratch git repo
// each, and a box that runs this on every ship and every `npm run verify` filled up
// with them: 578 were sitting there when this was found.
const made = []
/** A fresh folder under the temp directory, removed in afterAll. */
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ⛔ BACK TO THE EVENT LOOP AFTER EVERY TEST (2026-10-27). The git tests below are all
// synchronous, so the worker went from the first of them to the withEnv child process without
// once reading its messages: 30 s alone, 70.7 s in a busy full run (measured with a stall probe).
// The test runner gives up on a worker answer after 60 s, and `npm run verify` went red three
// times on "Timeout calling onTaskUpdate" with every test passing. One timer turn per test keeps
// the longest stall to one test.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)))

/**
 * A command that fails `failures` times and then succeeds, printing `message`
 * each time it fails. A real child process, because the thing being tested is
 * how this reacts to a real exit code and a real stream.
 */
function flakyCommand(failures, message) {
  const dir = scratchDir('olp-retry-')
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

/** A stream that keeps what it is given instead of printing it. */
function sink() {
  const said = []
  return { said, write: (d) => said.push(String(d)) }
}

// Silent and instant: this suite must not print a wall of banners or spend
// real seconds sleeping between attempts. ⛔ It used to print "package failed on
// what looks like a dropped connection" into every ship log, a false lead for
// anyone reading a red gate.
const quiet = () => ({ tries: 3, baseDelayMs: 0, out: sink(), err: sink() })
const QUIET = quiet()

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
    await expect(runLoggedRetry(cmd, 'package', null, QUIET)).resolves.toBeTypeOf('number')
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
  const dir = scratchDir('olp-publish-')
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

/**
 * A real git repo in a temp folder, with one commit: a.txt, b.txt, package.json.
 * Real git, because what is being proven is what git ends up committing.
 */
function scratchRepo() {
  const dir = scratchDir('olp-gate-')
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'gate@test.invalid')
  git('config', 'user.name', 'gate test')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a1')
  writeFileSync(join(dir, 'b.txt'), 'b1')
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}')
  git('add', '-A')
  git('commit', '-q', '-m', 'start')
  const write = (name, text) => writeFileSync(join(dir, name), text)
  return { dir, git, write }
}

// ⛔ 2026-10-06: the gate hashed the tree BEFORE a 25 minute run and committed
// with `git add -A` AFTER it, so a file saved mid-gate shipped as gated.
describe('the release commit is exactly the gated tree', { timeout: 30_000 }, () => {
  it('a save after the gate stays out of the commit and is left uncommitted', () => {
    const { dir, git, write } = scratchRepo()
    const head = git('rev-parse', 'HEAD')
    write('a.txt', 'a2 gated')
    const gated = treeHash(dir)

    // Somebody saves while the gate runs, then the version is bumped.
    write('b.txt', 'b2 saved during the gate')
    write('new.txt', 'a new file nobody checked')
    write('package.json', '{"version":"1.1.0"}')

    const tree = treeWith(gated, ['package.json', 'package-lock.json'], dir)
    commitExactTree(tree, 'release\n\nbody\n', { parent: head, cwd: dir })

    expect(git('show', 'HEAD:a.txt')).toBe('a2 gated')
    expect(git('show', 'HEAD:b.txt')).toBe('b1')
    expect(git('show', 'HEAD:package.json')).toBe('{"version":"1.1.0"}')
    expect(() => git('show', 'HEAD:new.txt')).toThrow()
    expect(git('log', '-1', '--format=%B')).toBe('release\n\nbody')
    // The index matches the new commit; the ungated work is still on disk.
    expect(git('status', '--porcelain').split('\n').map((l) => l.trim()).sort()).toEqual(['?? new.txt', 'M b.txt'])
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b2 saved during the gate')
  })

  it('the tree hash moves when a file is saved, and names it', () => {
    const { dir, write } = scratchRepo()
    const before = treeHash(dir)
    expect(treeHash(dir)).toBe(before)
    write('b.txt', 'b2')
    mkdirSync(join(dir, 'src'))
    write('src/x.ts', 'x')
    const after = treeHash(dir)
    expect(after).not.toBe(before)
    expect(changedBetween(before, after, dir)).toEqual(['b.txt', 'src/x.ts'])
  })

  it('the hash leaves the real index alone', () => {
    const { dir, git, write } = scratchRepo()
    write('b.txt', 'b2')
    treeHash(dir)
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })

  it('refuses, and moves nothing, if the branch moved while the gate ran', () => {
    const { dir, git, write } = scratchRepo()
    const head = git('rev-parse', 'HEAD')
    write('a.txt', 'a2')
    const gated = treeHash(dir)
    git('commit', '-q', '-am', 'somebody else committed meanwhile')
    const theirs = git('rev-parse', 'HEAD')
    expect(() => commitExactTree(gated, 'release', { parent: head, cwd: dir })).toThrow()
    expect(git('rev-parse', 'HEAD')).toBe(theirs)
  })
})

// ⛔ THE RELEASE TOOK HIS PROJECT FILES AND HIS MEDIA FOLDER (2026-10-25). `treeHash` adds every
// new file nothing ignores, and the commit took the tree as gated: three `.olstudio` files and a
// media folder, 4.3 GB, and the push hung packing. New files are normal in a release (fonts,
// sources, sounds), so only his project files and anything of 50 MB or more are refused.
const LIMIT = 50 * 1024 * 1024
const names = (list) => list.map((r) => r.path).sort()
/** A file of exactly `bytes`, made by extending an empty one, so a big one costs nothing to write. */
function sparse(dir, name, bytes) {
  const file = join(dir, name)
  writeFileSync(file, '')
  truncateSync(file, bytes)
}

describe('a release refuses his project files and files of 50 MB or more', { timeout: 60_000 }, () => {
  it('refuses a new .olstudio file, in any folder and in any case', () => {
    const { dir, write } = scratchRepo()
    write('My Edit - 44 clips.olstudio', 'abcd')
    mkdirSync(join(dir, 'old projects'))
    write('old projects/Take Two.OLStudio', 'x')
    write('notes.txt', 'not a project')
    const tree = treeHash(dir)
    const refused = refusedAdds(tree, 'HEAD', dir)
    expect(names(refused)).toEqual(['My Edit - 44 clips.olstudio', 'old projects/Take Two.OLStudio'])
    expect(refused.map((r) => r.bytes).sort()).toEqual([1, 4])
    for (const r of refused) expect(r.why).toBe('his project file')
    // A tree or a commit both work as the base.
    expect(refusedAdds(tree, 'HEAD^{tree}', dir)).toEqual(refused)
  })

  it('refuses a new file of 50 MB or more, and lets one byte less through', () => {
    const { dir, write } = scratchRepo()
    write('over.bin', Buffer.alloc(LIMIT + 1))
    write('exactly.bin', Buffer.alloc(LIMIT))
    write('under.bin', Buffer.alloc(LIMIT - 1))
    const refused = refusedAdds(treeHash(dir), 'HEAD', dir)
    expect(names(refused)).toEqual(['exactly.bin', 'over.bin'])
    expect(refused.find((r) => r.path === 'over.bin').bytes).toBe(LIMIT + 1)
    expect(refused.find((r) => r.path === 'over.bin').why).toMatch(/100 MB/)
  })

  it('lets a small new source file through, and a change to a small one', () => {
    const { dir, write } = scratchRepo()
    mkdirSync(join(dir, 'src'))
    write('src/new file.ts', 'export const x = 1')
    write('a.txt', 'a2')
    expect(refusedAdds(treeHash(dir), 'HEAD', dir)).toEqual([])
  })

  it('does not refuse a big file that is already in base and unchanged, but does once it changes', () => {
    const { dir, git, write } = scratchRepo()
    write('already.bin', Buffer.alloc(LIMIT + 1))
    git('add', '-A')
    git('commit', '-q', '-m', 'a big file that was already there')
    write('small.txt', 'new and small')
    expect(refusedAdds(treeHash(dir), 'HEAD', dir)).toEqual([])
    write('already.bin', Buffer.alloc(LIMIT + 2))
    expect(names(refusedAdds(treeHash(dir), 'HEAD', dir))).toEqual(['already.bin'])
  })

  it('returns the exact path of a project file with a non-ASCII name', () => {
    const { dir, write } = scratchRepo()
    write('é-日本 project.olstudio', 'abcd')
    write('é-日本 notes.txt', 'not a project')
    const refused = refusedAdds(treeHash(dir), 'HEAD', dir)
    expect(refused.map((r) => r.path)).toEqual(['é-日本 project.olstudio'])
    expect(refused[0].why).toBe('his project file')
  })

  it('counts a big file already in base that is moved as an add, and refuses it', () => {
    const { dir, git } = scratchRepo()
    sparse(dir, 'already.bin', LIMIT + 1)
    git('add', '-A')
    git('commit', '-q', '-m', 'a big file that was already there')
    git('mv', 'already.bin', 'moved.bin')
    // Porcelain status calls this a rename. Plumbing diff-tree never pairs renames unless given -M,
    // so the moved file shows as an add and is judged like any new file; --no-renames only makes
    // that explicit.
    expect(git('status', '--porcelain')).toMatch(/^R {2}already\.bin -> moved\.bin$/)
    expect(names(refusedAdds(treeHash(dir), 'HEAD', dir))).toEqual(['moved.bin'])
  })

  it('refuses a symlink replaced by a regular file of 50 MB or more (a type change)', () => {
    const { dir, git } = scratchRepo()
    const tree = (input) => execFileSync('git', ['mktree'], { cwd: dir, input, encoding: 'utf8', windowsHide: true }).trim()
    // Trees built by hand, because a Windows box without symlinks cannot make the link.
    writeFileSync(join(dir, 'target.txt'), 'a.txt')
    const linkBlob = git('hash-object', '-w', 'target.txt')
    sparse(dir, 'big.bin', LIMIT)
    const bigBlob = git('hash-object', '-w', 'big.bin')
    const base = tree(`120000 blob ${linkBlob}\tlink\n`)
    const next = tree(`100644 blob ${bigBlob}\tlink\n`)
    // Git calls this T, which `--diff-filter=AM` drops.
    expect(git('diff-tree', '-r', '--no-renames', base, next)).toMatch(/ T\tlink$/)
    expect(git('diff-tree', '-r', '--no-renames', '--diff-filter=AM', base, next)).toBe('')
    expect(names(refusedAdds(next, base, dir))).toEqual(['link'])
    // A small regular file in its place is fine.
    const small = tree(`100644 blob ${git('hash-object', '-w', 'target.txt')}\tlink\n`)
    expect(refusedAdds(small, base, dir)).toEqual([])
  })

  it('weighs a tree of 9000 new small files without running out of buffer', () => {
    const { dir, git } = scratchRepo()
    // Built with mktree, so no file is on disk: 9000 names for one small blob, long enough that
    // the diff runs past the 1 MB default buffer, which threw `spawnSync git ENOBUFS`.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'small', encoding: 'utf8', windowsHide: true }).trim()
    const entries = Array.from({ length: 9000 }, (_, i) => `100644 blob ${blob}\ta-long-name-so-the-list-runs-past-one-megabyte-${String(i).padStart(5, '0')}.txt\n`)
    const tree = execFileSync('git', ['mktree'], { cwd: dir, input: entries.join(''), encoding: 'utf8', windowsHide: true }).trim()
    expect(git('ls-tree', tree).split('\n')).toHaveLength(9000)
    expect(refusedAdds(tree, 'HEAD', dir)).toEqual([])
  })

  it('allows deleting a big file that is committed', () => {
    const { dir, git } = scratchRepo()
    sparse(dir, 'already.bin', LIMIT + 1)
    git('add', '-A')
    git('commit', '-q', '-m', 'a big file that was already there')
    rmSync(join(dir, 'already.bin'))
    expect(refusedAdds(treeHash(dir), 'HEAD', dir)).toEqual([])
  })
})

// ⛔ THE PUSH WAS THE ONE THING NOTHING CHECKED (2026-10-25). A commit that already exists under HEAD
// (the undone release commit put back, a reset to it, a push-only retry) never meets the checks that
// run before a commit is made, and the push sends every commit and every file in it, so one that a
// later commit deleted again is still sent. The range is read from git's own object list.
describe('a push refuses his project files and files of 50 MB or more in the commits it sends', { timeout: 60_000 }, () => {
  it('refuses a big file and a project file that a middle commit added and a later commit deleted', () => {
    const { dir, git, write } = scratchRepo()
    const pushed = git('rev-parse', 'HEAD')
    write('small1.txt', 'one')
    git('add', '-A')
    git('commit', '-q', '-m', 'small')
    sparse(dir, 'media.bin', LIMIT + 1)
    write('é-日本 project.olstudio', 'abcd')
    git('add', '-A')
    git('commit', '-q', '-m', 'the middle commit takes the big file and the project file')
    git('rm', '-q', 'media.bin', 'é-日本 project.olstudio')
    git('commit', '-q', '-m', 'and the next one removes them again')
    // Gone from the tree at HEAD, still in the commits the push would send.
    expect(git('ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/media\.bin|olstudio/)
    const refused = refusedInPush(`${pushed}..HEAD`, dir)
    expect(names(refused)).toEqual(['media.bin', 'é-日本 project.olstudio'])
    expect(refused.find((r) => r.path === 'media.bin')).toMatchObject({ bytes: LIMIT + 1 })
    expect(refused.find((r) => r.path === 'media.bin').why).toMatch(/100 MB/)
    expect(refused.find((r) => r.path.endsWith('.olstudio')).why).toBe('his project file')
    // With nothing to compare against, the whole history is the range.
    expect(names(refusedInPush('HEAD', dir))).toEqual(['media.bin', 'é-日本 project.olstudio'])
    // What an earlier push already sent is not looked at again.
    expect(refusedInPush('HEAD~1..HEAD', dir)).toEqual([])
  })

  it('returns nothing for a range of small commits', () => {
    const { dir, git, write } = scratchRepo()
    const pushed = git('rev-parse', 'HEAD')
    mkdirSync(join(dir, 'src'))
    write('src/new file.ts', 'export const x = 1')
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    write('a.txt', 'a2')
    sparse(dir, 'just-under.bin', LIMIT - 1)
    git('commit', '-q', '-am', 'two')
    git('add', '-A')
    git('commit', '-q', '-m', 'three, a file one byte under the limit')
    expect(refusedInPush(`${pushed}..HEAD`, dir)).toEqual([])
    // Nothing to send at all.
    expect(refusedInPush('HEAD..HEAD', dir)).toEqual([])
  })

  it('looks at main, which the push sends, even with HEAD detached at the pushed commit', () => {
    const { dir, git } = scratchRepo()
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    sparse(dir, 'media.bin', LIMIT + 1)
    git('add', '-A')
    git('commit', '-q', '-m', 'main is one commit ahead with a big file')
    git('checkout', '-q', '--detach', 'origin/main')
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'origin/main'))
    // The old range, against HEAD, sees nothing to send.
    expect(refusedInPush('origin/main..HEAD', dir)).toEqual([])
    // The range against main refuses what `git push origin main` would send.
    expect(names(refusedInPush('origin/main..refs/heads/main', dir))).toEqual(['media.bin'])
    // And so does the fallback with no remote branch.
    expect(names(refusedInPush('refs/heads/main', dir))).toEqual(['media.bin'])
  })
})

// ⛔ THE CHECK ON THE TREE CAME AFTER `git add -A` (2026-10-25), which reads every new file and writes
// it into .git/objects first: minutes and gigabytes for a 1.4 GB project file. The new files are
// looked at before that, by name and by size on disk.
describe('new files are refused before anything is hashed', { timeout: 60_000 }, () => {
  it('refuses an untracked .olstudio and an untracked file of 50 MB or more, and nothing else', () => {
    const { dir, write } = scratchRepo()
    write('.gitignore', 'ignored.bin\n')
    write('My Edit.olstudio', 'abcd')
    mkdirSync(join(dir, 'old projects'))
    write('old projects/Take Two.OLStudio', 'x')
    sparse(dir, 'over.bin', LIMIT)
    sparse(dir, 'under.bin', LIMIT - 1)
    sparse(dir, 'ignored.bin', LIMIT * 2)
    write('small.txt', 'a small new file')
    const refused = refusedUntracked(dir)
    expect(names(refused)).toEqual(['My Edit.olstudio', 'old projects/Take Two.OLStudio', 'over.bin'])
    expect(refused.find((r) => r.path === 'over.bin')).toMatchObject({ bytes: LIMIT })
    expect(refused.find((r) => r.path === 'over.bin').why).toMatch(/100 MB/)
    expect(refused.find((r) => r.path === 'My Edit.olstudio')).toMatchObject({ bytes: 4, why: 'his project file' })
  })

  it('returns the exact path of a project file with a non-ASCII name', () => {
    const { dir, write } = scratchRepo()
    write('é-日本 project.olstudio', 'abcd')
    expect(refusedUntracked(dir).map((r) => r.path)).toEqual(['é-日本 project.olstudio'])
  })

  it('lets through a repo with only small new files, an ignored big file, and a tracked big file', () => {
    const { dir, git, write } = scratchRepo()
    sparse(dir, 'tracked.bin', LIMIT + 1)
    git('add', '-A')
    git('commit', '-q', '-m', 'a big file that was already there')
    write('.gitignore', '*.olstudio\n/OLP-MEDIA/\n')
    write('Mine.olstudio', 'ignored by name')
    mkdirSync(join(dir, 'OLP-MEDIA'))
    sparse(dir, 'OLP-MEDIA/clip.mp4', LIMIT * 2)
    write('small.txt', 'new and small')
    expect(refusedUntracked(dir)).toEqual([])
  })

  it('refuses a small project file whose name starts with a space', () => {
    const { dir, write } = scratchRepo()
    // Sorted first, so a trimmed listing lost its space and the name no longer existed on disk.
    write(' lead.olstudio', 'abcd')
    write('small.txt', 'a small new file')
    expect(refusedUntracked(dir)).toEqual([{ path: ' lead.olstudio', bytes: 4, why: 'his project file' }])
  })

  // A symlink is judged by its own name, never by the size of what it points at.
  const canSymlink = (() => {
    const probe = scratchDir('olp-link-')
    try {
      writeFileSync(join(probe, 'target'), '')
      symlinkSync('target', join(probe, 'link'), 'file')
      return true
    } catch (e) {
      if (e.code === 'EPERM') return false
      throw e
    }
  })()
  it.skipIf(!canSymlink)(
    `judges an untracked symlink by its name, not by its target's size${canSymlink ? '' : ' (skipped: symlinkSync throws EPERM on this box, it needs Developer Mode or admin)'}`,
    () => {
      const { dir, write } = scratchRepo()
      write('.gitignore', 'big-target.bin\n')
      sparse(dir, 'big-target.bin', LIMIT + 1)
      write('small.txt', 'a small new file')
      symlinkSync('big-target.bin', join(dir, 'link.bin'), 'file')
      symlinkSync('small.txt', join(dir, 'linked.olstudio'), 'file')
      expect(refusedUntracked(dir)).toEqual([{ path: 'linked.olstudio', bytes: 0, why: 'his project file' }])
    },
  )

  it('writes nothing into .git/objects', () => {
    const { dir, git, write } = scratchRepo()
    sparse(dir, 'over.bin', LIMIT + 1)
    write('small.txt', 'new and small')
    const before = git('count-objects', '-v')
    expect(names(refusedUntracked(dir))).toEqual(['over.bin'])
    expect(git('count-objects', '-v')).toBe(before)
  })
})

// ⛔ `--fast` ("docs only") shipped four feature releases with no browser test.
describe('the --fast contract', () => {
  it('lets Markdown and docs/ through', () => {
    for (const p of ['README.md', 'docs/notes.txt', 'docs/img/a.png', 'e2e/NOTES.MD']) expect(isDocsPath(p), p).toBe(true)
    expect(codeFiles(['README.md', 'docs/a.txt'])).toEqual([])
  })

  it('names every code file in a release, which is a refusal', () => {
    expect(codeFiles(['README.md', 'src/App.tsx', 'package.json', 'scripts/patch.mjs', 'mydocs/a.ts'])).toEqual([
      'src/App.tsx',
      'package.json',
      'scripts/patch.mjs',
      'mydocs/a.ts',
    ])
  })
})

// ⛔ `--fast` HASHED THE TREE FOR ITS DOCS ONLY CHECK AND THE GATE HASHED IT AGAIN (2026-10-08).
// A code file saved between the two was never seen by the check and then became the gate's
// own baseline, so it shipped marked "docs only". The check now judges the tree it is
// handed, which is the one tree taken at the start of the run.
describe('the --fast check judges the one tree it is given', { timeout: 30_000 }, () => {
  it('a code file saved after the tree was taken does not change the verdict on that tree', () => {
    const { dir, git, write } = scratchRepo()
    git('tag', 'v1.0.0')
    write('NOTES.md', 'docs')
    const tree = treeHash(dir)
    expect(fastRefusal('v1.0.0', tree, dir)).toEqual([])

    // Saved between the check and the gate.
    mkdirSync(join(dir, 'src'))
    write('src/x.ts', 'x')
    expect(fastRefusal('v1.0.0', tree, dir)).toEqual([])
    // A tree taken now carries it, which is what the gate's check at its end compares.
    const later = treeHash(dir)
    expect(fastRefusal('v1.0.0', later, dir)).toEqual(['src/x.ts'])
    expect(changedBetween(tree, later, dir)).toEqual(['src/x.ts'])
  })

  it('names every code file in the tree it is given', () => {
    const { dir, git, write } = scratchRepo()
    git('tag', 'v1.0.0')
    write('a.txt', 'a2')
    write('README.md', 'docs')
    expect(fastRefusal('v1.0.0', treeHash(dir), dir)).toEqual(['a.txt'])
  })

  it('with no release tag to compare against, nothing is docs only', () => {
    const { dir } = scratchRepo()
    expect(fastRefusal('', treeHash(dir), dir)).toEqual(['(no release tag to compare against)'])
  })
})

// ⛔ THE VERSION BUMP READ package.json AND package-lock.json FROM DISK, AFTER THE GATE
// (2026-10-08). The gate's check at its end was already behind it, `npm version` rewrote
// both files on disk and the release commit took both from disk, so a dependency added in
// that window shipped with no check having seen it.
describe('the version bump is built from the gated manifests', { timeout: 30_000 }, () => {
  const pkg = (version, extra = {}) =>
    JSON.stringify({ name: 'olp', version, dependencies: { a: '1.0.0', ...extra } }, null, 2) + '\n'
  const lock = (version, extra = {}) =>
    JSON.stringify({ name: 'olp', version, lockfileVersion: 3, packages: { '': { name: 'olp', version }, ...extra } }, null, 2) + '\n'
  /** A repo whose gated tree holds both manifests at 1.0.0. */
  const gatedRepo = () => {
    const r = scratchRepo()
    r.write('package.json', pkg('1.0.0'))
    r.write('package-lock.json', lock('1.0.0'))
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'manifests')
    return { ...r, gated: treeHash(r.dir) }
  }

  it('lets the bump start when both files are what the gate checked', () => {
    const { dir, gated } = gatedRepo()
    expect(manifestsMoved(gated, dir)).toEqual([])
  })

  it('refuses when package.json, the lock, or both changed after the gate', () => {
    const { dir, write, gated } = gatedRepo()
    write('package.json', pkg('1.0.0', { sneaked: '9.9.9' }))
    expect(manifestsMoved(gated, dir)).toEqual(['package.json'])
    write('package-lock.json', lock('1.0.0', { 'node_modules/sneaked': { version: '9.9.9' } }))
    expect(manifestsMoved(gated, dir)).toEqual(['package-lock.json', 'package.json'])
  })

  it('refuses a lock that was deleted, and ignores a change to any other file', () => {
    const { dir, write, gated } = gatedRepo()
    write('a.txt', 'a changed, not a manifest')
    expect(manifestsMoved(gated, dir)).toEqual([])
    rmSync(join(dir, 'package-lock.json'))
    expect(manifestsMoved(gated, dir)).toEqual(['package-lock.json'])
  })

  it('reads the version it bumps from the gated tree, whatever is on disk now', () => {
    const { dir, write, gated } = gatedRepo()
    write('package.json', pkg('9.9.9'))
    expect(versionInTree(gated, dir)).toBe('1.0.0')
  })

  it('accepts the files `npm version` writes: the version fields and nothing else', () => {
    const { dir, write, gated } = gatedRepo()
    write('package.json', pkg('1.1.0'))
    write('package-lock.json', lock('1.1.0'))
    expect(manifestsBeyondVersion(gated, '1.1.0', dir)).toEqual([])
    // Another spelling of the same document is the same document.
    write('package.json', JSON.stringify({ dependencies: { a: '1.0.0' }, version: '1.1.0', name: 'olp' }))
    expect(manifestsBeyondVersion(gated, '1.1.0', dir)).toEqual([])
  })

  it('refuses a change that rode in with the bump, in either file', () => {
    const { dir, write, gated } = gatedRepo()
    write('package.json', pkg('1.1.0', { sneaked: '9.9.9' }))
    write('package-lock.json', lock('1.1.0'))
    expect(manifestsBeyondVersion(gated, '1.1.0', dir)).toEqual(['package.json'])
    write('package.json', pkg('1.1.0'))
    write('package-lock.json', lock('1.1.0', { 'node_modules/sneaked': { version: '9.9.9' } }))
    expect(manifestsBeyondVersion(gated, '1.1.0', dir)).toEqual(['package-lock.json'])
  })

  it('refuses files that do not carry the version the bump chose, or that cannot be read', () => {
    const { dir, write, gated } = gatedRepo()
    write('package.json', pkg('1.2.0'))
    write('package-lock.json', lock('1.1.0'))
    expect(manifestsBeyondVersion(gated, '1.1.0', dir)).toEqual(['package.json'])
    write('package.json', 'not json at all')
    expect(manifestsBeyondVersion(gated, '1.1.0', dir)).toEqual(['package.json'])
  })
})

// ⛔ OLP_MEASURE SET IN A POWERSHELL WINDOW STAYS THERE (2026-10-08), and a plain
// `npm run patch` in that window put scrub-cost, 3 to 10 minutes on his own 1.38 GB
// project, back into the gate.
describe('the gate clears what must not reach it', () => {
  it('marks the process as inside the gate and removes OLP_MEASURE', () => {
    const env = { OLP_MEASURE: '1', PATH: 'a-path', OLP_OTHER: 'kept' }
    enterGate(env)
    expect(env.OLP_GATE).toBe('1')
    expect('OLP_MEASURE' in env).toBe(false)
    expect(env.PATH).toBe('a-path')
    expect(env.OLP_OTHER).toBe('kept')
  })

  it('is fine when OLP_MEASURE was never set', () => {
    const env = {}
    enterGate(env)
    expect(env).toEqual({ OLP_GATE: '1' })
  })

  // 2026-10-12: left over in a window, it would leave the full gate with no smoke or ui project.
  it('removes OLP_RELEASE, which the release gate sets for its own browser step only', () => {
    const env = { OLP_RELEASE: '1', OLP_MEASURE: '1', OLP_OTHER: 'kept' }
    enterGate(env)
    expect(env).toEqual({ OLP_GATE: '1', OLP_OTHER: 'kept' })
  })
})

describe('withEnv', () => {
  it('sets the variable for the call and puts a previous value back after', async () => {
    const env = { OLP_RELEASE: 'before' }
    const seen = await withEnv('OLP_RELEASE', '1', () => env.OLP_RELEASE, env)
    expect(seen).toBe('1')
    expect(env.OLP_RELEASE).toBe('before')
  })

  it('a variable that was not set is not set afterwards', async () => {
    const env = {}
    await withEnv('OLP_RELEASE', '1', () => expect(env.OLP_RELEASE).toBe('1'), env)
    expect('OLP_RELEASE' in env).toBe(false)
  })

  it('puts it back when the call throws, and the error still gets out', async () => {
    const env = { OLP_RELEASE: 'before' }
    await expect(
      withEnv(
        'OLP_RELEASE',
        '1',
        () => {
          throw new Error('red')
        },
        env,
      ),
    ).rejects.toThrow('red')
    expect(env.OLP_RELEASE).toBe('before')
  })

  it('a child started inside it sees the variable, and one started after does not', async () => {
    const child = 'node -e "console.log(\'release=\' + (process.env.OLP_RELEASE ?? \'unset\'))"'
    const outer = process.env.OLP_RELEASE
    delete process.env.OLP_RELEASE
    try {
      const inside = sink()
      await withEnv('OLP_RELEASE', '1', () => runLogged(child, 'inside', null, { out: inside, err: sink() }))
      const after = sink()
      await runLogged(child, 'after', null, { out: after, err: sink() })
      expect(inside.said.join('')).toContain('release=1')
      expect(after.said.join('')).toContain('release=unset')
    } finally {
      if (outer !== undefined) process.env.OLP_RELEASE = outer
    }
  })
})

// 2026-10-12, his word: "make a system for when we do release new updates. It doesn't take half as
// long." The no-browser checks were seven steps one after another for 212 s. They run as lanes at
// once now, and these are real child processes because what matters is how the lanes react to real
// exit codes and real streams.
describe('runLanes', { timeout: 60_000 }, () => {
  /**
   * The helper scripts. `meet` writes its own flag, then waits for the other's: it only ever exits 0
   * when the two are RUNNING AT THE SAME TIME, so lanes run one after another cannot pass it.
   */
  const helpers = () => {
    const dir = scratchDir('olp-lanes-')
    const write = (name, lines) => {
      const file = join(dir, name)
      writeFileSync(file, lines.join('\n'))
      return file
    }
    const wait = [
      `import { existsSync } from 'node:fs'`,
      `export const until = async (file, ms = 20000) => {`,
      `  const t0 = Date.now()`,
      `  while (!existsSync(file)) {`,
      `    if (Date.now() - t0 > ms) { console.error('never appeared: ' + file); process.exit(1) }`,
      `    await new Promise((r) => setTimeout(r, 20))`,
      `  }`,
      `}`,
    ]
    write('wait.mjs', wait)
    const meet = write('meet.mjs', [
      `import { writeFileSync } from 'node:fs'`,
      `import { until } from './wait.mjs'`,
      `const [mine, theirs] = process.argv.slice(2)`,
      `writeFileSync(mine, 'here')`,
      `await until(theirs)`,
      `console.log('met')`,
    ])
    // Appends a mark to a file, then exits with a code.
    const mark = write('mark.mjs', [
      `import { appendFileSync } from 'node:fs'`,
      `const [file, text, code] = process.argv.slice(2)`,
      `appendFileSync(file, text)`,
      `process.exit(Number(code))`,
    ])
    // Waits for a file, lingers, then exits with a code.
    const lateExit = write('late-exit.mjs', [
      `import { until } from './wait.mjs'`,
      `const [file, code] = process.argv.slice(2)`,
      `await until(file)`,
      `await new Promise((r) => setTimeout(r, 150))`,
      `process.exit(Number(code))`,
    ])
    // Meets the other chatty lane, then prints lines on both streams, slowly, then lingers.
    const chatty = write('chatty.mjs', [
      `import { writeFileSync } from 'node:fs'`,
      `import { until } from './wait.mjs'`,
      `const [name, mine, theirs, lines, linger] = process.argv.slice(2)`,
      `writeFileSync(mine, 'here')`,
      `await until(theirs)`,
      `for (let k = 0; k < Number(lines); k++) {`,
      `  (k % 2 ? console.error : console.log)(name + ' line ' + k)`,
      `  await new Promise((r) => setTimeout(r, 30))`,
      `}`,
      `await new Promise((r) => setTimeout(r, Number(linger)))`,
    ])
    const f = (name) => join(dir, name)
    return {
      dir,
      f,
      meet: (mine, theirs) => `node "${meet}" "${f(mine)}" "${f(theirs)}"`,
      mark: (file, text, code) => `node "${mark}" "${f(file)}" ${text} ${code}`,
      lateExit: (file, code) => `node "${lateExit}" "${f(file)}" ${code}`,
      chatty: (name, mine, theirs, lines, linger) => `node "${chatty}" ${name} "${f(mine)}" "${f(theirs)}" ${lines} ${linger}`,
    }
  }

  it('runs the lanes at the same time', async () => {
    const h = helpers()
    // Each side only finishes once it has seen the other start. One after another, the first
    // would wait for a lane that never starts, give up after 20 s and fail.
    const r = await runLanes([[[h.meet('a', 'b'), 'lane a']], [[h.meet('b', 'a'), 'lane b']]], null, { out: sink() })
    expect(r.ok).toBe(true)
    expect(r.failed).toBeNull()
    expect(r.lanes.map((l) => l.failed)).toEqual([null, null])
  })

  it('runs the steps of a lane in order, and a red step ends its lane', async () => {
    const h = helpers()
    const trail = h.f('trail')
    const out = sink()
    const r = await runLanes([[[h.mark('trail', 'a', 0), 'step a'], [h.mark('trail', 'b', 2), 'step b'], [h.mark('trail', 'c', 0), 'step c']]], null, { out })
    expect(readFileSync(trail, 'utf8')).toBe('ab')
    expect(r.ok).toBe(false)
    expect(r.failed).toBe('step b')
    const said = out.said.join('')
    expect(said).toMatch(/✓ step a \(\d+ s\)/)
    expect(said).toMatch(/✗ step b exited 2 after \d+ s/)
    expect(said).not.toContain('step c')
  })

  it('a red lane does not stop the others, and the first red step in LANE ORDER is named', async () => {
    const h = helpers()
    const r = await runLanes(
      [
        // Lane 1 is red too, but only after lane 2 has already failed: it finishes last.
        [[h.lateExit('fast-red-ran', 1), 'slow red']],
        [[h.mark('fast-red-ran', 'x', 1), 'fast red']],
        [[h.mark('green-trail', 'a', 0), 'green a'], [h.mark('green-trail', 'b', 0), 'green b']],
      ],
      null,
      { out: sink() },
    )
    expect(r.ok).toBe(false)
    expect(r.failed).toBe('slow red')
    expect(r.lanes.map((l) => l.failed)).toEqual(['slow red', 'fast red', null])
    expect(readFileSync(h.f('green-trail'), 'utf8')).toBe('ab')
  })

  it('writes each lane as ONE block when it ends, never interleaved, to the screen and the log', async () => {
    const h = helpers()
    const out = sink()
    const log = sink()
    // Both talk at the same time on both streams. beta stops first; alpha lingers.
    const r = await runLanes(
      [
        [[h.chatty('alpha', 'al', 'be', 6, 1500), 'alpha step']],
        [[h.chatty('beta', 'be', 'al', 6, 0), 'beta step']],
      ],
      log,
      { out },
    )
    expect(r.ok).toBe(true)
    expect(out.said).toHaveLength(2)
    const [first, second] = out.said
    // The lane that ended first is written first.
    expect(first).toContain('beta step')
    expect(second).toContain('alpha step')
    for (const [block, own, other] of [
      [first, 'beta', 'alpha'],
      [second, 'alpha', 'beta'],
    ]) {
      for (let k = 0; k < 6; k++) expect(block).toContain(`${own} line ${k}`)
      expect(block).not.toContain(other)
      expect(block).toMatch(new RegExp(`▶ ${own} step`))
      expect(block).toMatch(new RegExp(`✓ ${own} step \\(\\d+ s\\)`))
    }
    // The ship log gets the same two blocks.
    expect(log.said).toEqual(out.said)
    expect(r.lanes.map((l) => l.output)).toEqual([second, first])
  })

  it('a lane that fails writes its red line into its block and the log', async () => {
    const h = helpers()
    const log = sink()
    const r = await runLanes([[[h.mark('t', 'a', 3), 'red lane']]], log, { out: sink() })
    expect(r.failed).toBe('red lane')
    expect(log.said.join('')).toMatch(/✗ red lane exited 3 after \d+ s/)
  })
})

// 2026-10-12: the first real release gate failed 4 of 426 unit test files, all of them tests that pass
// alone. Two ran past vitest's 5 s limit and two failed a budget they read off the clock. The gate now
// gives every test 30 s and runs the clock files alone, on a quiet box, after the parallel lanes.
//
// The fixture lines below each start with a quote on purpose: timedTestFiles skips a line that is only
// a string, or this very file would be found as a clock test and run alone (12 s of every ship).
describe('the unit tests inside the parallel gate', () => {
  /** A repo shaped like this one, with a file for each way a test can or cannot read the clock. */
  const fixtureRoot = () => {
    const root = scratchDir('olp-clock-')
    const put = (rel, lines) => {
      const file = join(root, rel)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, lines.join('\n'))
    }
    put('src/ratio.test.ts', [
      "import { benchRatio } from './perfRatio'",
      'it("is quick", () => { benchRatio(() => 1, 1, 5) })',
    ])
    put('src/stopwatch.test.tsx', [
      'const t0 = performance.now()',
      'const ms = performance.now() - t0',
    ])
    put('electron/wall.test.ts', [
      'const t0 = Date.now()',
      'expect(Date.now() - t0).toBeLessThan(3000)',
    ])
    put('scripts/helper-user.test.mjs', [
      "import { x } from '../src/engine/perfRatio'",
    ])
    // Reads the clock but never subtracts two reads: not a budget.
    put('src/quiet.test.ts', [
      'const stamp = Date.now() + 5',
      'const old = new Date(Date.now() - 400 * DAY)',
    ])
    // Writes a script that has a stopwatch in it, the way lib.test.mjs does: a string, not a read.
    put('src/writer.test.ts', [
      'write([',
      "  `if (Date.now() - t0 > ms) { process.exit(1) }`,",
      "  'benchRatio(() => 1)',",
      '])',
    ])
    // Not tests, not where vitest looks, or someone else's.
    put('src/ratio.ts', [
      'export function benchRatio() {}',
      'const ms = performance.now() - t0',
    ])
    put('src/node_modules/dep/dep.test.ts', [
      'benchRatio(() => 1)',
    ])
    put('_verify/wrong-extension.test.ts', [
      'benchRatio(() => 1)',
    ])
    return root
  }

  it('finds the test files that assert on a clock, sorted, and only those', () => {
    expect(timedTestFiles(fixtureRoot())).toEqual([
      'electron/wall.test.ts',
      'scripts/helper-user.test.mjs',
      'src/ratio.test.ts',
      'src/stopwatch.test.tsx',
    ])
  })

  it('finds the clock tests this repo has today, and not the test that only writes one', () => {
    const found = timedTestFiles(fileURLToPath(new URL('..', import.meta.url)))
    for (const f of [
      'src/engine/captions/scriptAlign.test.ts',
      'src/engine/timeline.test.ts',
      'src/engine/perfGuard.test.ts',
      'src/state/captionActions.test.ts',
      'src/state/clipboardPair.test.ts',
    ]) {
      expect(found, f).toContain(f)
    }
    expect(found).not.toContain('scripts/lib.test.mjs')
  })

  it('gives every test and hook 30 s in the gate, on the lane and on the clock files alike', () => {
    expect(GATE_TEST_TIMEOUT_MS).toBe(30_000)
    const plan = unitTestPlan({ files: ['src/a.test.ts', 'src/b.test.ts'] })
    for (const cmd of [plan.main, plan.alone]) {
      expect(cmd).toMatch(/^npx vitest run /)
      expect(cmd).toContain(`--testTimeout=${GATE_TEST_TIMEOUT_MS}`)
      expect(cmd).toContain(`--hookTimeout=${GATE_TEST_TIMEOUT_MS}`)
    }
  })

  it('takes the clock files out of the lane and runs exactly those alone', () => {
    const files = ['electron/wall.test.ts', 'src/ratio.test.ts']
    const plan = unitTestPlan({ files })
    expect(plan.main.match(/--exclude \S+/g)).toEqual(files.map((f) => `--exclude ${f}`))
    expect(plan.alone.split(' ').filter((w) => w.endsWith('.test.ts'))).toEqual(files)
    expect(plan.alone).not.toContain('--exclude')
  })

  it('has no alone step when no test asserts on a clock, and the lane then excludes nothing', () => {
    const plan = unitTestPlan({ files: [] })
    expect(plan.alone).toBeNull()
    expect(plan.main).not.toContain('--exclude')
  })

  it('never retries and never caps the workers (a retry hides a red test; the cap was slower)', () => {
    const plan = unitTestPlan()
    for (const cmd of [plan.main, plan.alone]) {
      expect(cmd).not.toMatch(/--retry/)
      expect(cmd).not.toMatch(/--maxWorkers|--poolOptions/)
    }
  })

  it('stays well under the 8191 character limit of a Windows command line', () => {
    const plan = unitTestPlan()
    expect(plan.main.length).toBeLessThan(6000)
    expect(plan.alone.length).toBeLessThan(6000)
  })
})

// The three above only help if the script calls them. patch.mjs runs for 25 minutes inside
// a ship, so the wiring is read from its source, comments left out.
describe('patch.mjs is wired to them', () => {
  const src = readFileSync(new URL('./patch.mjs', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

  it('hashes the tree once for the run and once at the end of the gate, and nowhere else', () => {
    expect(code.match(/\btreeHash\(/g)).toHaveLength(2)
    expect(code).toMatch(/const startTree = treeHash\(\)/)
    expect(code).toMatch(/const gate = async \(tree\) =>/)
    expect(code).toMatch(/await gate\(startTree\)/)
    expect(code).toMatch(/fastRefusal\(lastTag, startTree\)/)
  })

  it('enters the gate through enterGate, and sets no gate variable by hand', () => {
    expect(code).toMatch(/\benterGate\(\)/)
    expect(code).not.toMatch(/process\.env\.OLP_GATE\s*=/)
  })

  it('bumps from the gated manifests and checks them again after npm version', () => {
    expect(code).toMatch(/manifestsMoved\(gatedTree\)/)
    expect(code).toMatch(/versionInTree\(gatedTree\)/)
    expect(code).toMatch(/manifestsBeyondVersion\(gatedTree, version\)/)
    expect(code).not.toMatch(/const current = JSON\.parse\(readFileSync/)
  })

  it('refuses his files and huge files before the gate starts, and again before the commit', () => {
    const startAt = code.indexOf('stopIfRefusedAtStart(refusedAdds(startTree, headAtStart))')
    expect(code).toMatch(/const headAtStart = git\('rev-parse', 'HEAD'\)/)
    expect(code.indexOf('const startTree = treeHash()')).toBeLessThan(code.indexOf('const headAtStart'))
    expect(code.indexOf('const headAtStart')).toBeLessThan(startAt)
    // Before the --verify gate and before the ship's gate, which is the first `await gate(startTree)`.
    expect(startAt).toBeGreaterThan(-1)
    expect(startAt).toBeLessThan(code.indexOf('await gate(startTree)'))
    // A refusal prints, waits for the ship log to take it, and exits 1.
    expect(code).toMatch(/const stopRefused = async \(say\) => \{[^}]*shipLog\.write\(say, resolve\)[^}]*process\.exit\(1\)/)
    expect(code).toMatch(/const stopIfRefusedAtStart = async \(refused\) => \{\s*if \(!refused\.length\) return\s*await stopRefused\(/)
    // The backstop sits between building the release tree and committing it.
    const backstopAt = code.indexOf('refusedAdds(releaseTree, headAtStart)')
    expect(code.indexOf('const releaseTree = treeWith(')).toBeLessThan(backstopAt)
    expect(backstopAt).toBeLessThan(code.indexOf('commitExactTree(releaseTree'))
    // Through stopRefused, so the refusal reaches the ship log before the exit.
    expect(code).toMatch(/if \(refusedAtCommit\.length\) \{\s*await stopRefused\(/)
  })

  it('looks at the new files BEFORE the tree is hashed, because hashing reads and writes every one', () => {
    const untrackedAt = code.indexOf('await stopIfRefusedAtStart(refusedUntracked())')
    expect(untrackedAt).toBeGreaterThan(-1)
    // The first treeHash( in the code is the start tree, so nothing hashes before the listing.
    expect(code.indexOf('treeHash(')).toBe(code.indexOf('const startTree = treeHash()') + 'const startTree = '.length)
    expect(untrackedAt).toBeLessThan(code.indexOf('const startTree = treeHash()'))
    // Once at the start and once at the end of the gate.
    expect(code.match(/\brefusedUntracked\(/g)).toHaveLength(2)
  })

  it('looks at the new files again right before the gate hashes the tree at its end', () => {
    const gateAt = code.indexOf('const gate = async (tree) =>')
    const endHashAt = code.indexOf('const after = treeHash()')
    const endCheckAt = code.indexOf('const refusedAtEnd = refusedUntracked()')
    expect(gateAt).toBeGreaterThan(-1)
    expect(endCheckAt).toBeGreaterThan(gateAt)
    expect(endCheckAt).toBeLessThan(endHashAt)
    // Nothing else runs between the check and the hash: it stops through stopRefused, like the start.
    expect(code.slice(endCheckAt, endHashAt)).toMatch(
      /^const refusedAtEnd = refusedUntracked\(\)\s*if \(refusedAtEnd\.length\) \{\s*await stopRefused\([^]*\)\s*\}\s*$/,
    )
  })

  it('checks the commits for his files and huge files before pushMain sends anything', () => {
    const pushMainAt = code.indexOf('const pushMain = async')
    expect(pushMainAt).toBeGreaterThan(-1)
    const checkAt = code.indexOf('refusedInPush(', pushMainAt)
    expect(checkAt).toBeGreaterThan(pushMainAt)
    // pushMain is the only caller of pushOnce, and every push command lives in pushOnce above it.
    expect(code.match(/\bpushOnce\(/g)).toHaveLength(1)
    expect(code.indexOf('pushOnce(token)')).toBeGreaterThan(checkAt)
    const pushOnceAt = code.indexOf('const pushOnce =')
    const pushCommands = [...code.matchAll(/git push|'push'/g)].map((m) => m.index)
    expect(pushCommands.length).toBeGreaterThan(0)
    for (const at of pushCommands) {
      expect(at).toBeGreaterThan(pushOnceAt)
      expect(at).toBeLessThan(pushMainAt)
    }
    // It compares against the remote branch when there is one, and refuses through the ship log.
    expect(code.slice(pushMainAt, checkAt)).toMatch(/'rev-parse', '--verify', '-q', 'origin\/main'/)
    // main, not HEAD, because the push sends main and HEAD may be detached somewhere else.
    expect(code.slice(pushMainAt, checkAt)).toMatch(/let range = 'refs\/heads\/main'/)
    expect(code.slice(pushMainAt, checkAt)).toMatch(/range = 'origin\/main\.\.refs\/heads\/main'/)
    expect(code.slice(pushMainAt, checkAt)).not.toMatch(/'[^']*HEAD[^']*'/)
    expect(code.slice(checkAt, code.indexOf('pushOnce(token)'))).toMatch(/await stopRefused\(/)
  })
})

// The lanes, the two gates and the stamp only help if patch.mjs does what they say. It runs for
// minutes inside a ship, so the wiring is read from its source, comments left out.
describe('patch.mjs runs two gates (2026-10-12)', () => {
  const src = readFileSync(new URL('./patch.mjs', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

  it('npm run verify is the full gate and a plain ship is the release gate', () => {
    expect(code).toMatch(/const verifyOnly = args\.includes\('--verify'\)/)
    expect(code).toMatch(/const fullGate = verifyOnly\b/)
  })

  it('runs the checks that need no browser as the lanes gateLanes builds, all at once', () => {
    expect(code).toMatch(/const units = unitTestPlan\(\)/)
    expect(code).toMatch(/const lanes = gateLanes\(units\)/)
    expect(code).toMatch(/await runLanes\(lanes, shipLog\)/)
    expect(code).toMatch(/if \(!checked\.ok\) fail\(checked\.failed\)/)
    // No lane is built by hand here, and no vitest run either.
    expect(code).not.toMatch(/npx vitest/)
    expect(code).not.toMatch(/npx tsc|npx eslint|electron-vite build|check-self-contained/)
  })

  it('gateLanes: four lanes, these steps in this order, the unit lane is the plan\'s main', () => {
    const units = unitTestPlan()
    const lanes = gateLanes(units)
    expect(lanes).toHaveLength(4)
    expect(lanes.map((steps) => steps.map(([, label]) => label))).toEqual([
      ['typecheck (renderer)'],
      ['lint'],
      ['unit tests'],
      ['typecheck (electron)', 'desktop build', 'the desktop bundle needs no node_modules'],
    ])
    // The unit test lane is the plan's `main` command (every file but the clock ones), never a bare
    // `npx vitest run` with the 5 s default that failed the first real release gate (2026-10-12).
    expect(lanes.map((steps) => steps.map(([cmd]) => cmd))).toEqual([
      ['npx tsc --noEmit'],
      ['npx eslint .'],
      [units.main],
      ['npx tsc -p tsconfig.electron.json --noEmit', 'npx electron-vite build', 'node scripts/check-self-contained.mjs'],
    ])
  })

  it('runs the clock tests alone once the lanes passed, and before the web build and the browser', () => {
    const lanesAt = code.indexOf('if (!checked.ok) fail(checked.failed)')
    const aloneAt = code.indexOf('if (units.alone) {')
    expect(lanesAt).toBeGreaterThan(-1)
    expect(aloneAt).toBeGreaterThan(lanesAt)
    expect(aloneAt).toBeLessThan(code.indexOf('npx vite build'))
    expect(code).toMatch(/if \(units\.alone\) \{\s*try \{\s*await run\(units\.alone, '[^']+'\)\s*\} catch \{\s*(?:\/\/[^\n]*\s*)?await new Promise\(\(resolve\) => \(shipLog \? shipLog\.write\('', resolve\) : resolve\(\)\)\)\s*fail\('[^']+'\)/)
  })

  it('builds the web bundle in the full gate only', () => {
    expect(code.match(/npx vite build/g)).toHaveLength(1)
    expect(code).toMatch(/if \(fullGate\) \{\s*try \{\s*await run\('npx vite build', 'web build'\)/)
  })

  it('the release gate runs the release set with OLP_RELEASE set for that one step only', () => {
    expect(code).toMatch(/withEnv\('OLP_RELEASE', '1', \(\) => blockingBrowserRun\('npx playwright test', /)
    expect(code).not.toMatch(/process\.env\.OLP_RELEASE\s*=/)
  })

  it('playwright.config.ts: the release project retries once, and the full suite never retries', () => {
    // Comment lines are left out: the file's own notes say "never retries:" and would be counted.
    const cfg = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    // The release project is wired: only when OLP_RELEASE is set, alone, with one retry.
    expect(cfg).toMatch(/projects: process\.env\.OLP_RELEASE\s*\?\s*\[\{ name: 'release', testMatch: glob\(RELEASE\), retries: 1 \}\]/)
    // What a release is gated on. export-shapes since 2026-10-17: every frame shape exports.
    expect(cfg).toMatch(/const RELEASE = \['boot\.spec\.ts', 'mvp\.spec\.ts', 'export\.spec\.ts', 'export-shapes\.spec\.ts'\]/)
    // That is the only `retries:` in the file, so no other project and no top level setting retries.
    expect(cfg.match(/retries:/g)).toHaveLength(1)
  })

  it('playwright.config.ts refuses to start when a release spec does not exist, and each one does', () => {
    const cfg = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(cfg).toMatch(/for \(const name of RELEASE\) \{\s*if \(!existsSync\(new URL\(`\.\/e2e\/\$\{name\}`, import\.meta\.url\)\)\) \{\s*throw new Error\(/)
    const names = JSON.parse(cfg.match(/const RELEASE = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
    for (const name of names) expect(existsSync(new URL(`../e2e/${name}`, import.meta.url)), name).toBe(true)
  })

  it('the full gate blocks on smoke and ui, and only warns about the speed tests', () => {
    expect(code).toMatch(/blockingBrowserRun\('npx playwright test --project=smoke --project=ui', /)
    expect(code).toMatch(/try \{\s*await run\('npx playwright test --project=timing', '[^']*'\)\s*\} catch \{\s*tell\(/)
  })

  it('a red blocking browser run keeps its evidence in both gates', () => {
    expect(code.match(/keepEvidence\(/g)).toHaveLength(1)
    expect(code).toMatch(/const blockingBrowserRun = async \(cmd, label, opts\) => \{/)
  })

  it('the release gate names its flaky tests and keeps them, without failing the ship', () => {
    // The release run's own output is read, after it passed, and a flaky one only warns.
    const at = code.indexOf('const tee = ')
    const block = code.slice(at, code.indexOf('const after = treeHash()'))
    expect(at).toBeGreaterThan(-1)
    expect(block).toMatch(/^const tee = \{ out: keep\(process\.stdout\), err: keep\(process\.stderr\) \}\s*await withEnv\('OLP_RELEASE', '1', \(\) => blockingBrowserRun\('npx playwright test', '[^']+', tee\)\)/)
    expect(block).toMatch(/const flaky = flakyTests\(Buffer\.concat\(said\)\.toString\('utf8'\)\)/)
    expect(block).toMatch(/if \(flaky\.count\) \{\s*const kept = recordFlaky\(flaky\)\s*tell\(/)
    expect(block).not.toMatch(/\bfail\(|process\.exit/)
  })

  it('only the full gate stamps', () => {
    expect(code.match(/\bwriteStamp\(/g)).toHaveLength(1)
    expect(code).toMatch(/if \(fullGate && !fast\) writeStamp\(tree\)/)
  })

  it('lowers its own priority before it starts anything', () => {
    expect(code).toContain('setPriority(constants.priority.PRIORITY_BELOW_NORMAL)')
    expect(code.indexOf('setPriority(')).toBeLessThan(code.indexOf('openShipLog('))
  })
})

// 2026-10-19: the release set retries a failed test once, and a test that passed on its retry was
// named only in last-ship.log, which the next ship overwrites. The text below is a real Playwright
// 1 worker run, list reporter, piped the way the gate pipes it: two tests failed once and passed on
// the retry, two passed first time.
const PLAYWRIGHT_FLAKY = String.raw`
Running 4 tests using 1 worker

  ok 1 [release] › e2e\boot.spec.ts:2:5 › the editor mounts (5ms)
  x  2 [release] › e2e\export.spec.ts:2:5 › exports a 9:16 movie (3ms)
  ok 3 [release] › e2e\export.spec.ts:2:5 › exports a 9:16 movie (retry #1) (4ms)
  x  4 [release] › e2e\mvp.spec.ts:3:7 › core edit flow › cut, trim and undo (3ms)
  ok 5 [release] › e2e\mvp.spec.ts:3:7 › core edit flow › cut, trim and undo (retry #1) (5ms)
  ok 6 [release] › e2e\mvp.spec.ts:6:7 › core edit flow › drag a clip (1ms)


  1) [release] › e2e\export.spec.ts:2:5 › exports a 9:16 movie ─────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 0

      1 | import { test, expect } from '@playwright/test'
      2 | test('exports a 9:16 movie', ({}, info) => {
    > 3 |   expect(info.retry).toBe(1)
        |                      ^
      4 | })
      5 |
        at C:\Users\skyle\AppData\Local\Temp\pw\e2e\export.spec.ts:3:22

    Error Context: test-results\export-exports-a-9-16-movie-release\error-context.md

  2) [release] › e2e\mvp.spec.ts:3:7 › core edit flow › cut, trim and undo ─────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 0

      2 | test.describe('core edit flow', () => {
      3 |   test('cut, trim and undo', ({}, info) => {
    > 4 |     expect(info.retry).toBe(1)
        |                        ^
      5 |   })
      6 |   test('drag a clip', () => {
      7 |     expect(2).toBe(2)
        at C:\Users\skyle\AppData\Local\Temp\pw\e2e\mvp.spec.ts:4:24

    Error Context: test-results\mvp-core-edit-flow-cut-trim-and-undo-release\error-context.md

  2 flaky
    [release] › e2e\export.spec.ts:2:5 › exports a 9:16 movie ──────────────────────────────────────
    [release] › e2e\mvp.spec.ts:3:7 › core edit flow › cut, trim and undo ──────────────────────────
  2 passed (1.3s)
`

describe('a flaky pass in the release gate', () => {
  const NAMES = [
    String.raw`[release] › e2e\export.spec.ts:2:5 › exports a 9:16 movie`,
    String.raw`[release] › e2e\mvp.spec.ts:3:7 › core edit flow › cut, trim and undo`,
  ]

  it('reads the flaky count and every flaky test from the summary, and nothing else', () => {
    expect(flakyTests(PLAYWRIGHT_FLAKY)).toEqual({ count: 2, names: NAMES })
  })

  it('reads it the same with Windows line ends and colour codes', () => {
    const coloured = PLAYWRIGHT_FLAKY.replace('  2 flaky', '  \u001b[33m2 flaky\u001b[39m').replace(/\n/g, '\r\n')
    expect(flakyTests(coloured)).toEqual({ count: 2, names: NAMES })
  })

  it('finds nothing in a clean run, or in no output at all', () => {
    expect(flakyTests('\nRunning 4 tests using 1 worker\n\n  ok 1 [release] › e2e\\boot.spec.ts:2:5 › the editor mounts (5ms)\n\n  4 passed (1.4m)\n')).toEqual({ count: 0, names: [] })
    expect(flakyTests('')).toEqual({ count: 0, names: [] })
    expect(flakyTests(undefined)).toEqual({ count: 0, names: [] })
  })

  it('still counts a summary whose names it cannot read', () => {
    expect(flakyTests('  1 flaky\n  3 passed (1.0m)\n')).toEqual({ count: 1, names: [] })
  })

  it('adds the names to one file at the gate-evidence root, and never throws', () => {
    const root = scratchDir('olp-flaky-')
    const now = new Date('2026-10-19T12:34:56.789Z')
    const file = recordFlaky(flakyTests(PLAYWRIGHT_FLAKY), { root, now })
    expect(file).toBe(join(root, 'flaky.txt'))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines[0]).toMatch(/^2 flaky in the release gate, 2026-10-19T12:34:56\.789Z/)
    expect(lines.slice(1)).toEqual(NAMES)
    // A second flaky ship adds to the same file and makes no run folder, so it can never push an
    // older red gate's traces out of keepEvidence's newest three.
    recordFlaky({ count: 1, names: ['[release] later'] }, { root, now: new Date('2026-10-20T00:00:00.000Z') })
    const all = readFileSync(file, 'utf8').trim().split('\n')
    expect(all.slice(0, lines.length)).toEqual(lines)
    expect(all.slice(lines.length)).toEqual([expect.stringMatching(/^1 flaky in the release gate, 2026-10-20/), '[release] later'])
    expect(readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())).toEqual([])
    // A root that cannot be made (a file is in the way) is a null, not a thrown error.
    const blocked = join(root, 'a-file')
    writeFileSync(blocked, '')
    expect(recordFlaky({ count: 1, names: [] }, { root: blocked, now })).toBeNull()
  })
})

// 2026-10-06: "how long is the gate" had to be rebuilt from file times.
describe('runLogged', () => {
  it('says how long a step took, in the log as well', async () => {
    const log = sink()
    const out = sink()
    const secs = await runLogged('node -e "console.log(1)"', 'tiny step', log, { out, err: sink() })
    expect(secs).toBeTypeOf('number')
    expect(log.said.join('')).toMatch(/✓ tiny step \(\d+ s\)/)
  })

  it('a failure carries its label and says how long it ran', async () => {
    const log = sink()
    await expect(runLogged('node -e "process.exit(3)"', 'red step', log, { out: sink(), err: sink() })).rejects.toMatchObject({
      label: 'red step',
      message: 'red step exited 3',
    })
    expect(log.said.join('')).toMatch(/✗ red step exited 3 after \d+ s/)
  })
})

// ⛔ Playwright empties test-results/ at the start of every run, and a rerun 54
// seconds after the red gate of 2026-10-06 deleted its trace.
describe('keepEvidence', () => {
  const results = () => {
    const dir = scratchDir('olp-evidence-')
    const from = join(dir, 'test-results')
    mkdirSync(join(from, 'play-latency-1'), { recursive: true })
    writeFileSync(join(from, 'play-latency-1', 'trace.zip'), 'trace')
    writeFileSync(join(dir, 'last-ship.log'), 'the log')
    return { dir, from, root: join(dir, 'gate-evidence'), log: join(dir, 'last-ship.log') }
  }

  it('moves the results out of reach and keeps the ship log beside them', () => {
    const { from, root, log } = results()
    const kept = keepEvidence({ from, root, extra: [log], now: new Date('2026-10-06T16:09:11Z') })
    expect(kept).toBe(join(root, '2026-10-06T16-09-11-000Z'))
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(kept, 'test-results', 'play-latency-1', 'trace.zip'), 'utf8')).toBe('trace')
    expect(readFileSync(join(kept, 'last-ship.log'), 'utf8')).toBe('the log')
  })

  it('keeps only the newest few, because his C drive fills up', () => {
    const { dir, root } = results()
    for (let day = 1; day <= 5; day++) {
      mkdirSync(join(dir, 'test-results'), { recursive: true })
      keepEvidence({ from: join(dir, 'test-results'), root, keep: 3, now: new Date(`2026-10-0${day}T12:00:00Z`) })
    }
    expect(readdirSync(root).sort()).toEqual(['2026-10-03T12-00-00-000Z', '2026-10-04T12-00-00-000Z', '2026-10-05T12-00-00-000Z'])
  })

  it('nothing to keep is not an error', () => {
    const { dir, root } = results()
    expect(keepEvidence({ from: join(dir, 'no-such-folder'), root })).toBeNull()
  })
})
