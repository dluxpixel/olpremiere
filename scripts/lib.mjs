// Shared release helpers.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Where a ship writes everything it saw. ONE rolling file, overwritten each run,
 * because his C drive is the thing that fills up and a folder of build logs is
 * the last thing it needs.
 */
export const SHIP_LOG = 'C:/Users/skyle/AppData/Local/olp-build/last-ship.log'

/**
 * Open the ship log. Returns a writer that also survives being called when the
 * file cannot be opened, because a logging problem must never be the thing that
 * stops a release.
 */
export function openShipLog(header) {
  try {
    mkdirSync(dirname(SHIP_LOG), { recursive: true })
    const s = createWriteStream(SHIP_LOG)
    s.write(`${header}\n`)
    return s
  } catch {
    return null
  }
}

/**
 * Run a command, show it live, AND keep every byte of it in the ship log.
 *
 * ⛔ WHY THIS EXISTS. On 2026-08-12 a release failed after a 25 minute gate had
 * already gone green, and **nobody could say why**: the command had been piped
 * through `tail`, so all that survived was the last few lines, which were the
 * error object and not the error. The rebuild worked and the cause is still
 * unknown. `stdio: 'inherit'` means the child writes past this script straight
 * to whatever the terminal happens to be, so the script itself never sees the
 * one thing worth keeping.
 *
 * The fix is NOT "remember not to pipe it". The log is written here, so it
 * exists however the command was invoked, and a failure prints where to read it.
 */
export function runLogged(cmd, label, log, { out = process.stdout, err = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const say = (stream, d) => {
      stream.write(d)
      log?.write(d)
    }
    say(out, `\n▶ ${label}\n`)
    // windowsHide: shell:true means cmd.exe on Windows, and a ship launched
    // detached has no console of its own, so each gate step opened a black box
    // on his screen. The output is piped and logged either way.
    const child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
    // The last of what the command said, kept so a caller can ask WHY it failed
    // rather than only that it did. Bounded, because a packaging run prints
    // megabytes and none of it is worth holding in memory.
    let tail = ''
    const keep = (d) => {
      tail = (tail + d).slice(-TAIL_CHARS)
    }
    child.stdout.on('data', (d) => {
      say(out, d)
      keep(d)
    })
    child.stderr.on('data', (d) => {
      say(err, d)
      keep(d)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      // How long each step took, in the log, because on 2026-10-06 "how long is
      // the gate" had to be rebuilt from file times.
      const secs = Math.round((Date.now() - t0) / 1000)
      say(out, code === 0 ? `✓ ${label} (${secs} s)\n` : `✗ ${label} exited ${code} after ${secs} s\n`)
      if (code === 0) resolve(secs)
      else {
        const e = new Error(`${label} exited ${code}`)
        e.output = tail
        e.label = label
        reject(e)
      }
    })
  })
}

const TAIL_CHARS = 8000

/**
 * A failure that is the network having a bad moment, not the build being wrong.
 *
 * Deliberately a LIST OF SIGNATURES and not "retry anything". A real compile
 * error retried three times is six wasted minutes and a confusing log, and worse,
 * it turns a repeatable failure into something that looks intermittent.
 */
const TRANSIENT = /socket hang up|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_STREAM_PREMATURE_CLOSE|RequestError|\b50[234]\b/i

export function isTransientFailure(output) {
  return TRANSIENT.test(output ?? '')
}

/**
 * Is there anything for a release to carry, and what is it?
 *
 * Returns a reason to ship, or null to mean genuinely nothing to do.
 *
 * ⛔ WHY THIS EXISTS. This test used to live inline in patch.mjs as
 * `!dirty && unpushed === '0'`, and on 2026-08-17 five commits of finished work
 * sat on main for a day because of it: a component test layer, two measurement
 * specs and both halves of a memory fix. **Committed and pushed is not the same
 * as RELEASED.** A session that lands work with `npm run ci` and a plain commit
 * leaves the tree clean and main pushed, and after that every `npm run patch`
 * answered "nothing to release" while the app on his machine stayed a version
 * behind, with no way back except a hand rolled release.
 *
 * So the question is asked properly now: anything above the last released tag
 * counts. `unreleased` is the caller's count for that, because only the caller
 * can talk to git.
 */
