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
  // ⛔ A release that may already be live is never "the wire", whatever else the
  // output says. See MAY_BE_LIVE: the retry would delete it.
  if (mayBeLive(output)) return false
  return TRANSIENT.test(output ?? '')
}

/**
 * ⛔ THE LINE A RELEASE STOPS ON AND IS NEVER RETRIED ON, 2026-10-07.
 *
 * scripts/githubRelease.mjs puts it in its error when the publish call has gone out
 * and nobody can say what GitHub did with it: the answer was lost and GitHub could not
 * be asked afterwards, or the release was published and could not be checked. That
 * error only exists when the network failed, so its output carries a network signature
 * (ENOTFOUND, ECONNRESET, a 502), and `runLoggedRetry` used to run publish.mjs again 15
 * seconds later. A new run starts by deleting every release with this tag, published or
 * not: the live release went, every installed app saw the previous version as the
 * newest for the minutes of the re-upload, and a copy mid download got a 404. Exactly
 * what the error had just told him not to do.
 */
export const MAY_BE_LIVE = 'RELEASE MAY BE LIVE: stopped, nothing retried, nothing deleted'

/** Did a step end on MAY_BE_LIVE (see above)? */
export function mayBeLive(output) {
  return String(output ?? '').includes(MAY_BE_LIVE)
}

/**
 * What release.mjs and patch.mjs tell him when the publish stopped on MAY_BE_LIVE, one
 * line per entry, or null when it did not. It ends on the marker itself, so a script
 * that runs this one stops on it too.
 */
export function mayBeLiveReport(version, output) {
  if (!mayBeLive(output)) return null
  return [
    `⛔ v${version} MAY ALREADY BE LIVE on GitHub. The publish call went out without an answer that could be trusted,`,
    '   so nothing was retried and nothing was deleted. Look at the release on GitHub before running anything again:',
    `   published with all three files, v${version} is out and nothing is left to do;`,
    '   still a draft, `npm run release` finishes it (a run replaces the draft).',
    `   ${MAY_BE_LIVE}`,
  ]
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

// --- the no-browser checks side by side (2026-10-12) --------------------------
//
// His word, 2026-10-12: "make a system for when we do release new updates. It doesn't
// take half as long. It doesn't even take a third of that long." The checks that need no
// browser ran one after another for 212 s (the unit tests alone 103 of them). They share
// nothing, so they run as lanes at once, bounded by his limit of four heavy jobs at once.

/**
 * Run `lanes` AT THE SAME TIME, and the steps inside each lane one after another.
 *
 * A lane is an array of `[command, label]` steps. A step that fails ends its lane (the
 * steps after it depend on it: a desktop build of code that does not typecheck says
 * nothing), but never the other lanes: every lane is waited for, so one red run names
 * everything that is red.
 *
 * ⛔ A LANE'S OUTPUT IS BUFFERED AND WRITTEN ONCE, when the lane ends, to `out` and to the
 * ship log (`log`). Four commands writing live into one terminal and one log would
 * interleave line by line and read as noise, which is the log that has to explain a red
 * gate. Each block still carries every `▶ label` and `✓ label (N s)` line runLogged
 * writes. stdout and stderr share one buffer, so a lane reads in the order it happened.
 *
 * Resolves, never rejects: `{ ok, failed, lanes }`. `failed` is the label of the first
 * failing step in LANE ORDER (not in the order they finished, which depends on the
 * machine), or null. `lanes[i]` is `{ failed, output, secs }`.
 */
export async function runLanes(lanes, log, { out = process.stdout } = {}) {
  const settled = await Promise.allSettled(lanes.map((steps) => runLane(steps, log, out)))
  const results = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { failed: `a check lane crashed: ${s.reason?.message ?? s.reason}`, output: '', secs: 0 },
  )
  const first = results.find((r) => r.failed !== null)
  return { ok: !first, failed: first ? first.failed : null, lanes: results }
}

async function runLane(steps, log, out) {
  const t0 = Date.now()
  const chunks = []
  // Collected as bytes and decoded once at the end: a multibyte character split across
  // two reads would otherwise come out as two broken ones.
  const buffer = { write: (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) }
  let failed = null
  for (const [cmd, label] of steps) {
    try {
      await runLogged(cmd, label, null, { out: buffer, err: buffer })
    } catch {
      failed = label
      break
    }
  }
  const output = Buffer.concat(chunks).toString('utf8')
  out.write(output)
  log?.write(output)
  return { failed, output, secs: Math.round((Date.now() - t0) / 1000) }
}

