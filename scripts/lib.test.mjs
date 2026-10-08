// The ship script is the thing that ships everything else, and on 2026-08-12 it
// lost two finished builds to one dropped packet each. Its retry is unit tested
// for the same reason `_verify` is: a step that only runs during a 25 minute
// release cannot be "checked by eye" in any useful sense.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  changedBetween,
  codeFiles,
  commitExactTree,
  enterGate,
  fastRefusal,
  keepEvidence,
  manifestsBeyondVersion,
  manifestsMoved,
  runLogged,
  isBigUpdate,
  isDocsPath,
  isTransientFailure,
  MINOR_ROLLOVER,
  nextVersion,
  planShip,
  releaseWork,
  runLoggedRetry,
  treeHash,
  treeWith,
  versionInTree,
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
