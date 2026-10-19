// One command that turns whatever is in the working tree into a released patch.
//
//   npm run patch -- "fix(preview): stop the stutter at a cut"
//
// His ask, 2026-07-28: "could you make a system that just releases every single
// small patch without needing a whole update, so changes like this would not need
// me to say commit."
//
// The order matters and is not negotiable:
//   1. GATE first, on the real exit codes. Nothing is committed if anything is
//      red, because this publishes straight into an app that updates itself on
//      his machine. A broken patch is not a small patch.
//   2. Bump the patch version, commit everything, PUSH.
//   3. Build the installer and publish, which tags the pushed commit. Tagging
//      after the push is what keeps the tagged source equal to the shipped build;
//      doing it the other way round left two releases tagged one commit early.
//
// TWO GATES, since 2026-10-12. His words: "make a system for when we do release new
// updates. It doesn't take half as long. It doesn't even take a third of that long.
// Let's somehow make it so that when it does release, it's way, way, way faster, not
// just like how it used to be. Let's work around the rules so that we test less also".
// And on 2026-10-11, about the timing specs: "I don't give a fuck about the speed tests".
//
// Measured from the last gate log (2026-10-11), about 40 minutes start to finish:
//   the checks that need no browser, one after another   212 s
//     (typecheck renderer 22, typecheck electron 4, lint 28, unit tests 103,
//      web build 32, desktop build 23, self-contained 0)
//   the browser suite, every spec, 1 worker                about 26 min of tests, 38 with overhead
//   the release (rebuild, package, upload)                 157 s
// The target is about 7 minutes, and these are the three cuts:
//   * `npm run patch` runs the RELEASE gate: the checks that need no browser as four
//     lanes at once (runLanes in lib.mjs), the web build left out because
//     electron-vite build already compiles the same renderer, and a browser suite of
//     only boot, mvp and export (about 90 s, the `release` project in
//     playwright.config.ts, which retries a failed test once and reports the flaky ones).
//   * `npm run verify` (--verify) runs the FULL gate, as it always did: the lanes, then
//     the web build, then every spec except the speed tests (smoke, ui, one worker, no
//     retries), then the speed tests (timing) as a WARNING that blocks nothing.
//   * Only the full gate stamps. The stamp means every check passed, and a release gate
//     did not run every check. A tree stamped by verify still goes straight to
//     publishing in `npm run patch`, as before. See planShip in lib.mjs for why, measured.
//
// Skip the browser with --fast for a docs-only change. It still typechecks, lints and
// unit tests; it just does not drive a browser. It REFUSES a release that carries
// anything but Markdown or docs/ (see FAST_MARK in lib.mjs for the four feature
// releases it shipped untested), and the ones it allows say "E2E SKIPPED (--fast)" in
// the commit and on the GitHub release.
//
// A ship that died after its gate (a dropped push, a failed upload) picks up where it
// stopped, without gating again.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import {
  changedBetween,
  commitExactTree,
  enterGate,
  FAST_MARK,
  fastRefusal,
  flakyTests,
  gateLanes,
  isTransientFailure,
  keepEvidence,
  loadToken,
  manifestsBeyondVersion,
  manifestsMoved,
  mayBeLiveReport,
  nextVersion,
  openShipLog,
  planShip,
  recordFlaky,
  runLanes,
  runLogged,
  SHIP_LOG,
  treeHash,
  treeWith,
  unitTestPlan,
  versionInTree,
  withEnv,
} from './lib.mjs'

// His PC must never lag while a ship runs. Every check this script starts inherits this
// priority on Windows, so four lanes and a browser do not take the machine from him.
try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL)
} catch {
  // A priority that cannot be lowered is not a reason to stop a release.
}

const args = process.argv.slice(2)
const fast = args.includes('--fast')
const verifyOnly = args.includes('--verify')
// `npm run verify` is the FULL gate and `npm run patch` the RELEASE gate (see the header).
const fullGate = verifyOnly
// ⛔ EVERY FLAG COMES OUT OF THE MESSAGE. `--fast` was filtered and `--fix` was
// not when it was added, which would have put the word "--fix" in the middle of
// a release commit and in the GitHub release body.
const FLAGS = ['--fast', '--fix', '--verify']
const message = args.filter((a) => !FLAGS.includes(a)).join(' ').trim()