// --- the unit tests inside the parallel gate (2026-10-12) ---------------------
//
// ⛔ THE FIRST REAL RELEASE GATE FAILED 4 OF 426 UNIT TEST FILES ON A BUSY BOX. Four lanes at
// once (tsc, eslint, the desktop build, vitest) saturated the machine, and four tests that pass
// alone went red: two ran past vitest's 5 s limit (captions.test.ts, audioRender.test.ts) and two
// failed a budget they read off the clock (timeline.test.ts 402.8x against 360, scriptAlign.test.ts
// 2043 ms against 2000). Their budgets guard real slowdowns, so they are NOT loosened. The fix is
// where they run:
//   * Every test in the gate gets 30 s, not 5 s. A unit test is not a timing test, and under a
//     busy box a 5 s limit only measures the box. vitest.config.ts is untouched for normal runs.
//     That alone is NOT enough, measured: with only this, 3 of 4 gates still failed on a clock
//     budget (scriptAlign 2041 to 2205 ms against 2000, timeline 915x against 900).
//   * The files that assert on a clock leave the parallel lane and run alone, after the other
//     lanes have finished, on a quiet box. Alone they take about 12 s.
//   * Workers are NOT capped. Half the cores (--maxWorkers=16) made the unit test lane 10 to 17 s
//     slower (74 s to 84 and 91 s) and fixed nothing, and a whole vitest run alone at full
//     workers still failed scriptAlign (2041 ms), so the box has to be quiet, not just bigger.
// No retry anywhere: a red test is red.

/** Every test in the gate may take this long, tests and hooks alike. */
export const GATE_TEST_TIMEOUT_MS = 30_000

// Where vitest looks (vitest.config.ts `include`), so a file named here is a file vitest runs.
const TEST_DIRS = {
  src: /\.test\.tsx?$/,
  electron: /\.test\.ts$/,
  _verify: /\.test\.mjs$/,
  scripts: /\.test\.mjs$/,
}

