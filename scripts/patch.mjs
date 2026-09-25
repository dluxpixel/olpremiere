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
// Skip the slow half with --fast for a docs-only or comment-only change. It still
// typechecks, lints and unit tests; it just does not drive a browser.
//
// `npm run verify` (--verify) runs the gate alone and stamps the tree it passed
// on. A ship of that exact tree then skips straight to publishing, and a ship
// that died after its gate (a dropped push, a failed upload) picks up where it
// stopped. See planShip in lib.mjs for why, measured.

import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTransientFailure, loadToken, nextVersion, openShipLog, planShip, runLogged, SHIP_LOG } from './lib.mjs'

const args = process.argv.slice(2)
const fast = args.includes('--fast')
const verifyOnly = args.includes('--verify')
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
const run = (cmd, label) => runLogged(cmd, label, shipLog)

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

// --- the stamp: which exact tree last passed the WHOLE gate ------------------
// The tree hash of everything a commit would take (tracked and new files, the
// ignore list honoured), computed in a throwaway index so the real one is never
// touched. Same hash means same bytes, so the gate's answer still holds.
const STAMP = join(git('rev-parse', '--git-dir'), 'olp-verified.json')
const treeHash = () => {
  const index = join(tmpdir(), `olp-verify-index-${process.pid}`)
  try {
    copyFileSync(join(git('rev-parse', '--git-dir'), 'index'), index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    execFileSync('git', ['add', '-A'], { env, stdio: 'ignore' })
    return execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim()
  } finally {
    rmSync(index, { force: true })
  }
}
const stampedTree = () => {
  try {
    return existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')).tree : ''
  } catch {
    return ''
  }
}
const writeStamp = (tree) => writeFileSync(STAMP, JSON.stringify({ tree, at: new Date().toISOString() }))

// The gate, in one place, for a ship and for --verify alike. Only a FULL gate
// stamps: --fast skipped the browser, so it proved less than a stamp promises.
const gate = async () => {
  const tree = treeHash()
  try {
    await run('npx tsc --noEmit', 'typecheck (renderer)')
    await run('npx tsc -p tsconfig.electron.json --noEmit', 'typecheck (electron)')
    await run('npx eslint .', 'lint')
    await run('npx vitest run', 'unit tests')
    await run('npx vite build', 'web build')
    if (!fast) await run('npx playwright test', 'end to end')
  } catch {
    console.error('\n❌ The gate failed, so NOTHING was committed or released.')
    console.error(`   The whole run is in ${SHIP_LOG}`)
    console.error('   Fix it and run the same command again.')
    process.exit(1)
  }
  if (!fast) writeStamp(tree)
}

if (verifyOnly) {
  await gate()
  console.log(`\n✅ Verified${fast ? ' without the browser suite, so nothing was stamped' : ': this exact code passed every check, and a ship of it goes straight to publishing'}.`)
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
const verified = !!(dirty && dirty.trim()) && stampedTree() === treeHash()

const plan = planShip({ dirty, unpushed, unreleased, headIsRelease, verified })
if (!plan) {
  console.log(`Nothing to release: the tree is clean and ${lastTag} is HEAD.`)
  process.exit(0)
}
console.log(`Releasing, because there is ${plan.why}.`)

// --- 1. the gate ------------------------------------------------------------
if (plan.gate) await gate()
else if (plan.bump) console.log('\n✓ This exact code already passed every check (npm run verify), so the gate is not run twice.')
else console.log(`\n✓ v${shippedVersion} already passed its gate and was committed. Picking up where it stopped.`)

if (!plan.bump) {
  if (plan.push) await pushMain()
  try {
    await run('node scripts/release.mjs', `release v${shippedVersion}`)
  } catch (e) {
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
const current = JSON.parse(readFileSync('package.json', 'utf8')).version
const version = nextVersion(current, bump)
await run(`npm version ${version} --no-git-tag-version`, `version bump (${bump}): ${current} to ${version}`)

execFileSync('git', ['add', '-A'], { stdio: 'inherit' })
execFileSync('git', ['commit', '-m', `${message}\n\nReleased as v${version} by scripts/patch.mjs.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`], {
  stdio: 'inherit',
})
await pushMain()

// --- 3. build + publish -----------------------------------------------------
// Past this line the commit is already PUSHED, so a failure here leaves the
// version bumped and public with no release behind it. That happened on
// 2026-08-12. The repair is `npm run release` on its own, and the log says why.
try {
  await run('node scripts/release.mjs', `release v${version}`)
} catch (e) {
  console.error(`\n❌ v${version} is committed and PUSHED, but the build did not publish.`)
  console.error(`   ${e.message}`)
  console.error(`   The whole run is in ${SHIP_LOG}`)
  console.error('   Repair: cd into the repo and run `npm run release`. Nothing else is needed.')
  process.exit(1)
}

console.log(`\n✅ v${version} is out. His app picks it up on the next launch.`)