/**
 * Is this a BIG update, meaning more than one ordinary step forward?
 *
 * His words, 2026-08-17: *"every time it does a huge update, you can check the app
 * every time it does a big thing."* A big thing is not every release: he streams, and
 * the packaged app check puts a window on his screen, so it is gated to the releases
 * where a whole slab of the app changed.
 *
 * ⛔ THIS ASKS ABOUT THE SIZE OF THE STEP, NOT ABOUT WHICH NUMBER MOVED, and the
 * difference is the whole point. It used to read "the minor or major moved", which
 * was the same question back when an ordinary ship bumped the PATCH: seventeen
 * releases went out as 2.0.x and this answered no to every one of them.
 *
 * His numbering, 2026-08-19, moved the ordinary ship onto the MINOR (2.17 becomes
 * 2.18). Left as it was, this would have answered YES to every release from then on
 * and put a window on his screen every single time, which is the thing it exists to
 * avoid, in the same session he said *"it keeps popping up every single time I work
 * with you."*
 *
 * So a step of exactly one minor is ordinary, a fix on top of a release is ordinary,
 * and anything larger is big:
 *
 *   2.17.0 -> 2.18.0   one step, an ordinary ship        no
 *   2.17.0 -> 2.17.1   a fix on top of one               no
 *   2.39.0 -> 3.0.0    one step that rolled over         no
 *   2.0.18 -> 2.17.0   a seventeen step jump             yes
 *   2.9.0  -> 3.0.0    the major moved on its own        yes
 *   3.0.0  -> 2.9.0    backwards, so something is wrong  yes
 *
 * "Ordinary" is defined in one place, `nextVersion`: a step is ordinary when it is
 * exactly what an ordinary ship or a fix would have produced from the previous tag.
 * So the rollover at 40 (below) is ordinary, because it IS the ordinary ship.
 *
 * An unparseable or missing previous tag counts as big, because "I do not know what
 * changed" deserves the stronger check rather than the weaker one.
 */
export function isBigUpdate(prevTag, version) {
  const prev = parseVersion(prevTag)
  const next = parseVersion(version)
  if (!prev || !next) return true
  const asString = `${next.major}.${next.minor}.${next.patch}`
  return asString !== nextVersion(prev, 'minor') && asString !== nextVersion(prev, 'fix')
}

export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''))
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null
}

/**
 * The middle number never reaches 40. His rule, 2026-09-14: *"when it goes up,
 * let's say the version is 2.39, the second it hits 2.40, it doesn't say 2.40,
 * and it just goes to 3.0. Okay? same with 3.40 and so on."*
 */
export const MINOR_ROLLOVER = 40

/**
 * The version an ordinary ship (`minor`) or a fix (`fix`) produces from `current`.
 *
 * An ordinary ship moves the middle number: 2.17.0 becomes 2.18.0. When that
 * would reach MINOR_ROLLOVER the front number moves instead and the rest reset:
 * 2.39.0 becomes 3.0.0, and 3.39.x becomes 4.0.0. A fix moves the last number
 * only and never rolls anything: 2.17.0 becomes 2.17.1.
 *
 * Takes a version string or a parsed one. Returns a plain three part string,
 * the only shape electron-updater compares.
 */
export function nextVersion(current, kind) {
  const v = typeof current === 'string' ? parseVersion(current) : current
  if (!v) throw new Error(`cannot bump "${current}": not a version`)
  if (kind === 'fix') return `${v.major}.${v.minor}.${v.patch + 1}`
  if (kind !== 'minor') throw new Error(`unknown bump "${kind}"`)
  const minor = v.minor + 1
  if (minor >= MINOR_ROLLOVER) return `${v.major + 1}.0.0`
  return `${v.major}.${minor}.0`
}

export function releaseWork({ dirty, unpushed, unreleased }) {
  if (dirty && dirty.trim()) return 'uncommitted changes in the tree'
  if (Number(unpushed) > 0) return `${unpushed} commit(s) not yet pushed`
  if (Number(unreleased) > 0) return `${unreleased} commit(s) above the last released tag`
  return null
}

/**
 * WHAT A SHIP STILL HAS TO DO, AND NOTHING IT HAS ALREADY DONE (2026-09-25).
 *
 * His words: "when you upload to GitHub, it always takes a ton, a ton, and a
 * ton of time... every single ol premiere patch takes time". Measured on the
 * v3.9.0 ship: about 30 minutes, 17 of them the browser suite. Two ways that
 * time was being spent twice:
 *
 * 1. THE SAME CODE, CHECKED AGAIN. The gate ran in full even when this exact
 *    tree had just passed it (`verified`: the tree hash matches the stamp the
 *    last passing gate wrote). Same bytes, same result: skipping it weakens
 *    nothing, the gate still ran on exactly what ships.
 * 2. A DROPPED CONNECTION STARTED OVER. v3.8.0 passed its gate, committed, and
 *    lost the internet at the push. Running the ship again would have run the
 *    whole gate AGAIN and then bumped a SECOND version over the first. It was
 *    finished by hand. Now a release commit this script made (`headIsRelease`)
 *    that never left the machine only needs the push and the publish, and one
 *    that was pushed but never published only needs the publish.
 *
 * Returns null when there is nothing to ship, else the steps still to run.
 */