// A test that reads a clock and asserts on it: the ratio helper (perfRatio.ts), or a difference of
// two clock reads. It over-matches on purpose (a file that only logs a time is run alone for
// nothing, which costs seconds) because missing one puts a flaky budget back in the busy lane.
// A line that is only a quoted string is skipped: a test that WRITES a script (lib.test.mjs) is
// not a test that reads the clock, and running it alone cost 12 s of every ship.
const CLOCK_ASSERT = /^(?![ \t]*[`'"]).*(?:\bbenchRatio\(|\bperfRatio\b|\b(?:performance\.now|Date\.now)\(\)\s*-\s*[A-Za-z_])/m

// Reads the clock but does not belong alone. Its 3 s limit is a hang check on a real ffmpeg, not a
// speed budget, and its one flake is the reverse of load: it asserts that a release has already
// settled the moment release returns, a race that fails when the box is quiet (2 of 12 runs of that
// file alone, 0 of 10 beside the other lanes). Alone it turned a gate red; in the lane it did not.
const STAYS_IN_THE_LANE = new Set(['electron/releaseStopsFfmpeg.test.ts'])

/**
 * The unit test files that assert on the clock, as repo relative paths with forward slashes,
 * sorted. Read from the files themselves, so a new timing test joins the list by being written.
 */
export function timedTestFiles(root = process.cwd()) {
  const found = []
  const walk = (dir, pattern) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(rel, pattern)
      } else if (pattern.test(e.name) && !STAYS_IN_THE_LANE.has(rel) && CLOCK_ASSERT.test(readFileSync(join(root, rel), 'utf8'))) {
        found.push(rel)
      }
    }
  }
  for (const [dir, pattern] of Object.entries(TEST_DIRS)) if (existsSync(join(root, dir))) walk(dir, pattern)
  return found.sort()
}

/**
 * The two vitest commands of the release gate: `main` is the whole suite but the clock files (it
 * is a lane, side by side with the typechecks, lint and the build), `alone` is just the clock
 * files (it runs after those lanes, on a quiet box), or null when there are none.
 */
export function unitTestPlan({ files = timedTestFiles() } = {}) {
  const limits = `--testTimeout=${GATE_TEST_TIMEOUT_MS} --hookTimeout=${GATE_TEST_TIMEOUT_MS}`
  const skip = files.map((f) => ` --exclude ${f}`).join('')
  return {
    main: `npx vitest run ${limits}${skip}`,
    alone: files.length ? `npx vitest run ${limits} ${files.join(' ')}` : null,
  }
}

/**
 * Run `fn` with `env[name]` set to `value`, then put it back exactly as it was (unset
 * stays unset), even when `fn` throws. A child started with `shell: true` inherits
 * process.env, so this is how one step gets a variable the steps around it must not.
 */
export async function withEnv(name, value, fn, env = process.env) {
  const had = name in env
  const before = env[name]
  env[name] = value
  try {
    return await fn()
  } finally {
    if (had) env[name] = before
    else delete env[name]
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

// --- THE VERSION BUMP IS BUILT FROM THE GATED MANIFESTS (2026-10-08) ----------------
//
// ⛔ THE BUMP READ package.json AND package-lock.json FROM DISK, AFTER THE GATE. The gate
// hashes the tree when it ends and refuses one that moved, but the bump runs after that
// check: it read the current version from disk, `npm version` rewrote both files on
// disk, and the release commit took both files from disk. A dependency added to
// package.json in that window (or between the stamp check and the bump of an
// already-verified tree) was committed and released with no check ever having seen it.
//
// So the bump refuses unless both files are, on disk, exactly what the gate checked,
// reads the version it bumps FROM THE GATED TREE, and after `npm version` has run it
// refuses again unless each file differs from the gated one in its version fields and
// nothing else.

/** The two files `npm version` rewrites, and the release commit takes from disk. */
export const MANIFESTS = ['package.json', 'package-lock.json']

/** A file as it is in `tree`, or null when the tree has none. */
function fileInTree(tree, path, cwd) {
  try {
    return execFileSync('git', ['show', `${tree}:${path}`], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

/** The version in the gated tree's package.json: the one a bump starts from, whatever is on disk now. */
export function versionInTree(tree, cwd = process.cwd()) {
  const text = fileInTree(tree, 'package.json', cwd)
  if (text === null) throw new Error(`the gated tree has no package.json`)
  const version = JSON.parse(text).version
  if (typeof version !== 'string') throw new Error('the gated tree has no version in its package.json')
  return version
}

/**
 * The manifests whose bytes on disk are not what the gated tree holds. Empty means the
 * bump may start. A manifest the tree has and the disk has lost is named too.
 */
export function manifestsMoved(gatedTree, cwd = process.cwd()) {
  const gone = MANIFESTS.filter((f) => fileInTree(gatedTree, f, cwd) !== null && !existsSync(join(cwd, f)))
  const changed = changedBetween(gatedTree, treeWith(gatedTree, MANIFESTS, cwd), cwd).filter((f) => MANIFESTS.includes(f))
  return [...new Set([...gone, ...changed])].sort()
}

/** JSON with its keys in a fixed order, so two spellings of one document compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The manifests that, after `npm version` ran, differ from the gated tree by more than
 * the version: a change nobody gated. Empty means the commit may take them from disk.
 */
export function manifestsBeyondVersion(gatedTree, version, cwd = process.cwd()) {
  const bad = []
  for (const f of MANIFESTS) {
    const gatedText = fileInTree(gatedTree, f, cwd)
    if (gatedText === null) continue
    try {
      const expected = JSON.parse(gatedText)
      expected.version = version
      if (f === 'package-lock.json' && expected.packages?.['']) expected.packages[''].version = version
      const onDisk = JSON.parse(readFileSync(join(cwd, f), 'utf8'))
      if (canonical(expected) !== canonical(onDisk)) bad.push(f)
    } catch {
      bad.push(f)
    }
  }
  return bad
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

/**
 * What makes the release NOT docs only, judged on `tree` and on nothing else.
 *
 * ⛔ THE TREE IS PASSED IN, NEVER HASHED HERE (2026-10-08). `--fast` used to hash the
 * tree for this check and the gate used to hash it again a moment later, so a code
 * file saved between the two was never looked at by the docs only check and then
 * became the gate's own baseline: it shipped marked "docs only". One hash is taken at
 * the start of the run; this check, the stamp check and the gate all read that one,
 * and the gate's check at its end covers all of them.
 *
 * With no tag to compare against, everything counts as unreleased.
 */
export function fastRefusal(lastTag, tree, cwd = process.cwd()) {
  return lastTag ? codeFiles(changedBetween(lastTag, tree, cwd)) : ['(no release tag to compare against)']
}

/**
 * Put the process in the state the gate runs in, for itself and every step it starts.
 *
 * OLP_GATE tells a spec it is inside the gate, where a missing prerequisite is a
 * failure and not a quiet skip.
 *
 * ⛔ OLP_MEASURE IS CLEARED (2026-10-08). It switches on the `measure` project, which
 * is scrub-cost on his own 1.38 GB project and took 3 to 10 minutes: not part of the
 * gate. Set in a PowerShell terminal it STAYS set for every later command in that
 * window, so a plain `npm run patch` there put scrub-cost back in the gate. The gate
 * answers for what it runs, whatever the shell it was started from still holds.
 *
 * ⛔ OLP_RELEASE IS CLEARED TOO (2026-10-12), for the same reason. It narrows the browser
 * suite to the release set (playwright.config.ts), and left over in a window it would
 * leave the FULL gate with no `smoke` or `ui` project to run. The release gate sets it
 * itself, for its one browser step, through `withEnv`.
 */
export function enterGate(env = process.env) {
  env.OLP_GATE = '1'
  delete env.OLP_MEASURE
  delete env.OLP_RELEASE
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
