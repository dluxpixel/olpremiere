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

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const fast = args.includes('--fast')
const message = args.filter((a) => a !== '--fast').join(' ').trim()

if (!message) {
  console.error('Usage: npm run patch -- "type(scope): what changed"   [--fast]')
  process.exit(2)
}

const run = (cmd, label) => {
  process.stdout.write(`\n▶ ${label}\n`)
  execSync(cmd, { stdio: 'inherit' })
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

// --- 0. nothing to do? ------------------------------------------------------
const dirty = git('status', '--porcelain')
const unpushed = git('rev-list', '--count', 'origin/main..HEAD')
if (!dirty && unpushed === '0') {
  console.log('Nothing to release: the tree is clean and main is already pushed.')
  process.exit(0)
}

// --- 1. the gate ------------------------------------------------------------
try {
  run('npx tsc --noEmit', 'typecheck (renderer)')
  run('npx tsc -p tsconfig.electron.json --noEmit', 'typecheck (electron)')
  run('npx eslint .', 'lint')
  run('npx vitest run', 'unit tests')
  run('npx vite build', 'web build')
  if (!fast) run('npx playwright test', 'end to end')
} catch {
  console.error('\n❌ The gate failed, so NOTHING was committed or released.')
  console.error('   Fix it and run the same command again.')
  process.exit(1)
}

// --- 2. bump, commit, push --------------------------------------------------
run('npm version patch --no-git-tag-version', 'version bump')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

execFileSync('git', ['add', '-A'], { stdio: 'inherit' })
execFileSync('git', ['commit', '-m', `${message}\n\nReleased as v${version} by scripts/patch.mjs.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`], {
  stdio: 'inherit',
})
run('git push origin main', 'push')

// --- 3. build + publish -----------------------------------------------------
run('node scripts/release.mjs', `release v${version}`)

console.log(`\n✅ v${version} is out. His app picks it up on the next launch.`)