export function planShip({ dirty, unpushed, unreleased, headIsRelease, verified }) {
  const why = releaseWork({ dirty, unpushed, unreleased })
  if (!why) return null
  const clean = !(dirty && dirty.trim())
  if (clean && headIsRelease && Number(unpushed) > 0) {
    return { why: 'a release commit that never reached GitHub', gate: false, bump: false, push: true, release: true }
  }
  if (clean && headIsRelease && Number(unreleased) > 0) {
    return { why: 'a pushed release commit that was never published', gate: false, bump: false, push: false, release: true }
  }
  return { why, gate: !verified, bump: true, push: true, release: true }
}

/**
 * `runLogged`, but a network drop gets another go.
 *
 * ⛔ WHY THIS EXISTS. On 2026-08-12 two ships were thrown away by one dropped
 * packet each. The second one had ALREADY passed a 25 minute gate, committed and
 * pushed, and then died on `socket hang up` while electron-builder downloaded its
 * own toolchain, which left the version public with no release behind it. The
 * note for that says "run `npm run release` again", **so the repair was already
 * known to be safe to repeat: this does it without waiting for a human to read
 * the note.**
 *
 * ⛔ THIS IS NOT A RETRY ON THE GATE, and it must never become one. The tests
 * either pass or they do not, and trying again until they agree is how a red
 * suite gets shipped. This only wraps steps that are a local build or an upload,
 * where the only thing that failed was the wire.
 */
export async function runLoggedRetry(cmd, label, log, { tries = 3, baseDelayMs = 15_000, out = process.stdout, err = process.stderr } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runLogged(cmd, attempt === 1 ? label : `${label}, try ${attempt} of ${tries}`, log, { out, err })
    } catch (e) {
      if (attempt >= tries || !isTransientFailure(e.output)) throw e
      const waitMs = baseDelayMs * attempt
      const msg = `\n⚠ ${label} failed on what looks like a dropped connection, not a broken build.\n  Waiting ${Math.round(waitMs / 1000)}s, then try ${attempt + 1} of ${tries}.\n`
      out.write(msg)
      log?.write(msg)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

/**
 * The GitHub token, from $GH_TOKEN or a gitignored `.env.release` (GH_TOKEN=...).
 * Storing it locally means shipping never needs a token pasted in again. null if none.
 */
export function loadToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  try {
    if (existsSync('.env.release')) {
      const m = readFileSync('.env.release', 'utf8').match(/^\s*GH_TOKEN\s*=\s*(.+?)\s*$/m)
      if (m) return m[1].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    // ignore
  }
  return null
}

/** fetch with retries, because node/undici is flaky in this env (ENOTFOUND / ECONNABORTED). */
export async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts)
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastErr
}

// --- what the gate checked is what gets committed (2026-10-06) ---------------
//
// ⛔ THE GATE USED TO CERTIFY A TREE IT NEVER SAW. The tree hash was taken BEFORE
// a 25 minute gate, tsc, eslint and vitest were all done in its first two
// minutes, and the commit at the end was a plain `git add -A`. A file saved at
// minute five skipped typecheck, lint and unit tests, was half seen by the e2e
// (the dev server serves whatever is on disk), and was then committed as gated.
// Eleven auditors and several builders were live in this repo the day that was
// found.
//
// So the gate hashes the tree again when it ends and refuses a tree that moved,
// and the release commit is BUILT from the gated tree (plus the version bump),
// never from whatever is on disk at commit time.

