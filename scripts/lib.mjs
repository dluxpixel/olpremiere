// Shared release helpers.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
export function runLogged(cmd, label, log) {
  return new Promise((resolve, reject) => {
    const banner = `\n▶ ${label}\n`
    process.stdout.write(banner)
    log?.write(banner)
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
      process.stdout.write(d)
      log?.write(d)
      keep(d)
    })
    child.stderr.on('data', (d) => {
      process.stderr.write(d)
      log?.write(d)
      keep(d)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const err = new Error(`${label} exited ${code}`)
        err.output = tail
        reject(err)
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
export async function runLoggedRetry(cmd, label, log, { tries = 3, baseDelayMs = 15_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runLogged(cmd, attempt === 1 ? label : `${label}, try ${attempt} of ${tries}`, log)
    } catch (e) {
      if (attempt >= tries || !isTransientFailure(e.output)) throw e
      const waitMs = baseDelayMs * attempt
      const msg = `\n⚠ ${label} failed on what looks like a dropped connection, not a broken build.\n  Waiting ${Math.round(waitMs / 1000)}s, then try ${attempt + 1} of ${tries}.\n`
      process.stdout.write(msg)
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