if (!message && !verifyOnly) {
  console.error('Usage: npm run patch -- "type(scope): what changed"   [--fast] [--fix]')
  console.error('  --fix  a small fix on top of the last release: 2.17.0 becomes 2.17.1 instead of 2.18.0')
  process.exit(2)
}

// Every step is shown live AND kept in the ship log, so a failure after a 25
// minute gate can always be read back. See runLogged in lib.mjs for the day
// that cost.
const shipLog = openShipLog(`ship: ${new Date().toISOString()}`)
const run = (cmd, label, opts) => runLogged(cmd, label, shipLog, opts)
// A plain line, on screen and in the ship log.
const tell = (say) => {
  process.stdout.write(say)
  shipLog?.write(say)
}

/**
 * ⛔ A RELEASE THAT MAY ALREADY BE LIVE (lib.mjs MAY_BE_LIVE) is not "did not publish",
 * and "run it again" is the one thing he must not do: a new run deletes it first.
 */
const stopIfMayBeLive = (version, e) => {
  const live = mayBeLiveReport(version, e.output)
  if (!live) return
  console.error('')
  for (const line of live) console.error(line)
  console.error(`   The whole run is in ${SHIP_LOG}`)
  process.exit(1)
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

// --- the stamp: which exact tree last passed the WHOLE gate ------------------
// `treeHash` (lib.mjs) is the tree of everything a commit would take, computed in
// a throwaway index so the real one is never touched. Same hash means same bytes,
// so the gate's answer still holds.
const STAMP = join(git('rev-parse', '--git-dir'), 'olp-verified.json')
const stampedTree = () => {
  try {
    return existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')).tree : ''
  } catch {
    return ''
  }
}
const writeStamp = (tree) => writeFileSync(STAMP, JSON.stringify({ tree, at: new Date().toISOString() }))

// ⛔ THE TREE IS HASHED ONCE, HERE (2026-10-08). `--fast` hashed it for its docs only
// check and the gate hashed it again a moment later, so a code file saved between the
// two was never seen by the docs only check and became the gate's own baseline: it
// shipped marked "docs only". The stamp check, the docs only check and the gate all read
// THIS one, and the gate's check at its end (below) covers all three. Nothing else in
// this file may hash the tree for a verdict at the start of a run.
const startTree = treeHash()

// The gate, in one place, for a ship and for --verify alike. There are two (see the header):
// `fullGate` (--verify) is every check, and the release gate (a plain ship) is the lanes and
// a browser suite of boot, mvp and export. Only a FULL gate without --fast stamps: the
// release gate and --fast both skipped something, so they proved less than a stamp promises.
//
// Returns the tree it checked, which is the ONLY tree a ship may commit.
//
// ⛔ AND THE TREE IS HASHED AGAIN WHEN IT ENDS. A file saved during the run was
// checked by none of the steps that had already finished, and by only part of the
// e2e (the dev server serves whatever is on disk), so a gate whose tree moved
// under it has no verdict on either tree. Nothing is committed or stamped, and the
// files are named.
const gate = async (tree) => {
  const t0 = Date.now()
  const fail = (why) => {
    const say = `\n❌ The gate failed (${why}), so NOTHING was committed or released.\n   The whole run is in ${SHIP_LOG}\n   Fix it and run the same command again.\n`
    console.error(say)
    shipLog?.write(say)
    process.exit(1)
  }
  // Tells a spec it is inside the gate, where a missing prerequisite (vendor/ffmpeg)
  // is a failure and not a quiet skip: the release cannot package without it. And clears
  // OLP_MEASURE, which a PowerShell window keeps for every later command and which would
  // put scrub-cost back in the gate (see enterGate in lib.mjs).
  enterGate()

  // 1. THE CHECKS THAT NEED NO BROWSER, as FOUR LANES AT ONCE (2026-10-12; they ran one
  // after another for 212 s). Four is his limit of heavy jobs at once, so his PC does not
  // lag, and this process runs below normal priority on top of that. Each lane is a line
  // of steps that depend on each other; the lanes share nothing:
  //   1. the renderer typecheck
  //   2. lint
  //   3. the unit tests (103 s alone, so this lane sets the time of the whole step), every
  //      test file but the ones that assert on the clock (see unitTestPlan in lib.mjs)
  //   4. the electron typecheck, then the desktop build, then the self-contained check
  // Every lane is waited for, then the first failing step in lane order names the failure.
  // Each lane's output is written as one block when it ends (see runLanes in lib.mjs).
  //
  // ⛔ 2026-10-12: THE FIRST REAL RELEASE GATE FAILED 4 OF 426 TEST FILES UNDER THESE LANES, on
  // 5 s timeouts and on clock budgets (timeline.test.ts, scriptAlign.test.ts). Every test now gets
  // 30 s in the gate, and the files that assert on the clock run alone in step 1b below, on a
  // quiet box. Measured in lib.mjs. No retry: a red test is red.
  //
  // ⛔ THE DESKTOP BUNDLE IS BUILT HERE NOW, not first after the push. The gate used
  // to build only the web bundle, so a main process bundling error, or a new
  // dependency main reaches for (what check-self-contained exists to catch), failed
  // in release.mjs after the version was already public. The release still rebuilds
  // after the bump, because the version is baked in.
  const units = unitTestPlan()
  const lanes = gateLanes(units)
  tell(`\n▶ the ${fullGate ? 'FULL' : 'RELEASE'} gate: ${lanes.length} lanes of checks at once, each one shown when it ends\n`)
  const checked = await runLanes(lanes, shipLog)
  // process.exit in fail() drops pending stream writes, so the red lane's block would be lost from the ship log.
  await new Promise((resolve) => (shipLog ? shipLog.write('', resolve) : resolve()))
  if (!checked.ok) fail(checked.failed)

  // 1b. THE UNIT TESTS THAT ASSERT ON THE CLOCK, ALONE (2026-10-12), now that the other lanes
  // are done and the box is quiet. About 12 s. They guard real slowdowns, so their budgets are
  // untouched; a busy box was the only thing that failed them.
  if (units.alone) {
    try {
      await run(units.alone, 'unit tests that assert on the clock, alone')
    } catch {
      // Same as the lanes: let the tail of its output reach the ship log before fail() exits.
      await new Promise((resolve) => (shipLog ? shipLog.write('', resolve) : resolve()))
      fail('unit tests that assert on the clock, alone')
    }
  }

  // The web build is in the FULL gate only. `electron-vite build` above already compiles
  // the same renderer, so in a release this would be a second build of the same code (32 s).
  if (fullGate) {
    try {
      await run('npx vite build', 'web build')
    } catch {
      fail('web build')
    }
  }

  // 2. THE BROWSER SUITE. A red one moves its traces out of test-results/ first,
  // because the next Playwright run anywhere in this repo empties that folder.
  const blockingBrowserRun = async (cmd, label, opts) => {
    try {
      await run(cmd, label, opts)
    } catch {
      // Flushed before it is copied, so the kept log ends where the run did.
      await new Promise((resolve) => (shipLog ? shipLog.write('\n[gate] the browser suite failed, keeping its evidence\n', resolve) : resolve()))
      const kept = keepEvidence({ from: 'test-results', extra: [SHIP_LOG] })
      if (kept) {
        const say = `\n   The failing tests' traces, videos and this log are kept in ${kept}\n   (open a trace with: npx playwright show-trace <that folder>/test-results/<test>/trace.zip)\n`
        console.error(say)
        shipLog?.write(say)
      }
      fail(label)
    }
  }
  if (!fast) {
    if (fullGate) {
      // Everything except the speed tests blocks, and nothing retries.
      await blockingBrowserRun('npx playwright test --project=smoke --project=ui', 'end to end')
      // ⛔ THE SPEED TESTS ONLY WARN (his word, 2026-10-11: "I don't give a fuck about the
      // speed tests"). They are wall clock and real time playback numbers, which a busy
      // box moves, and they cost most of the browser time. They still run, so a real
      // regression shows in the log, but a red one blocks nothing.
      try {
        await run('npx playwright test --project=timing', 'speed tests (a warning only)')
      } catch {
        tell('\n⚠ The speed tests failed. That no longer blocks anything (his word, 2026-10-11), so the gate carries on.\n')
      }
    } else {
      // The release set (playwright.config.ts): boot, mvp and export, a failed test retried
      // once. OLP_RELEASE is set for this one step and put back after (the child inherits
      // process.env).
      //
      // ⛔ A TEST THAT PASSES ON ITS SECOND TRY IS FLAKY, AND THAT MUST OUTLIVE THIS RUN. Playwright
      // names it in its summary, but only in last-ship.log, which the next ship overwrites. So
      // the output is read as it goes past, and a flaky one is named in a warning and kept in
      // gate-evidence (flakyTests and recordFlaky in lib.mjs). A warning only: it passed.
      const said = []
      let saidBytes = 0
      const keep = (stream) => ({
        write: (d) => {
          const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
          said.push(b)
          saidBytes += b.length
          // Bounded, the summary is at the end. Whole chunks only, so no character is cut.
          while (saidBytes > 256_000 && said.length > 1) saidBytes -= said.shift().length
          stream.write(d)
        },
      })
      const tee = { out: keep(process.stdout), err: keep(process.stderr) }
      await withEnv('OLP_RELEASE', '1', () => blockingBrowserRun('npx playwright test', 'end to end (release set)', tee))
      const flaky = flakyTests(Buffer.concat(said).toString('utf8'))
      if (flaky.count) {
        const kept = recordFlaky(flaky)
        tell(
          `\n⚠ ${flaky.count} release test${flaky.count === 1 ? '' : 's'} failed once and passed on the retry (flaky). That blocks nothing; it is named so it can be found and fixed:\n` +
            flaky.names.map((n) => `   ${n}\n`).join('') +
            (kept ? `   Kept in ${kept}\n` : ''),
        )
      }
    }
  }

  const after = treeHash()
  if (after !== tree) {
    const moved = changedBetween(tree, after)
    const say =
      '\n❌ Files changed while the gate ran, so its verdict covers neither version. NOTHING was committed, released or stamped.\n' +
      moved.map((f) => `   ${f}\n`).join('') +
      '   Let whatever is writing them finish, then run the same command again.\n'
    console.error(say)
    shipLog?.write(say)
    process.exit(1)
  }
  const done = `\n✓ the ${fullGate ? 'full' : 'release'} gate passed in ${((Date.now() - t0) / 60_000).toFixed(1)} min\n`
  process.stdout.write(done)
  shipLog?.write(done)
  // Only the full gate, with its browser suite, proves what a stamp promises.
  if (fullGate && !fast) writeStamp(tree)
  return tree
}

if (verifyOnly) {
  await gate(startTree)
  console.log(
    `\n✅ Verified${fast ? ' without the browser suite, so nothing was stamped' : ': this exact code passed the full gate (the speed tests only warn), and a ship of it goes straight to publishing'}.`,
  )
  process.exit(0)
}

// The push used to be a bare `git push`, which hands the job to Git Credential
// Manager. On 2026-08-12 that died with "could not read Username for
// 'https://github.com'" after a gate that had taken 25 minutes to go green, so a
// finished release sat committed and undelivered for two days. The token that
// publishes the release was on disk the whole time.
//
// Push with that same token. It goes in through a credential helper that reads
// it from the environment, so it never reaches the command line, the terminal
// output or .git/config.
//
// ⛔ AND IT RETRIES A DROPPED CONNECTION, since 2026-08-17. That night the push died
// on `socket hang up` after a gate that had taken nine minutes to go green, and
// `socket hang up` is the FIRST signature in `isTransientFailure`. The retry that
// knows it has wrapped the package step since it was written and never wrapped this
// one, so the version was bumped, the commit was made, nothing reached the remote
// and nothing was released. **Exactly the scar the paragraph above describes, one
// step earlier in the same failure.**
//
// ⛔ STDERR IS CAPTURED RATHER THAN INHERITED, because it has to be READ to be
// classified: with `stdio: 'inherit'` git's own words go to the terminal and the
// error object carries none of them, so nothing can tell a dead network from a
// rejected push. It is echoed straight back out, so he sees exactly what he saw
// before.
const pushOnce = (token) => {
  const opts = { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8' }
  if (!token) {
    execSync('git push origin main', opts)
    return
  }
  execFileSync(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!f() { echo username=x-access-token; echo "password=$OLP_PUSH_TOKEN"; }; f',
      'push',
      'origin',
      'main',
    ],
    { ...opts, env: { ...process.env, OLP_PUSH_TOKEN: token } },
  )
}

const pushMain = async () => {
  const token = loadToken()
  process.stdout.write('\n▶ push\n')
  for (let attempt = 1; ; attempt++) {
    try {
      pushOnce(token)
      return
    } catch (e) {
      // Everything git said, whichever field it landed in.
      const said = `${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`
      process.stderr.write(said.endsWith('\n') ? said : `${said}\n`)
      if (attempt >= 3 || !isTransientFailure(said)) throw e
      const waitMs = 15_000 * attempt
      process.stdout.write(
        `\n⚠ push failed on what looks like a dropped connection, not a rejected push.\n  Waiting ${Math.round(waitMs / 1000)}s, then try ${attempt + 1} of 3.\n`,
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

// --- 0. nothing to do? ------------------------------------------------------
// ⛔ "Clean and pushed" is NOT "released". See releaseWork in lib.mjs for the
// day five finished commits could not be published by this script at all.
const lastTag = (() => {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*')
  } catch {
    return '' // no release has ever been tagged, so everything is unreleased
  }
})()
const dirty = git('status', '--porcelain')
const unpushed = git('rev-list', '--count', 'origin/main..HEAD')
const unreleased = lastTag ? git('rev-list', '--count', `${lastTag}..HEAD`) : '1'
const shippedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
// Only this script writes that line, and only after a gate passed.
const headIsRelease = git('log', '-1', '--format=%B').includes(`Released as v${shippedVersion} by scripts/patch.mjs`)
const verified = !!(dirty && dirty.trim()) && stampedTree() === startTree

const plan = planShip({ dirty, unpushed, unreleased, headIsRelease, verified })
if (!plan) {
  console.log(`Nothing to release: the tree is clean and ${lastTag} is HEAD.`)
  process.exit(0)
}
console.log(`Releasing, because there is ${plan.why}.`)

// The commit the release goes on top of, taken BEFORE the gate. If the branch
// moves while the gate runs, the commit below refuses rather than land the gated
// tree over somebody else's work.
const headAtStart = git('rev-parse', 'HEAD')

// --- 0b. --fast keeps its own contract ---------------------------------------
// Only when it would actually skip something: a verified tree already passed the
// browser suite, and a stranded release commit is not gated at all.
const skippingE2e = fast && plan.gate
if (skippingE2e) {
  const code = fastRefusal(lastTag, startTree)
  if (code.length) {
    console.error(`\n❌ --fast is for a docs only release, and this one changes code since ${lastTag || 'the start'}:`)
    for (const f of code.slice(0, 40)) console.error(`   ${f}`)
    if (code.length > 40) console.error(`   ... and ${code.length - 40} more`)
    console.error('   Run it without --fast, so the browser suite checks it. Nothing was committed or released.')
    process.exit(2)
  }
  console.log(`\n⚠ ${FAST_MARK}: docs only, so the browser suite is not run. The commit and the GitHub release will say so.`)
}

// --- 1. the gate ------------------------------------------------------------
let gatedTree = ''
if (plan.gate) gatedTree = await gate(startTree)
else if (plan.bump) {
  // `verified` above means the tree on disk matched this stamp a moment ago.
  // The commit is built from the STAMPED tree, so a save since then stays out.
  gatedTree = stampedTree()
  console.log('\n✓ This exact code already passed every check (npm run verify), so the gate is not run twice.')
} else console.log(`\n✓ v${shippedVersion} already passed its gate and was committed. Picking up where it stopped.`)

if (!plan.bump) {
  if (plan.push) await pushMain()
  try {
    await run('node scripts/release.mjs', `release v${shippedVersion}`)
  } catch (e) {
    stopIfMayBeLive(shippedVersion, e)
    console.error(`\n❌ v${shippedVersion} is committed and PUSHED, but the build did not publish.`)
    console.error(`   ${e.message}`)
    console.error('   Run the same command again: it will only publish.')
    process.exit(1)
  }
  console.log(`\n✅ v${shippedVersion} is out. His app picks it up on the next launch.`)
  process.exit(0)
}

// --- 2. bump, commit, push --------------------------------------------------
//
// ⛔ MINOR BY DEFAULT, NOT PATCH, AND THE NAME OF THIS SCRIPT IS A RED HERRING.
// His numbering, 2026-08-19, looking at v2.0.17: *"let's change the format of
// this to 2.17 and when we do smaller updates, more like patch fixes, let's
// make it 2.17.1 and so on when we do a bigger update, let's turn it into
// 2.18."*
//
// So the ORDINARY ship, which is what this script is, moves the middle number:
// 2.17.0 becomes 2.18.0 and he reads it as "2.18". A small fix on top of one
// takes `--fix` and moves the last number instead: 2.17.1, which he reads whole
// because a third number only appears when it means something.
//
// The trailing `.0` is trimmed for HIM by `displayVersion` and never anywhere a
// machine reads. The tag, the installer filename and the update feed stay true
// three part semver, because electron-updater COMPARES those strings.
//
// And the middle number stops at 39. His rule, 2026-09-14: 2.39 is followed by
// 3.0, never 2.40, and 3.39 by 4.0. `nextVersion` in lib.mjs is the one place
// that knows it, and `isBigUpdate` asks the same function, so the rollover
// ships as the ordinary release it is rather than as a "big" one that opens a
// window on his screen.
const bump = process.argv.includes('--fix') ? 'fix' : 'minor'

// ⛔ THE BUMP STARTS FROM THE GATED MANIFESTS, NOT FROM DISK (2026-10-08). The gate's
// check at its end is behind us, and `npm version` rewrites package.json and
// package-lock.json on disk, which the release commit then takes. A dependency added in
// this window went out with nothing ever having checked it. So the two files must be, on
// disk, what the gate checked; the version comes out of the gated tree; and after the
// bump each file may differ from the gated one in its version and nothing else.
const refuse = (say) => {
  console.error(say)
  shipLog?.write(say)
  process.exit(1)
}
const moved = manifestsMoved(gatedTree)
if (moved.length) {
  refuse(
    '\n❌ package.json or package-lock.json changed after the gate checked them, so the version was NOT bumped and nothing was committed or released.\n' +
      moved.map((f) => `   ${f}\n`).join('') +
      '   Let whatever is writing them finish, then run the same command again.\n',
  )
}
const current = versionInTree(gatedTree)
const version = nextVersion(current, bump)
await run(`npm version ${version} --no-git-tag-version`, `version bump (${bump}): ${current} to ${version}`)
const beyond = manifestsBeyondVersion(gatedTree, version)
if (beyond.length) {
  refuse(
    `\n❌ ${beyond.join(' and ')} changed by more than the version while it was bumped, so NOTHING was committed or released.\n` +
      `   The bump to ${version} is on disk and uncommitted. Let whatever is writing them finish, check the diff, then run the same command again.\n`,
  )
}

// ⛔ THE COMMIT IS THE GATED TREE PLUS THE BUMP, BY CONSTRUCTION. It used to be
// `git add -A`, which took whatever was on disk at this moment, gated or not.
// Anything saved after the gate stays an ordinary uncommitted change.
const releaseTree = treeWith(gatedTree, ['package.json', 'package-lock.json'])
const body = [
  `Released as v${version} by scripts/patch.mjs.`,
  ...(skippingE2e ? [`${FAST_MARK}: docs only, so the browser suite did not run on this release.`] : []),
  'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
]
const commit = commitExactTree(releaseTree, `${message}\n\n${body.join('\n\n')}\n`, { parent: headAtStart })
console.log(`\n✓ committed ${commit.slice(0, 7)}: exactly the tree the gate checked, plus the version bump`)
const leftOut = git('status', '--porcelain')
if (leftOut) console.log(`  Saved after the gate, so NOT in this release (still uncommitted):\n${leftOut}`)
await pushMain()

// --- 3. build + publish -----------------------------------------------------
// Past this line the commit is already PUSHED, so a failure here leaves the
// version bumped and public with no release behind it. That happened on
// 2026-08-12. The repair is `npm run release` on its own, and the log says why.
try {
  await run('node scripts/release.mjs', `release v${version}`)
} catch (e) {
  stopIfMayBeLive(version, e)
  console.error(`\n❌ v${version} is committed and PUSHED, but the build did not publish.`)
  console.error(`   ${e.message}`)
  console.error(`   The whole run is in ${SHIP_LOG}`)
  console.error('   Repair: cd into the repo and run `npm run release`. Nothing else is needed.')
  process.exit(1)
}

console.log(`\n✅ v${version} is out. His app picks it up on the next launch.`)