/** git in `cwd`, stdout trimmed. `env` adds to the environment. */
function gitIn(cwd, args, { env, input } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

/** Run `fn(env)` against a throwaway index, so the real one is never touched. */
function withScratchIndex(cwd, seedFromReal, fn) {
  const index = join(tmpdir(), `olp-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    if (seedFromReal) {
      // A copy of the real index only saves git re-hashing unchanged files.
      const real = join(gitIn(cwd, ['rev-parse', '--absolute-git-dir']), 'index')
      if (existsSync(real)) copyFileSync(real, index)
    }
    return fn({ GIT_INDEX_FILE: index })
  } finally {
    rmSync(index, { force: true })
  }
}

/**
 * The tree hash of everything a commit would take (tracked and new files, the
 * ignore list honoured). Same hash means same bytes.
 */
export function treeHash(cwd = process.cwd()) {
  return withScratchIndex(cwd, true, (env) => {
    gitIn(cwd, ['add', '-A'], { env })
    return gitIn(cwd, ['write-tree'], { env })
  })
}

/** Paths that differ between two trees (or commits, or tags), sorted. */
export function changedBetween(a, b, cwd = process.cwd()) {
  const out = gitIn(cwd, ['diff-tree', '-r', '--name-only', '--no-commit-id', a, b])
  return out ? out.split('\n').sort() : []
}

/**
 * `baseTree` with only `paths` taken from the working tree on top: the gated
 * tree plus the version bump, and nothing anybody saved after the gate.
 */
export function treeWith(baseTree, paths, cwd = process.cwd()) {
  return withScratchIndex(cwd, false, (env) => {
    gitIn(cwd, ['read-tree', baseTree], { env })
    const present = paths.filter((p) => existsSync(join(cwd, p)))
    if (present.length) gitIn(cwd, ['add', '--', ...present], { env })
    return gitIn(cwd, ['write-tree'], { env })
  })
}

/**
 * Commit exactly `tree` on top of `parent` and move the branch there, then line
 * the real index up with it. Throws, and moves nothing, if the branch is no
 * longer at `parent` (something else committed while the gate ran).
 *
 * Whatever changed on disk after the tree was taken is NOT in the commit and
 * shows up as an ordinary uncommitted change afterwards, for the next ship.
 */
export function commitExactTree(tree, message, { parent, cwd = process.cwd() }) {
  const commit = gitIn(cwd, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: message })
  gitIn(cwd, ['update-ref', '-m', 'patch: release commit of the gated tree', 'HEAD', commit, parent])
  gitIn(cwd, ['reset', '-q'])
  return commit
}

// --- --fast keeps its own contract (2026-10-06) -------------------------------
//
// ⛔ `--fast` says "docs only or comment only", and it shipped four FEATURE
// releases with no browser test at all: v3.15.0 (fonts), v3.16.0 (the HEVC
// export path), v3.18.0, v3.20.0. Nothing in git or on GitHub said so. Now it
// refuses a release that carries code, and the ones it allows say so in the
// commit and in the GitHub release.

/** The line a --fast release carries in its commit body and its GitHub release. */
export const FAST_MARK = 'E2E SKIPPED (--fast)'

/** What a --fast release may carry: Markdown anywhere, and anything under docs/. */
export function isDocsPath(path) {
  return /\.md$/i.test(path) || path.startsWith('docs/')
}

/** The paths that make a release NOT docs only. Empty means --fast is allowed. */
export function codeFiles(paths) {
  return paths.filter((p) => !isDocsPath(p))
}

// --- a failed gate keeps its evidence (2026-10-06) ----------------------------
//
// ⛔ PLAYWRIGHT EMPTIES test-results/ AT THE START OF EVERY RUN. The nine traces of
// 2026-10-04's first ship were deleted when the next ship started that evening,
// so the failures could only be re-rolled ("8 passed alone"), never read. On
// 2026-10-06 a rerun started 54 seconds after a red gate and deleted its
// scrub-cost trace. So a red e2e step moves its results out of reach first.

/** Where a red gate's traces, videos and ship log are kept. His C drive, newest few only. */
export const EVIDENCE_DIR = 'C:/Users/skyle/AppData/Local/olp-build/gate-evidence'

/**
 * Move `from` (test-results/) into `<root>/<stamp>/`, copy each of `extra` beside
 * it, and keep only the newest `keep` runs. Returns the folder, or null when there
 * was nothing to keep. Never throws: keeping evidence must not hide the failure.
 */
export function keepEvidence({ from, root = EVIDENCE_DIR, extra = [], keep = 3, now = new Date() }) {
  try {
    if (!existsSync(from)) return null
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const dest = join(root, stamp)
    mkdirSync(dest, { recursive: true })
    const target = join(dest, basename(from))
    try {
      renameSync(from, target)
    } catch {
      // Another drive, or a file still held open: copy what can be copied.
      cpSync(from, target, { recursive: true })
      rmSync(from, { recursive: true, force: true })
    }
    for (const f of extra) {
      if (existsSync(f)) copyFileSync(f, join(dest, basename(f)))
    }
    const runs = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()).sort()
    for (const old of runs.slice(0, Math.max(0, runs.length - keep))) rmSync(join(root, old), { recursive: true, force: true })
    return dest
  } catch {
    return null
  }
}
